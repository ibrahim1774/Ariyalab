import { stripe, planFromPrice, topupFromPrice, planAmountCents } from '../../lib/stripe';
import { sendCapiEvent } from '../../lib/meta';
import { KEY, nsEventId } from '../../lib/metaKeys';
import { getSupabaseAdmin } from '../../lib/supabaseServer';
import { linkStripeCustomerToProfile, CustomerLinkedElsewhereError } from '../../lib/entitlement';
import { isBillingV2Strict } from '../../lib/billingFlags';
import {
  grantForCheckoutSession,
  grantForInvoice,
  clawbackForPayment,
  syncSubscription,
  recordStripeEvent,
  isStripeEventRecorded,
} from '../../lib/grants';

/*
 * Stripe webhook handler.
 *
 * Subscribed to `invoice.payment_succeeded`. Fires Meta CAPI Purchase
 * for any subscription invoice that actually moved money, except the
 * very first invoice on a non-trial signup — that case is already
 * reported by /api/checkout/confirm at checkout completion. This
 * catches:
 *   - Yearly trial conversions (24h after signup, when Stripe takes
 *     the first $49 charge — billing_reason='subscription_cycle')
 *   - Every renewal cycle thereafter
 *   - Monthly renewals (month 2+)
 *
 * Also writes `lastReportedPeriodStart` on the customer metadata so
 * the lazy fallback in lib/entitlement.js doesn't re-fire the same
 * Purchase the next time the user opens the dashboard.
 *
 * Credits are granted only through lib/grants.js, which grants each Stripe
 * object once (lock + done rows on the legacy path, ledger idempotency
 * under billing_v2). Events are also deduped on event.id in stripe_events,
 * recorded only after handling succeeded, so a crash mid-handler is
 * retried rather than lost. Unknown event types are acknowledged with 200.
 * Handler errors are 500 so Stripe retries.
 *
 * Nothing here writes for an object that is not this app's price or plan:
 * haelabs.live shares the Stripe account, the webhook stream and profiles.
 *
 * charge.refunded / charge.dispute.created claw back what the purchase
 * granted (billing_v2 only; acknowledged and logged otherwise).
 *
 * Setup:
 *   1. Stripe Dashboard → Webhooks → endpoint
 *      https://<host>/api/stripe-webhook subscribed to
 *      invoice.payment_succeeded, checkout.session.completed,
 *      charge.refunded, charge.dispute.created,
 *      customer.subscription.updated, customer.subscription.deleted
 *   2. Add STRIPE_WEBHOOK_SECRET (whsec_…) to Vercel env vars.
 */

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method not allowed');
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  if (!secret) {
    console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).end('Webhook secret not configured');
  }
  if (!sig) {
    return res.status(400).end('Missing stripe-signature header');
  }

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed', err.message);
    return res.status(400).end(`Webhook Error: ${err.message}`);
  }

  const handle = HANDLERS[event.type];
  if (!handle) return res.status(200).json({ received: true, ignored: true });

  try {
    if (await isStripeEventRecorded(event.id)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    await handle(event.data.object, req, event);
    await recordStripeEvent(event.id);
  } catch (err) {
    console.error('[stripe-webhook] handler threw', event.type, event.id, err.message);
    // 500 so Stripe retries; the grant paths are idempotent.
    return res.status(500).json({ error: 'handler_failed' });
  }

  return res.status(200).json({ received: true });
}

const HANDLERS = {
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
  'checkout.session.completed': handleCheckoutSessionCompleted,
  'charge.refunded': (charge) => handleRefundOrDispute({ charge }),
  'charge.dispute.created': (dispute) => handleRefundOrDispute({ dispute }),
  // Yearly v2 bookkeeping and mid-period upgrades (lib/grants.js syncSubscription).
  'customer.subscription.updated': (sub, _req, event) => handleSubscriptionChange(sub, event, false),
  'customer.subscription.deleted': (sub, _req, event) => handleSubscriptionChange(sub, event, true),
};

