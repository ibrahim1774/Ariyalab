import { stripe, planFromPrice, parseV2LookupKey } from './stripe.js';
import { customerForUser } from './grants.js';

/*
 * One plan per account, enforced when an anonymous v2 purchase is claimed
 * (pages/api/checkout/claim-ticket.js and the sign-up claim,
 * pages/api/checkout/claim.js), before the new customer is linked.
 * Signed-in buyers are stopped earlier, at checkout (409 HAS_PLAN).
 *
 * When the claiming user already has a plan of this app (active, trialing or
 * past_due) on their linked customer, or the paid customer already has
 * another one, the new subscription is NOT linked: it is cancelled at once and
 * its first invoice refunded through Stripe (idempotency keys, so a retried
 * claim never refunds twice). Its parked grant stays unclaimed; the refund's
 * webhook lowers it to nothing.
 */

export const SECOND_PLAN_MESSAGE =
  'You already have a plan — use Manage billing to change it. Your new payment has been refunded.';

const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);
const LIVE = ['active', 'trialing', 'past_due'];

async function hasOtherPlan(customerId, exceptSubId) {
  for (const status of LIVE) {
    const list = await stripe().subscriptions.list({ customer: customerId, status, limit: 20, expand: ['data.items.data.price'] });
    if ((list?.data || []).some((s) => s.id !== exceptSubId && planFromPrice(s.items?.data?.[0]?.price))) return true;
  }
  return false;
}

/** Cancels the new subscription and refunds its first invoice. */
async function cancelAndRefund(subId) {
  const sub = await stripe().subscriptions.retrieve(subId, { expand: ['latest_invoice'] });
  if (sub && sub.status !== 'canceled') {
    await stripe().subscriptions.cancel(subId, {}, { idempotencyKey: `second-plan-cancel-${subId}` });
  }
  const invoice = typeof sub?.latest_invoice === 'object' ? sub.latest_invoice : sub?.latest_invoice ? await stripe().invoices.retrieve(sub.latest_invoice) : null;
  const pi = idOf(invoice?.payment_intent);
  const charge = idOf(invoice?.charge);
  if (pi || charge) {
    await stripe().refunds.create(pi ? { payment_intent: pi } : { charge }, { idempotencyKey: `second-plan-refund-${subId}` });
  }
}

/**
 * -> true when the claim must stop (the new plan was cancelled and refunded),
 * false when the claim may link as usual.
 */
export async function refuseSecondPlan({ userId, customerId, checkoutSession }) {
  const price = checkoutSession?.line_items?.data?.[0]?.price;
  if (parseV2LookupKey(price?.lookup_key)?.kind !== 'plan') return false;
  const newSubId = idOf(checkoutSession.subscription);
  if (!newSubId) return false;
  const existing = await customerForUser(userId);
  const toCheck = [...new Set([existing, customerId].filter(Boolean))];
  let other = false;
  for (const c of toCheck) {
    if (await hasOtherPlan(c, newSubId)) {
      other = true;
      break;
    }
  }
  if (!other) return false;
  console.warn('[planGuard] second plan claimed; cancelling and refunding', newSubId, customerId);
  await cancelAndRefund(newSubId);
  return true;
}
