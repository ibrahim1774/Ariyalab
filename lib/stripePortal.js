import { createHash } from 'node:crypto';
import { getOrCreateV2Price, parseV2LookupKey, V2_PREFIX } from './stripe.js';
import { v2Offers } from './pricing.js';
import { PLANS_V2 } from './pricingConstants.js';

/*
 * This app's own Stripe billing-portal configuration.
 *
 * Without a `configuration` Stripe uses the ACCOUNT default portal, and the Stripe account is shared with other
 * products: their default portal offers their prices and applies downgrades at once. So every portal session this app
 * opens names a configuration of its own, found by metadata `app: 'ariyalab'` + a hash of the settings and price ids
 * (a pricing change is a new configuration). It also offers the older ACTIVE v2 plan prices subscribers may still be on,
 * so they can switch (current prices first; within Stripe's 10-product limit the oldest extras are left out). Only OUR configurations are ever read back; this file creates and lists,
 * it never updates or deletes anything, so the account default and any other product's configuration stay as they are.
 *
 * Stripe API version: lib/stripe.js pins 2024-06-20. On it a portal configuration supports
 * features.subscription_update.{products, default_allowed_updates, proration_behavior: 'always_invoice',
 * schedule_at_period_end.conditions: decreasing_item_amount | shortening_interval} and
 * features.subscription_cancel.mode: 'at_period_end' (all present since 2022; the installed stripe 22.x types them too).
 */
export const PORTAL_APP = 'ariyalab';
export const PORTAL_HEADLINE = 'Manage your Ariya Lab plan';
// Bump when the settings below change, so the next call makes a new configuration.
const SETTINGS_VERSION = 3;
const CACHE_MS = 5 * 60 * 1000;
// Stripe: a portal configuration's subscription_update lists up to 10 products. Each v2 price has a product of its own.
export const PORTAL_MAX_PRODUCTS = 10;
const PRICE_PAGE = 100;
const PRICE_PAGES_MAX = 20;

export const PORTAL_VARIANTS = ['all', 'yearly'];
const cache = new Map(); // variant -> { signature, id, until }

export function _resetPortalCache() {
  cache.clear();
}

/** The v2 plan price for each plan and interval, created first when missing. */
async function planPrices(pricing) {
  const offers = v2Offers(pricing);
  const out = [];
  for (const plan of Object.keys(PLANS_V2)) {
    const o = offers.plans[plan];
    for (const [interval, amountCents] of [['month', o.monthlyCents], ['year', o.yearlyCents]]) {
      const price = await getOrCreateV2Price({ kind: 'plan', plan, interval, amountCents, credits: o.credits });
      const product = typeof price.product === 'string' ? price.product : price.product?.id;
      if (!product) throw new Error(`Price ${price.id} has no product`);
      out.push({ id: price.id, product, interval });
    }
  }
  return out;
}

/**
 * Older ACTIVE ariya_v2_ plan prices (an amount or credit count changed in the admin pricing editor, subscribers stayed on
 * the price they bought), newest first, so a subscriber on one can still switch. Read only; archived prices are never
 * listed (active: true), other products' prices and top-ups are skipped by their lookup key.
 */