async function handleSubscriptionChange(sub, event, deleted) {
  const result = await syncSubscription(sub, event?.data?.previous_attributes || {}, { deleted });
  if (result.upgrade && typeof result.upgrade === 'object') {
    console.info('[stripe-webhook] plan upgrade granted', sub.id, JSON.stringify(result.upgrade));
  }
}

async function handleRefundOrDispute(payment) {
  const result = await clawbackForPayment(payment);
  const id = payment.charge?.id || payment.dispute?.id;
  if (result.skipped === 'legacy') {
    console.info('[stripe-webhook] refund/dispute acknowledged (billing_v2 off)', id);
  } else {
    console.info('[stripe-webhook] refund/dispute clawback', id, JSON.stringify(result));
  }
}

async function handleInvoicePaymentSucceeded(eventInvoice, req) {
  // Re-read through the SDK: payload fields follow the webhook endpoint's
  // API version (newer versions drop invoice.subscription), the SDK's are
  // pinned.
  const invoice = await stripe().invoices.retrieve(eventInvoice.id);
  if (!invoice?.subscription) return;
  if (invoice.status !== 'paid') return;

  const subId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;

  const sub = await stripe().subscriptions.retrieve(subId, {
    expand: ['items.data.price'],
  });
  const price = sub.items?.data?.[0]?.price;
  const plan = planFromPrice(price);

  // Cross-deployment isolation: Haelabs and Ariya Lab share the same
  // Stripe customer + webhook stream. planFromPrice returns null for
  // subscriptions whose lookup_key isn't in this deployment's PLANS /
  // PLAN_SURFACES — that means the event belongs to the other site.
  // Skip silently so we don't write to namespaced metadata or fire
  // CAPI for someone else's purchase.
  if (!plan) return;

  // Credits (billing_v2 only; the legacy path rolls plan credits over
  // lazily in lib/entitlement.js). Includes the first invoice.
  await grantForInvoice(invoice, { subscription: sub });

  // First-invoice charge is reported by /api/checkout/confirm; skip
  // here to avoid double-firing Purchase. Purchase only when money moved.
  if (invoice.billing_reason === 'subscription_create') return;
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return;

  const value = planAmountCents(plan, price) / 100;

  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  let email = invoice.customer_email;
  let supabaseUserId;
  let customerMd = {};
  if (customerId) {
    try {
      const customer = await stripe().customers.retrieve(customerId);
      if (customer && !customer.deleted) {
        email = email || customer.email;
        customerMd = customer.metadata || {};
        supabaseUserId = customerMd.supabase_user_id;
      }
    } catch (err) {
      console.warn('[stripe-webhook] customer retrieve failed', err.message);
    }
  }

  // Mark this period as reported so the lazy CAPI branch in
  // lib/entitlement.js skips it. Use sub.current_period_start (= when
  // the active billing period began) — same value the entitlement
  // reader compares against.
  const periodStartMs = (sub.current_period_start || 0) * 1000;
  if (customerId && periodStartMs > 0) {
    try {
      await stripe().customers.update(customerId, {
        metadata: {
          ...customerMd,
          [KEY.lastReportedPeriodStart]: String(periodStartMs),
        },
      });
    } catch (err) {
      console.warn('[stripe-webhook] customer metadata update failed', err.message);
    }
  }

  const eventId = nsEventId(`pur-inv-${invoice.id}`);
  // Reporting only: a Meta failure must not 500 an invoice already granted.
  await sendCapiEvent({
    eventName: 'Purchase',
    eventId,
    value,
    currency: (invoice.currency || 'usd').toUpperCase(),
    email,
    req,
    customData: {
      kind: 'subscription',
      plan: plan || undefined,
      billing_reason: invoice.billing_reason,
      supabase_user_id: supabaseUserId,
      invoice_id: invoice.id,
    },
  }).catch((err) => console.warn('[stripe-webhook] CAPI failed', err.message));
}

