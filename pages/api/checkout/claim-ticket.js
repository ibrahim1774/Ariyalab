import { stripe, planFromPrice, PLANS, CAPS } from '../../../lib/stripe';
import {
  assertCanLink,
  linkStripeCustomerToProfile,
  CustomerLinkedElsewhereError,
} from '../../../lib/entitlement';
import { getUserFromRequest } from '../../../lib/supabaseServer';
import { appendSetCookie } from '../../../lib/setCookie';
import { sendCapiEvent } from '../../../lib/meta';
import { nsEventId } from '../../../lib/metaKeys';
import {
  checkSessionOwner,
  grantForCheckoutSession,
  GrantInProgressError,
  CLAIM_NONCE_COOKIE,
  claimNoncesFromCookie,
  claimCookieWithoutSession,
} from '../../../lib/grants';

/*
 * UGC-2 ticket-claim endpoint (email-independent, leak-protected).
 *
 * Sibling of /api/checkout/claim, used ONLY by the /ugc-2 pay-first
 * flow. Differences from /api/checkout/claim:
 *
 *   - The Stripe Checkout session_id is read from an httpOnly cookie
 *     (`ugc2_claim_sid`) set server-side by /ugc-2/claim, NOT from the
 *     request/query. The ticket never appears in a client-rendered URL,
 *     so it can't leak to the Meta/TikTok pixels or browser referrers.
 *   - There is NO email-match gate. The user may sign up with ANY email
 *     or Google account. The session id alone is NOT enough (it travels in
 *     the success URL): the binding is authorized by the claim ticket
 *     /api/checkout issued to this browser when checkout started — a
 *     random nonce in the httpOnly `ugc2_claim_nonce` cookie (a signed list
 *     of the browser's newest five, each valid for 24 hours) whose SHA-256
 *     is stored on the session as metadata.claim_ticket. The usual owner
 *     checks (client_reference_id, verified email) also pass.
 *   - Ticket-flow sessions created before tickets carried a nonce are
 *     accepted on the session-id cookie alone for TICKET_TTL_S after
 *     creation (the same 30 minutes the cookie lives), so purchases in
 *     flight at deploy time still link. Nothing older takes that path.
 *
 * Everything else — payment-status guard, grant once per session
 * (lib/grants.js), profile link, Purchase CAPI — mirrors
 * /api/checkout/claim so the entitlement reader is unchanged.
 */

const CLAIM_COOKIE = 'ugc2_claim_sid';
const TICKET_TTL_S = 1800;

