import { stripe, planInfoFromPrice } from './stripe.js';
import { customerForUser } from './grants.js';

/*
 * The signed-in buyer's current billing-v2 plan, for /app/billing.
 *
 * Nothing in the database holds a monthly plan (credit_yearly_subs only holds yearly ones), so this reads the buyer's
 * OWN Stripe customer's subscriptions, one call, cached per user for a minute (at most 500 users, oldest dropped).
 * `{ fresh: true }` skips the cache and refreshes it (the page asks for it on the way back from the portal or checkout).
 * A failure throws (not cached): the caller says the plan is unknown. Only this app's own prices count (v2 plans, and legacy plans, which
 * carry `legacy: true`); another product's price on the shared account and an ended subscription are ignored.
 */
const CACHE_MS = 60 * 1000;
export const PLAN_CACHE_MAX = 500;
const LIVE = new Set(['active', 'trialing', 'past_due']);
const cache = new Map(); // userId -> { until, plan }; insertion order = age

export function _resetPlanCache() {
  cache.clear();
}

const iso = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

function remember(userId, plan) {
  cache.delete(userId);
  while (cache.size >= PLAN_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(userId, { until: Date.now() + CACHE_MS, plan });
}

export async function currentPlanFor(userId, { fresh = false } = {}) {
  const hit = cache.get(userId);
  if (!fresh && hit && hit.until > Date.now()) return hit.plan;
  try {
    const customer = await customerForUser(userId);
    let plan = null;
    if (customer) {
      const list = await stripe().subscriptions.list({ customer, status: 'all', limit: 20, expand: ['data.items.data.price'] });
      const found = [];
      for (const sub of list?.data || []) {
        if (!LIVE.has(sub.status)) continue;
        const info = planInfoFromPrice(sub.items?.data?.[0]?.price);
        if (!info) continue;
        found.push({
          plan: info.plan,
          interval: info.interval,
          legacy: info.version !== 'v2',
          status: sub.status,
          renewsAt: iso(sub.current_period_end),
          // Cancellation pending: at the period end, or on the date Stripe was given.
          endsAt: sub.cancel_at ? iso(sub.cancel_at) : sub.cancel_at_period_end ? iso(sub.current_period_end) : null,
        });
      }
      plan = found.find((p) => !p.legacy) || found[0] || null;
    }
    remember(userId, plan);
    return plan;
  } catch (err) {
    console.error('[currentPlan] could not read the subscription', err);
    throw err;
  }
}
