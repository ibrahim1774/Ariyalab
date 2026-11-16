import { randomBytes } from 'node:crypto';
import { parse as parseCookies } from 'cookie';
import {
  stripe,
  getOrCreatePrice,
  getOrCreateTopupPrice,
  getOrCreateV2Price,
  planFromPrice,
  PLANS,
  TOPUPS,
  V2_PLAN_NAMES,
  V2_PACKS,
} from '../../lib/stripe';
import { isBillingV2Strict } from '../../lib/billingFlags';
import { getPricing, v2Offers } from '../../lib/pricing';
import { getUserFromRequest, getSupabaseAdmin } from '../../lib/supabaseServer';
import { sendCapiEvent } from '../../lib/meta';
import { nsEventId } from '../../lib/metaKeys';
import { linkStripeCustomerToProfile, CustomerLinkedElsewhereError } from '../../lib/entitlement';
import { CLAIM_NONCE_COOKIE, hashClaimTicket, usersForCustomer } from '../../lib/grants';
import { signClaimNonces, verifyClaimNonces } from '../../lib/jobToken';

// Session metadata keys only the server sets; never taken from the
// attribution cookie (ownership and claims read them).
const RESERVED_METADATA = new Set(['supabase_user_id', 'pending_supabase_link', 'claim_ticket']);

// The origin to send the buyer back to. Stays on the host the buyer is on
// when it is APP_URL's host or its www/apex twin, so host-only cookies (the
// claim ticket, the auth session) are there when Stripe redirects back.
function buyerOrigin(req) {
  const app = process.env.APP_URL && process.env.APP_URL.replace(/\/$/, '');
  const reqHost = String(req.headers?.host || '').toLowerCase();
  if (app) {
    try {
      const u = new URL(app);
      const bare = (h) => h.replace(/^www\./, '');
      if (reqHost && bare(reqHost) === bare(u.host.toLowerCase())) return `${u.protocol}//${reqHost}`;
    } catch {
      /* fall through to APP_URL */
    }
    return app;
  }
  return (req.headers.origin && req.headers.origin.replace(/\/$/, '')) || `https://${req.headers.host}`;
}