async function olderPlanPrices(client, currentIds, intervals) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < PRICE_PAGES_MAX; page += 1) {
    const list = await client.prices.list({
      active: true,
      type: 'recurring',
      limit: PRICE_PAGE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = list?.data || [];
    for (const p of data) {
      if (!p.lookup_key?.startsWith(V2_PREFIX) || currentIds.has(p.id) || !p.recurring) continue;
      if (parseV2LookupKey(p.lookup_key)?.kind !== 'plan') continue;
      const product = typeof p.product === 'string' ? p.product : p.product?.id;
      if (product && intervals.includes(p.recurring.interval)) out.push({ id: p.id, product, created: p.created || 0 });
    }
    if (!list?.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return out.sort((a, b) => b.created - a.created);
}

/** The current prices, then older active ones newest first, within Stripe's product limit (current ones always stay). */
function withinLimit(current, older) {
  const products = new Set(current.map((p) => p.product));
  const kept = [...current];
  let dropped = 0;
  for (const p of older) {
    if (products.has(p.product) || products.size < PORTAL_MAX_PRODUCTS) {
      products.add(p.product);
      kept.push({ id: p.id, product: p.product });
    } else {
      dropped += 1;
    }
  }
  if (dropped) console.warn(`[stripePortal] ${dropped} older plan price(s) left out: a portal configuration holds at most ${PORTAL_MAX_PRODUCTS} products`);
  return kept;
}

function settingsFor(prices) {
  const byProduct = new Map();
  for (const p of prices) byProduct.set(p.product, [...(byProduct.get(p.product) || []), p.id]);
  return {
    business_profile: { headline: PORTAL_HEADLINE },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        // lib/grants.js credits an upgrade only from a paid proration invoice, so an upgrade is invoiced at once.
        proration_behavior: 'always_invoice',
        // A cheaper plan or a shorter interval starts at the end of the period: no money or credits go back mid-period.
        schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }] },
        // Stripe's default lets the customer raise the quantity of a plan; a plan is quantity 1 only.
        products: [...byProduct.entries()].map(([product, ids]) => ({ product, prices: ids, adjustable_quantity: { enabled: false } })),
      },
    },
  };
}

// The default variant keeps its original hash input, so the configuration made before variants existed is still found.
const hashOf = (prices, variant) =>
  createHash('sha256')
    .update(JSON.stringify([SETTINGS_VERSION, prices.map((p) => p.id).sort(), ...(variant === 'all' ? [] : [variant])]))
    .digest('hex')
    .slice(0, 12);

/** Active configurations, paged. Read only. */
async function findOurs(client, hash) {
  let startingAfter;
  for (;;) {
    const page = await client.billingPortal.configurations.list({
      active: true,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = page?.data || [];
    const hit = data.find((c) => c.metadata?.app === PORTAL_APP && c.metadata?.hash === hash);
    if (hit) return hit;
    if (!page?.has_more || data.length === 0) return null;
    startingAfter = data[data.length - 1].id;
  }
}

/**
 * The id of this app's billing-portal configuration for the current plan prices, created when missing.
 * `pricing` is getPricing()'s object. Throws when it cannot be made: the caller must not open the portal without it.
 *
 * variant 'all' (default): monthly and yearly prices. variant 'yearly': yearly prices only, for a customer who is on a
 * yearly plan, so a shorter interval cannot be chosen at all (a yearly -> monthly change was applied at once in a live
 * test, with the unused year parked as Stripe balance, although the configuration schedules it for the period end).
 */
export async function getOrCreatePortalConfiguration(client, pricing, { variant = 'all' } = {}) {
  if (!PORTAL_VARIANTS.includes(variant)) throw new Error(`Unknown portal variant: ${variant}`);
  const intervals = variant === 'yearly' ? ['year'] : ['month', 'year'];
  const offers = v2Offers(pricing);
  const signature = JSON.stringify(Object.entries(offers.plans).map(([k, p]) => [k, p.monthlyCents, p.yearlyCents, p.credits]));
  const hit = cache.get(variant);
  if (hit && hit.signature === signature && hit.until > Date.now()) return hit.id;

  const current = (await planPrices(pricing)).filter((p) => intervals.includes(p.interval));
  const prices = withinLimit(current, await olderPlanPrices(client, new Set(current.map((p) => p.id)), intervals));
  const hash = hashOf(prices, variant);
  let config = await findOurs(client, hash);
  if (!config) {
    config = await client.billingPortal.configurations.create({
      ...settingsFor(prices),
      metadata: { app: PORTAL_APP, hash, variant },
    });
  }
  cache.set(variant, { signature, id: config.id, until: Date.now() + CACHE_MS });
  return config.id;
}
