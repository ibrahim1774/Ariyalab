import { createHash } from 'node:crypto';
import { getOrCreateV2Price } from './stripe.js';
import { v2Offers } from './pricing.js';
import { PLANS_V2 } from './pricingConstants.js';

/*
 * This app's own Stripe billing-portal configuration.
 *
 * Without a `configuration` Stripe uses the ACCOUNT default portal, and the Stripe account is shared with other
 * products: their default portal offers their prices and applies downgrades at once. So every portal session this app
 * opens names a configuration of its own, found by metadata `app: 'ariyalab'` + a hash of the settings and price ids
 * (a pricing change is a new configuration). Only OUR configurations are ever read back; this file creates and lists,
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
const SETTINGS_VERSION = 2;
const CACHE_MS = 5 * 60 * 1000;

let cache = null; // { signature, id, until }

export function _resetPortalCache() {
  cache = null;
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
      out.push({ id: price.id, product });
    }
  }
  return out;
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

const hashOf = (prices) =>
  createHash('sha256')
    .update(JSON.stringify([SETTINGS_VERSION, prices.map((p) => p.id).sort()]))
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
 */
export async function getOrCreatePortalConfiguration(client, pricing) {
  const offers = v2Offers(pricing);
  const signature = JSON.stringify(Object.entries(offers.plans).map(([k, p]) => [k, p.monthlyCents, p.yearlyCents, p.credits]));
  if (cache && cache.signature === signature && cache.until > Date.now()) return cache.id;

  const prices = await planPrices(pricing);
  const hash = hashOf(prices);
  let config = await findOurs(client, hash);
  if (!config) {
    config = await client.billingPortal.configurations.create({
      ...settingsFor(prices),
      metadata: { app: PORTAL_APP, hash },
    });
  }
  cache = { signature, id: config.id, until: Date.now() + CACHE_MS };
  return config.id;
}
