import { stripe, planFromPrice, PLANS } from '../../lib/stripe';
import { sendCapiEvent } from '../../lib/meta';
import { KEY, nsEventId } from '../../lib/metaKeys';
import { getSupabaseAdmin } from '../../lib/supabaseServer';
import { linkStripeCustomerToProfile } from '../../lib/entitlement';
import { isBillingV2 } from '../../lib/billingFlags';
import {
  grantForCheckoutSession,
  grantForInvoice,
  clawbackForPayment,
  recordStripeEvent,
  forgetStripeEvent,
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
 * Credits are granted only through lib/grants.js (idempotent on the
 * Stripe object id). Events are deduped on event.id in stripe_events:
 *   - billing_v2 off: the event id is recorded first; if handling throws
 *     the row is deleted again and we answer 500 so Stripe retries.
 *   - billing_v2 on: the ledger is idempotent on its own, so the event id
 *     is recorded only after handling succeeded.
 * Unknown event types are acknowledged with 200. Handler errors are 500.
 *
 * charge.refunded / charge.dispute.created claw back what the purchase
 * granted (billing_v2 only; acknowledged and logged otherwise).
 *
 * Setup:
 *   1. Stripe Dashboard → Webhooks → endpoint
 *      https://<host>/api/stripe-webhook subscribed to
 *      invoice.payment_succeeded, checkout.session.completed,
 *      charge.refunded, charge.dispute.created
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

  let v2;
  let recordedFirst = false;
  try {
    v2 = await isBillingV2();
    if (v2) {
      if (await isStripeEventRecorded(event.id)) {
        return res.status(200).json({ received: true, duplicate: true });
      }
    } else {
      if (!(await recordStripeEvent(event.id))) {
        return res.status(200).json({ received: true, duplicate: true });
      }
      recordedFirst = true;
    }

    await handle(event.data.object, req);

    if (v2) await recordStripeEvent(event.id);
  } catch (err) {
    console.error('[stripe-webhook] handler threw', event.type, event.id, err.message);
    if (recordedFirst) {
      await forgetStripeEvent(event.id).catch((e) =>
        console.error('[stripe-webhook] could not release event', event.id, e.message)
      );
    }
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
};

async function handleRefundOrDispute(payment) {
  const result = await clawbackForPayment(payment);
  const id = payment.charge?.id || payment.dispute?.id;
  if (result.skipped === 'legacy') {
    console.info('[stripe-webhook] refund/dispute acknowledged (billing_v2 off)', id);
  } else {
    console.info('[stripe-webhook] refund/dispute clawback', id, JSON.stringify(result));
  }
}

async function handleInvoicePaymentSucceeded(invoice, req) {
  if (!invoice.subscription) return;
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return;

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
  // here to avoid double-firing Purchase.
  if (invoice.billing_reason === 'subscription_create') return;

  const value = PLANS[plan].amountCents / 100;

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
 * per invoice (billing_v2), never here.
 */
async function handleCheckoutSessionCompleted(checkoutSession, req) {
  if (checkoutSession.mode !== 'payment') return;
  if (checkoutSession.payment_status !== 'paid') return;

  const customerId =
    typeof checkoutSession.customer === 'string'
      ? checkoutSession.customer
      : checkoutSession.customer?.id;
  if (!customerId) return;

  // Re-retrieve with line_items expanded (event payload doesn't include them).
  const fullSession = await stripe().checkout.sessions.retrieve(checkoutSession.id, {
    expand: ['line_items.data.price'],
  });

  // Ensure profile.stripe_customer_id points at this customer so the
  // dashboard (and, under billing_v2, the grant) finds it. The buyer id
  // is written server-side by /api/checkout. Best-effort: a refused or
  // failed link never blocks the grant (it is parked or lands on the
  // customer instead).
  const buyerId = fullSession.client_reference_id || fullSession.metadata?.supabase_user_id;
  if (buyerId) {
    try {
      await linkStripeCustomerToProfile(getSupabaseAdmin(), buyerId, customerId);
    } catch (linkErr) {
      console.warn('[webhook/topup] profile link failed', linkErr.message);
    }
  }

  const result = await grantForCheckoutSession(fullSession);
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