// Clears the session-id cookie and removes only this session's nonce from
// the browser's list, so a second paid session keeps its ticket. The nonce
// cookie is cleared when nothing is left.
// Appended, so a refreshed session cookie set earlier in the request survives.
export function clearClaimCookie(res, nonceCookie, checkoutSession) {
  const left = claimCookieWithoutSession(nonceCookie, checkoutSession);
  appendSetCookie(res, `${CLAIM_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  appendSetCookie(
    res,
    left
      ? `${CLAIM_NONCE_COOKIE}=${left}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`
      : `${CLAIM_NONCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  );
}

// A ticket-flow session from before /api/checkout stamped claim_ticket.
function isPreTicketSession(cs) {
  if (cs.metadata?.claim_ticket) return false;
  if (cs.metadata?.pending_supabase_link !== 'true') return false;
  if (!String(cs.success_url || '').includes('/ugc-2/claim?')) return false;
  return Boolean(cs.created) && Date.now() / 1000 - cs.created <= TICKET_TTL_S;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Sign in first.' });

  // Ticket comes from the httpOnly cookie, never the request body/query.
  const sessionId = req.cookies?.[CLAIM_COOKIE];
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return res.status(400).json({
      error: 'No payment in progress. Please start checkout again.',
    });
  }

  try {
    const checkoutSession = await stripe().checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price', 'subscription', 'customer'],
    });

    // Same payment-status hard guard as /api/checkout/confirm.
    const okPaymentStatuses = new Set(['paid', 'no_payment_required']);
    if (!okPaymentStatuses.has(checkoutSession.payment_status)) {
      return res.status(400).json({
        error: `Payment not completed (status: ${checkoutSession.payment_status}).`,
      });
    }

    const customerId =
      typeof checkoutSession.customer === 'string'
        ? checkoutSession.customer
        : checkoutSession.customer?.id;
    if (!customerId) {
      return res.status(400).json({ error: 'Session has no customer.' });
    }

    const customerEmail =
      checkoutSession.customer_details?.email ||
      (typeof checkoutSession.customer === 'object'
        ? checkoutSession.customer?.email
        : null);

    // NOTE: intentionally NO email-match gate here. Authorization is the
    // claim ticket issued to this browser. See file header.
    const owner = checkSessionOwner(checkoutSession, session.user, {
      claimNonces: claimNoncesFromCookie(req.cookies?.[CLAIM_NONCE_COOKIE]),
    });
    if (!owner.ok && !isPreTicketSession(checkoutSession)) {
      return res.status(403).json({
        error: 'This payment was started in a different browser. Contact support to link it.',
      });
    }

    // How ownership was proven: only non-email proofs may move a profile
    // off an existing customer (lib/entitlement.js assertCanLink).
    const ownedVia = owner.ok ? owner.via : 'pre_ticket';

    const price = checkoutSession.line_items?.data?.[0]?.price;
    const plan = planFromPrice(price);
    if (!plan) {
      return res.status(400).json({ error: 'Session is not a subscription.' });
    }

    // Grant before linking (the entitlement reader must never see a linked
    // but unseeded customer), but only once the link is known to be allowed.
    try {
      await assertCanLink(session.user.id, customerId, { via: ownedVia });
    } catch (linkErr) {
      if (linkErr instanceof CustomerLinkedElsewhereError) {
        return res.status(409).json({ error: linkErr.message });
      }
      throw linkErr;
    }

    // Seeds plan + credits (legacy) or leaves the grant to the invoice
    // (billing_v2).
    let grant;
    try {
      grant = await grantForCheckoutSession(checkoutSession, {
        userId: session.user.id,
        clearPendingLink: true,
      });
    } catch (grantErr) {
      if (!(grantErr instanceof GrantInProgressError)) throw grantErr;
      return res.status(409).json({
        error: 'Your payment is still being processed. Try again in a couple of minutes.',
        retryable: true,
      });
    }

    // Authoritative link in our profiles table.
    try {
      await linkStripeCustomerToProfile(session.supabase, session.user.id, customerId, { via: ownedVia });
    } catch (linkErr) {
      if (linkErr instanceof CustomerLinkedElsewhereError) {
        return res.status(409).json({ error: linkErr.message });
      }
      // A relink for this user or their old customer is already running.
      if (linkErr instanceof GrantInProgressError) {
        return res.status(409).json({
          error: 'Your payment is still being processed. Try again in a couple of minutes.',
          retryable: true,
        });
      }
      throw linkErr;
    }

    // Ticket is spent: drop it so it can't be replayed.
    clearClaimCookie(res, req.cookies?.[CLAIM_NONCE_COOKIE], checkoutSession);

    if (!grant.granted && grant.skipped !== 'granted_per_invoice') {
      // Nothing seeded by this call: already claimed (refresh / double tab /
      // /confirm), or skipped for the reason given.
      return res.status(200).json({
        ok: true,
        alreadyProcessed: Boolean(grant.already),
        ...(grant.skipped ? { skipped: grant.skipped } : {}),
        tier: plan,
        videoCap: CAPS[plan],
      });
    }

    const sub = checkoutSession.subscription;
    const value = PLANS[plan].amountCents / 100;
    // Match /api/checkout/confirm.js: a trialing yearly sub fires
    // StartTrial (no charge yet); the real Purchase fires from the
    // Stripe webhook when the post-trial invoice is paid.
    const isTrialingSub = sub?.status === 'trialing';
    const eventName = isTrialingSub ? 'StartTrial' : 'Purchase';
    const eventId = nsEventId(`${isTrialingSub ? 'st' : 'pur'}-${checkoutSession.id}`);
    const reportedValue = isTrialingSub ? 0 : value;
    await sendCapiEvent({
      eventName,
      eventId,
      value: reportedValue,
      currency: 'USD',
      email: customerEmail,
      req,
      customData: {
        kind: 'subscription',
        plan,
        supabase_user_id: session.user.id,
        claim: 1,
        flow: 'ugc2-ticket',
      },
    });

    return res.status(200).json({
      ok: true,
      tier: plan,
      videoCap: CAPS[plan],
      meta: { eventId, eventName, value: reportedValue, currency: 'USD' },
    });
  } catch (err) {
    console.error('[checkout/claim-ticket] failed', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
