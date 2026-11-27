import { stripe, planFromPrice, parseV2LookupKey } from './stripe.js';
import { customerForUser, usersForCustomer, CLASSIC_URL } from './grants.js';

/*
 * One plan per account, enforced when a v2 plan purchase is claimed or
 * confirmed (pages/api/checkout/claim-ticket.js, the sign-up claim
 * pages/api/checkout/claim.js, and pages/api/checkout/confirm.js), before the
 * new customer is linked. Signed-in buyers are also stopped earlier, at
 * checkout (409 HAS_PLAN).
 *
 * The new subscription is cancelled at once and its first invoice refunded
 * through Stripe (idempotency keys; a charge already refunded is not refunded
 * again, so a claim retried after Stripe's 24 h idempotency window never
 * fails), and the new customer is not linked; its parked grant stays
 * unclaimed (the refund's webhook lowers it) when:
 *   - the claimer, or the paid customer, already has another plan of this app
 *     (active, trialing or past_due): "You already have a plan ...";
 *   - (claims only) the claimer's account already has a different Stripe
 *     customer with no plan: a second customer would be left billing apart
 *     from the account, so "Buy the plan while signed in so it joins your
 *     account."
 * When nothing was charged (a trial, a 100% coupon) the message says so.
 */

export const SECOND_PLAN_MESSAGE =
  'You already have a plan — use Manage billing to change it. Your new payment has been refunded.';
export const SIGNED_IN_MESSAGE = 'Buy the plan while signed in so it joins your account.';

const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);
const LIVE = ['active', 'trialing', 'past_due'];

/** 'v2' | 'classic' (an old ariyalab_* plan, which lives on www.ariyalab.online) | false. A v2 plan wins. */
async function hasOtherPlan(customerId, exceptSubId) {
  let found = false;
  for (const status of LIVE) {
    const list = await stripe().subscriptions.list({ customer: customerId, status, limit: 20, expand: ['data.items.data.price'] });
    for (const s of list?.data || []) {
      const price = s.items?.data?.[0]?.price;
      if (s.id === exceptSubId || !planFromPrice(price)) continue;
      if (parseV2LookupKey(price?.lookup_key)) return 'v2';
      found = 'classic';
    }
  }
  return found;
}

/** The charge that paid an invoice (expanded), or null when nothing was charged. */
async function invoiceCharge(invoice) {
  if (!invoice || !(invoice.amount_paid > 0)) return null;
  const chargeId = idOf(invoice.charge);
  if (chargeId) return stripe().charges.retrieve(chargeId);
  const pi = idOf(invoice.payment_intent);
  if (!pi) return null;
  const intent = await stripe().paymentIntents.retrieve(pi, { expand: ['latest_charge'] });
  const latest = intent?.latest_charge;
  return typeof latest === 'object' ? latest : latest ? stripe().charges.retrieve(latest) : null;
}

/** Cancels the new subscription and refunds its first invoice. -> true when money was (or had been) refunded. */
async function cancelAndRefund(subId) {
  const sub = await stripe().subscriptions.retrieve(subId, { expand: ['latest_invoice'] });
  if (sub && sub.status !== 'canceled') {
    await stripe().subscriptions.cancel(subId, {}, { idempotencyKey: `second-plan-cancel-${subId}` });
  }
  const invoice = typeof sub?.latest_invoice === 'object'
    ? sub.latest_invoice
    : sub?.latest_invoice ? await stripe().invoices.retrieve(sub.latest_invoice) : null;
  const charge = await invoiceCharge(invoice);
  if (!charge) return false;
  if (charge.refunded || (charge.amount_refunded || 0) >= (charge.amount || 0)) return true;
  await stripe().refunds.create({ charge: charge.id }, { idempotencyKey: `second-plan-refund-${subId}` });
  return true;
}

/**
 * -> null when the purchase may be linked as usual, else
 * { message, refunded } after the new plan was cancelled (and refunded).
 * `claim` (the anonymous claim routes) also refuses a claimer whose account
 * has a different customer without a plan; /confirm (a signed-in purchase)
 * does not.
 */
export async function refuseSecondPlan({ userId, customerId, checkoutSession, claim = true }) {
  const price = checkoutSession?.line_items?.data?.[0]?.price;
  if (parseV2LookupKey(price?.lookup_key)?.kind !== 'plan') return null;
  const newSubId = idOf(checkoutSession.subscription);
  if (!newSubId) return null;
  const existing = await customerForUser(userId);
  let hasPlan = false;
  for (const c of [...new Set([existing, customerId].filter(Boolean))]) {
    const other = await hasOtherPlan(c, newSubId);
    if (other) {
      hasPlan = hasPlan === 'v2' ? 'v2' : other;
      if (other === 'v2') break;
    }
  }
  const otherCustomer = claim && existing && existing !== customerId;
  if (!hasPlan && !otherCustomer) return null;
  console.warn('[planGuard] refusing a second plan or customer; cancelling and refunding', newSubId, customerId);
  const refunded = await cancelAndRefund(newSubId);
  const tail = refunded ? 'Your new payment has been refunded.' : 'The new plan was cancelled; nothing was charged.';
  const message = hasPlan === 'classic'
    ? `Your Ariya Lab plan lives on ${CLASSIC_URL} — manage it there. ${tail}`
    : hasPlan
    ? `You already have a plan — use Manage billing to change it. ${tail}`
    : `${SIGNED_IN_MESSAGE} ${refunded ? 'Your payment has been refunded.' : 'The new plan was cancelled; nothing was charged.'}`;
  return { message, refunded, ...(hasPlan === 'classic' ? { classicUrl: CLASSIC_URL } : {}) };
}

/**
 * true when a v2 plan's paid customer is already linked to an account other
 * than this user's (checked before the guard, so such a purchase is never
 * cancelled from here). Legacy purchases keep their own checks (assertCanLink).
 */
export async function customerBelongsToOther(customerId, userId, checkoutSession) {
  const price = checkoutSession?.line_items?.data?.[0]?.price;
  if (parseV2LookupKey(price?.lookup_key)?.kind !== 'plan') return false;
  return (await usersForCustomer(customerId)).some((id) => id !== userId);
}
