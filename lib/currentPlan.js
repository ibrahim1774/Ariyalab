import { stripe, planInfoFromPrice } from './stripe.js';
import { customerForUser } from './grants.js';

/*
 * The signed-in buyer's current billing-v2 plan, for /app/billing.
 *
 * Nothing in the database holds a monthly plan (credit_yearly_subs only holds yearly ones), so this reads the buyer's
 * OWN Stripe customer's subscriptions, one call, cached per user for a minute. It never throws: a failure answers null
 * (the page then shows no plan) and is not cached. Only this app's v2 plan prices count; another product's price on the
 * shared account, a legacy plan and an ended subscription are ignored.
 */
const CACHE_MS = 60 * 1000;
const LIVE = new Set(['active', 'trialing', 'past_due']);
const cache = new Map(); // userId -> { until, plan }

export function _resetPlanCache() {
  cache.clear();
}

const iso = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

export async function currentPlanFor(userId) {
  const hit = cache.get(userId);
  if (hit && hit.until > Date.now()) return hit.plan;
  try {
    const customer = await customerForUser(userId);
    let plan = null;
    if (customer) {
      const list = await stripe().subscriptions.list({ customer, status: 'all', limit: 20, expand: ['data.items.data.price'] });
      for (const sub of list?.data || []) {
        if (!LIVE.has(sub.status)) continue;
        const info = planInfoFromPrice(sub.items?.data?.[0]?.price);
        if (!info || info.version !== 'v2') continue;
        plan = {
          plan: info.plan,
          interval: info.interval,
          status: sub.status,
          renewsAt: iso(sub.current_period_end),
          // Cancellation pending: at the period end, or on the date Stripe was given.
          endsAt: sub.cancel_at ? iso(sub.cancel_at) : sub.cancel_at_period_end ? iso(sub.current_period_end) : null,
        };
        break;
      }
    }
    cache.set(userId, { until: Date.now() + CACHE_MS, plan });
    return plan;
  } catch (err) {
    console.error('[currentPlan] could not read the subscription', err);
    return null;
  }
}