// Adds a Set-Cookie header without dropping one already set on `res`.
function appendCookie(res, cookie) {
  const prev = res.getHeader?.('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [String(prev)]) : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

/*
 * Find an existing Stripe customer for this Supabase user. Returns
 * the customer id, or null if none found. Never creates.
 *
 * Three lookups, in order:
 *   1. profiles.stripe_customer_id (authoritative link). If the
 *      stored ID exists in Stripe and isn't deleted, reuse it.
 *   2. Stripe Customer Search by metadata.supabase_user_id.
 *   3. Stripe customers.list by email.
 *
 * A customer found by search or email is only adopted when no other
 * user owns it: no other profile is linked to it and its
 * metadata.supabase_user_id is empty or this user. An email match alone
 * proves nothing (anyone can pay with someone else's email), so there is
 * no "first customer with this email" fallback, and a customer whose link
 * is refused is not reused. With nothing adoptable we return null and
 * Stripe Checkout creates a fresh customer at payment completion. We never
 * call customers.create on click.
 *
 * If a match is found, we idempotently stamp supabase_user_id on
 * its metadata and upsert profile.stripe_customer_id so subsequent
 * calls converge on the same customer.
 */
// A lookup failed, so we cannot tell whether this user already has a Stripe
// customer. Never fall through to creating a second one: the buyer retries.
class CustomerLookupUnavailableError extends Error {
  constructor(step, cause) {
    super(`customer lookup unavailable (${step})`);
    this.name = 'CustomerLookupUnavailableError';
    this.cause = cause;
  }
}

async function findStripeCustomerForUser({ admin, userId, email }) {
  let customerId = null;

  // 1) Profile lookup + Stripe existence check. supabase-js reports errors
  // in `error` rather than throwing.
  let linkedId = null;
  try {
    const { data, error } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    linkedId = data?.stripe_customer_id || null;
  } catch (lookupErr) {
    throw new CustomerLookupUnavailableError('profile', lookupErr);
  }
  if (linkedId) {
    try {
      const c = await stripe().customers.retrieve(linkedId);
      if (c && !c.deleted) customerId = c.id;
    } catch (retrieveErr) {
      // Only a customer that is really gone is re-resolved; a transient
      // Stripe error must not start a second customer for this user.
      if (retrieveErr?.code !== 'resource_missing') throw new CustomerLookupUnavailableError('customer', retrieveErr);
      console.warn('[customer-find] linked customer not in Stripe, will re-resolve');
    }
  }
  if (customerId) return customerId;

  const adoptable = async (c) => {
    if (!c || c.deleted) return false;
    const owner = c.metadata?.supabase_user_id;
    if (owner && owner !== userId) return false;
    const linked = await usersForCustomer(c.id);
    return linked.every((id) => id === userId);
  };

  // 2) Stripe Customer Search by metadata.supabase_user_id
  try {
    const search = await stripe().customers.search({
      query: `metadata['supabase_user_id']:'${userId}'`,
      limit: 1,
    });
    if (search.data.length > 0 && (await adoptable(search.data[0]))) customerId = search.data[0].id;
  } catch (searchErr) {
    throw new CustomerLookupUnavailableError('search', searchErr);
  }

  // 3) Email match: only a customer this user already owns, or one nobody owns.
  if (!customerId && email) {
    try {
      const list = await stripe().customers.list({ email, limit: 100 });
      const ordered = [
        ...list.data.filter((c) => c.metadata?.supabase_user_id === userId),
        ...list.data.filter((c) => !c.metadata?.supabase_user_id),
      ];
      for (const c of ordered) {
        if (await adoptable(c)) {
          customerId = c.id;
          break;
        }
      }
    } catch (listErr) {
      throw new CustomerLookupUnavailableError('email', listErr);
    }
  }

  if (!customerId) return null;

  // Authoritative link in our profiles table. A refused link means this
  // customer belongs elsewhere: do not use it.
  try {
    await linkStripeCustomerToProfile(admin, userId, customerId, { via: 'server' });
  } catch (linkErr) {
    if (linkErr instanceof CustomerLinkedElsewhereError) {
      console.warn('[customer-find] not adopting customer', customerId, linkErr.message);
      return null;
    }
    console.warn(
      '[customer-find] profile link failed — search/email fallback will still find this customer next time',
      linkErr.message
    );
  }

  // Idempotently stamp supabase_user_id on the customer's metadata.
  try {
    const customerNow = await stripe().customers.retrieve(customerId);
    const md = customerNow && !customerNow.deleted ? customerNow.metadata || {} : {};
    if (md.supabase_user_id !== userId) {
      await stripe().customers.update(customerId, {
        metadata: { ...md, supabase_user_id: userId },
      });
    }
  } catch (mdErr) {
    console.warn('[customer-find] metadata sync failed', mdErr.message);
  }

  return customerId;
}

/** True when the customer has an active or trialing subscription to one of this app's prices. */
async function hasOurSubscription(customerId) {
  for (const status of ['active', 'trialing', 'past_due']) {
    const list = await stripe().subscriptions.list({ customer: customerId, status, limit: 20, expand: ['data.items.data.price'] });
    if ((list?.data || []).some((sub) => planFromPrice(sub.items?.data?.[0]?.price))) return true;
  }
  return false;
}

/*
 * Ad attribution for /tracking: lib/adAttribution.js persists the ad-click
 * params (utm_* / fbclid / …) in the `al_attr` cookie (last touch) and
 * `al_attr_f` (first touch, stamped with an fc_ prefix). Merging them into
 * the Checkout Session metadata makes completed sessions the conversion
 * log — no extra database. Keys/values are sanitized and capped well under
 * Stripe's 50-key metadata limit.
 */
function adAttrFromRequest(req) {
  const out = {};
  const cookies = parseCookies(req.headers?.cookie || '');
  const readSet = (cookieName, prefix) => {
    try {
      const raw = cookies[cookieName];
      if (!raw) return;
      const parsed = JSON.parse(decodeURIComponent(raw));
      let added = 0;
      for (const [k, v] of Object.entries(parsed)) {
        if (added >= 15) break;
        if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
        if (RESERVED_METADATA.has(k) || RESERVED_METADATA.has(prefix + k)) continue;
        if (typeof v !== 'string' || !v) continue;
        out[prefix + k] = v.slice(0, 480);
        added += 1;
      }
    } catch { /* attribution is best-effort */ }
  };
  readSet('al_attr', '');
  readSet('al_attr_f', 'fc_');
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adAttr = adAttrFromRequest(req);

  // Subscription path supports anonymous users (pay first, sign up
  // after). Top-up requires auth because credits attach to an
  // existing account.
  const session = await getUserFromRequest(req, res);
  const isAnon = !session;
  const email = session?.user?.email;

  const { plan, mode, pack, returnTo, surface } = req.body || {};

  if (mode === 'topup' && isAnon) {
    return res.status(401).json({ error: 'Sign in required to buy a top-up.' });
  }

  // What is on sale depends on billing_v2, read strictly: with the flag
  // unreadable nothing is sold (never the wrong plan at the wrong price).
  let v2;
  let offers = null;
  try {
    v2 = await isBillingV2Strict();
    if (v2) offers = v2Offers(await getPricing());
  } catch (flagErr) {
    console.error('[checkout] billing flag unavailable', flagErr?.message);
    return res.status(503).json({ error: 'Please try again.' });
  }

  const origin = buyerOrigin(req);

  // Optional: where to send the user after dashboard finishes
  // confirming the Stripe session. Validated to be a same-origin
  // path so the redirect can never escape to an external URL.
  const safeReturnTo =
    typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
      ? returnTo
      : '';
  const returnQuery = safeReturnTo ? `&returnTo=${encodeURIComponent(safeReturnTo)}` : '';

  try {
    if (mode === 'topup') {
      // Billing v2 sells its own video packs (s/m/l at the configured
      // price); image packs stay the legacy ones.
      const v2Pack = v2 && V2_PACKS.includes(pack) ? offers.topups[pack] : null;
      // s/m/l name the legacy packs too: a page that drew the legacy prices (offers not loaded,
      // or loaded before the flip) must not buy a v2 pack at another price.
      if (v2Pack && req.body?.catalog !== 'v2') {
        return res.status(409).json({ error: 'Prices have changed. Reload the page and try again.', code: 'RELOAD' });
      }
      const legacyPack = typeof pack === 'string' && Object.hasOwn(TOPUPS, pack) ? TOPUPS[pack] : null;
      if (!v2Pack && (!legacyPack || (v2 && legacyPack.kind === 'video'))) {
        return res.status(400).json({ error: 'Invalid top-up pack.' });
      }
      const price = v2Pack
        ? await getOrCreateV2Price({ kind: 'topup', pack, amountCents: v2Pack.cents, credits: v2Pack.credits })
        : await getOrCreateTopupPrice(pack);

      // Find an existing Stripe customer (never create on click).
      // If none exists, Stripe Checkout creates one at payment
      // completion via customer_creation: 'always' — we need a
      // customer attached so the credit ledger (stored in customer
      // metadata) has somewhere to land.
      const admin = getSupabaseAdmin();
      const customerId = await findStripeCustomerForUser({
        admin,
        userId: session.user.id,
        email,
      });

      const checkout = await stripe().checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{ price: price.id, quantity: 1 }],
        ...(customerId
          ? { customer: customerId }
          : { customer_creation: 'always' }),
        success_url: `${origin}/dashboard?paid=1&session_id={CHECKOUT_SESSION_ID}${returnQuery}`,
        cancel_url: `${origin}/dashboard?paid=0`,
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        // Ties the session to the buyer: /confirm only binds it to this user.
        client_reference_id: session.user.id,
        metadata: { ...adAttr, supabase_user_id: session.user.id },
      });
      const value = (v2Pack ? v2Pack.cents : TOPUPS[pack].amountCents) / 100;
      const eventId = nsEventId(`ic-${checkout.id}`);
      sendCapiEvent({
        eventName: 'InitiateCheckout',
        eventId,
        value,
        currency: 'USD',
        email,
        req,
        customData: {
          kind: 'topup',
          pack,
          supabase_user_id: session.user.id,
        },
      }).catch(() => {});
      return res.status(200).json({
        url: checkout.url,
        meta: { eventName: 'InitiateCheckout', eventId, value, currency: 'USD' },
      });
    }

    const interval = req.body?.interval === 'year' ? 'year' : 'month';
    if (v2 ? !V2_PLAN_NAMES.includes(plan) : plan !== 'monthly' && plan !== 'pro' && plan !== 'yearly') {
      return res.status(400).json({
        error: v2
          ? "Expected { plan: 'starter'|'creator'|'studio', interval?: 'month'|'year' } or { mode: 'topup', pack: 's'|'m'|'l' }."
          : "Expected { plan: 'monthly'|'pro'|'yearly' } or { mode: 'topup', pack: 's'|'m'|'l' }.",
      });
    }
    const v2Plan = v2 ? offers.plans[plan] : null;
    // Anonymous v2 plans are sold on the pay-first flows; the one-plan rule is
    // enforced when the purchase is claimed (lib/planGuard.js). Signed-in
    // buyers are checked below (HAS_PLAN).
    const planCents = v2Plan ? (interval === 'year' ? v2Plan.yearlyCents : v2Plan.monthlyCents) : null;

    // Anonymous subscription: route success_url through the claim-
    // and-create-account flow on /sign-up. The user signs up with
    // the same email Stripe collected; backend then links the
    // Stripe customer to the new Supabase user.
    //
    // Exception — anonymous subscriptions originating from one of the
    // ticket-flow surfaces below use the leak-protected ticket flow:
    // route to /ugc-2/claim, which moves the session_id into an
    // httpOnly cookie and strips it from the URL before any pixel or
    // referrer can see it, then lets the user sign up with ANY email.
    // Every other anonymous subscription keeps the existing /sign-up
    // email-match claim flow untouched.
    //
    // `r` (URL-encoded, validated same-origin) tells the welcome page
    // where to redirect the user after signup so the funnel they came
    // from is honored (e.g. /local-business/pricing-plan -> back to
    // /local-business once subscribed).
    const TICKET_FLOW_RETURNS = new Set([
      '/ugc-2',
      '/local-business',
      '/local-business/pricing-plan',
      '/real-estate',
      '/real-estate/pricing-plan',
    ]);
    const isTicketFlow = isAnon && TICKET_FLOW_RETURNS.has(safeReturnTo);
    // For ticket flows we always send the user back to a canonical
    // post-subscribe destination (not the pricing page they paid on).
    const ticketReturnDest = safeReturnTo.startsWith('/local-business')
      ? '/local-business'
      : safeReturnTo.startsWith('/real-estate')
        ? '/real-estate'
        : '/ugc-2';
    const ticketReturnQuery = `&r=${encodeURIComponent(ticketReturnDest)}`;
    const successPath = isTicketFlow
      ? `/ugc-2/claim?session_id={CHECKOUT_SESSION_ID}${ticketReturnQuery}`
      : isAnon
        ? `/sign-up?session_id={CHECKOUT_SESSION_ID}${returnQuery}`
        : `/dashboard?paid=1&session_id={CHECKOUT_SESSION_ID}${returnQuery}`;

    const subMetadata = isAnon
      ? { pending_supabase_link: 'true' }
      : { supabase_user_id: session.user.id };

    // Pay-first ticket flow: every checkout gets a FRESH random nonce; only
    // its hash rides on the session. The httpOnly cookie keeps a signed list
    // of this browser's newest nonces (lib/jobToken.js), so a second click,
    // another tab or a retry does not orphan an earlier session that gets
    // paid, and a cookie planted by someone else cannot make the new
    // session's ticket one they know. Each entry carries its issue time and
    // stops counting after 24 hours (verifyClaimNonces drops it). /api/checkout/claim-ticket binds the
    // session only for a browser holding its nonce, so the session id in the
    // success URL is not enough on its own. SameSite=Lax so it survives
    // Stripe's redirect.
    let claimTicket = null;
    if (isTicketFlow) {
      const nonce = randomBytes(24).toString('base64url');
      const previous = verifyClaimNonces(parseCookies(req.headers?.cookie || '')[CLAIM_NONCE_COOKIE]) || [];
      claimTicket = hashClaimTicket(nonce);
      appendCookie(
        res,
        `${CLAIM_NONCE_COOKIE}=${signClaimNonces([nonce, ...previous])}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`
      );
    }

    // Subscription flow: charge the plan price immediately. No trial,
    // no deposit — just a clean recurring sub. Monthly $5/mo, yearly
    // $29/yr. Stripe Checkout displays the renewal terms natively.
    // Surface picks the per-surface Product variant so the checkout
    // page header shows the right name ("Glow Up Yearly Plan",
    // "AI Interior Yearly Plan", etc). Same price, same entitlement.
    const ALLOWED_SURFACES = new Set([
      'default',
      'glow-up',
      'interior-design',
      'local-business',
      'real-estate',
    ]);
    const safeSurface = ALLOWED_SURFACES.has(surface) ? surface : 'default';
    const price = v2Plan
      ? await getOrCreateV2Price({ kind: 'plan', plan, interval, amountCents: planCents, credits: v2Plan.credits })
      : await getOrCreatePrice(plan, safeSurface);

    // For authed users, look up (never create) an existing Stripe
    // customer. If one is found we pass `customer: customerId` so
    // Stripe reuses it. If not, we omit both `customer` and
    // `customer_email` — Stripe Checkout collects the email on its
    // own page and creates the Customer only at payment completion.
    // Anonymous flow does the same (no Supabase user yet to look
    // up). Trade-off: first-time subscribers type their email at
    // Stripe's page instead of having it prefilled, in exchange
    // for not littering Stripe with customers from abandoned
    // checkouts.
    let subCustomerId = null;
    if (!isAnon) {
      const admin = getSupabaseAdmin();
      subCustomerId = await findStripeCustomerForUser({
        admin,
        userId: session.user.id,
        email,
      });
    }

    // One plan per customer: a second subscription would bill twice. Plan
    // changes go through the Stripe customer portal (docs/go-live.md).
    if (v2Plan && subCustomerId && (await hasOurSubscription(subCustomerId))) {
      return res.status(409).json({
        error: 'You already have a plan. To change it, use Manage billing or contact support.',
        code: 'HAS_PLAN',
      });
    }

    const checkout = await stripe().checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: price.id, quantity: 1 }],
      ...(subCustomerId ? { customer: subCustomerId } : {}),
      success_url: `${origin}${successPath}`,
      cancel_url: `${origin}${isAnon ? '/' : '/dashboard?paid=0'}`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      ...(isAnon ? {} : { client_reference_id: session.user.id }),
      subscription_data: {
        metadata: subMetadata,
      },
      metadata: { ...adAttr, ...subMetadata, ...(claimTicket ? { claim_ticket: claimTicket } : {}) },
    });

    // Pixel value: actual cents charged today.
    const value = (v2Plan ? planCents : PLANS[plan].amountCents) / 100;
    const eventId = nsEventId(`ic-${checkout.id}`);
    sendCapiEvent({
      eventName: 'InitiateCheckout',
      eventId,
      value,
      currency: 'USD',
      email,
      req,
      customData: {
        kind: 'subscription',
        plan,
        ...(v2Plan ? { interval } : {}),
        ...(session?.user?.id ? { supabase_user_id: session.user.id } : { anonymous: 1 }),
      },
    }).catch(() => {});
    return res.status(200).json({
      url: checkout.url,
      meta: { eventName: 'InitiateCheckout', eventId, value, currency: 'USD' },
    });
  } catch (err) {
    if (err instanceof CustomerLookupUnavailableError) {
      console.error('[checkout]', err.message, err.cause?.message);
      return res.status(503).json({ error: 'Please try again.' });
    }
    // Never send the raw error to the browser (it can name env vars or carry
    // Stripe's message); the details go to the log.
    console.error('[checkout] failed', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