/*
 * Top-up safety net. /api/checkout/confirm normally grants when Stripe
 * redirects the user back, but if they close the tab between paying and
 * the redirect the credits would never land. Both paths go through
 * grantForCheckoutSession, which grants a session exactly once.
 * Subscriptions are seeded by /confirm or the claim routes (legacy) or
 * per invoice (billing_v2); here a billing_v2 subscription is only linked.
 */
async function handleCheckoutSessionCompleted(checkoutSession, req) {
  if (checkoutSession.payment_status !== 'paid' && checkoutSession.payment_status !== 'no_payment_required') {
    return;
  }
  const customerId =
    typeof checkoutSession.customer === 'string'
      ? checkoutSession.customer
      : checkoutSession.customer?.id;
  if (!customerId) return;

  // Re-retrieve with line_items expanded (event payload doesn't include them).
  const fullSession = await stripe().checkout.sessions.retrieve(checkoutSession.id, {
    expand: ['line_items.data.price'],
  });
  const price = fullSession.line_items?.data?.[0]?.price;
  const plan = planFromPrice(price);
  const topup = plan ? null : topupFromPrice(price);
  // Not this app's price (haelabs): write nothing.
  if (!plan && !topup) return;

  if (fullSession.mode === 'subscription') {
    // Legacy subscriptions are seeded by /confirm or a claim route (they
    // need the signed-in user). Under billing_v2 the invoice grants; link a
    // signed-in buyer here so a closed tab does not leave the grant parked.
    // client_reference_id is set by /api/checkout for signed-in buyers only.
    if (plan && fullSession.client_reference_id && (await isBillingV2Strict())) {
      await linkBuyer(fullSession.client_reference_id, customerId, { rethrow: true });
    }
    return;
  }
  if (!topup) return;

  // The buyer id is written server-side by /api/checkout (top-ups require
  // sign-in). Under billing_v2 an unlinked customer is granted to them.
  const buyerId = fullSession.client_reference_id || fullSession.metadata?.supabase_user_id || undefined;
  const result = await grantForCheckoutSession(fullSession, { userId: buyerId });

  // Then make sure profile.stripe_customer_id points at this customer so the
  // dashboard finds it.
  if (buyerId) await linkBuyer(buyerId, customerId);

  if (!result.granted || result.kind !== 'topup') return;

  // Fire CAPI Purchase for the top-up. Browser pixel may not have
  // fired (closed tab) — same eventId as /confirm would have used so
  // Meta dedupes if both end up firing.
  const value = result.topup.amountCents / 100;
  const eventId = nsEventId(`pur-${checkoutSession.id}`);
  const email =
    fullSession.customer_details?.email ||
    (typeof fullSession.customer === 'object' ? fullSession.customer?.email : undefined);
  sendCapiEvent({
    eventName: 'Purchase',
    eventId,
    value,
    currency: 'USD',
    email,
    req,
    customData: {
      kind: 'topup',
      pack: result.topup.key,
      supabase_user_id: buyerId,
      via: 'webhook',
    },
  }).catch(() => {});
}

// The buyer id comes from the session, written server-side by /api/checkout.
// A refused link (409: the customer or the profile belongs elsewhere, which
// includes every buyer whose profile already points at another live customer
// while relink_mode is 'support') never fails the webhook: the grant already
// landed on the customer, or is parked for support. Other failures are
// best-effort for top-ups (their grant has already claimed) but rethrown
// with `rethrow` so Stripe retries.
async function linkBuyer(userId, customerId, { rethrow = false } = {}) {
  try {
    await linkStripeCustomerToProfile(getSupabaseAdmin(), userId, customerId, { via: 'server' });
  } catch (linkErr) {
    if (rethrow && !(linkErr instanceof CustomerLinkedElsewhereError)) throw linkErr;
    console.warn('[stripe-webhook] profile link failed', customerId, linkErr.message);
  }
}
