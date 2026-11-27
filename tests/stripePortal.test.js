import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// lib/stripePortal.js against a fake Stripe client. Never live.
const F = vi.hoisted(() => ({ prices: [], configs: [], created: [], listCalls: [], updates: 0, pageSize: 2, failCreate: false }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor() {
      this.prices = {
        list: async ({ lookup_keys: keys, active, type }) => {
          let pool = F.prices;
          if (keys) pool = pool.filter((p) => keys.includes(p.lookup_key));
          if (active !== undefined) pool = pool.filter((p) => p.active === active);
          if (type === 'recurring') pool = pool.filter((p) => p.recurring);
          return { data: pool, has_more: false };
        },
        create: async (params) => {
          const p = { id: `price_${F.prices.length + 1}`, active: true, ...params };
          F.prices.push(p);
          return p;
        },
        update: async () => { F.updates += 1; },
      };
      this.products = { create: async () => ({ id: `prod_${F.prices.length + 1}` }) };
      this.billingPortal = {
        configurations: {
          list: async (params) => {
            F.listCalls.push(params);
            const pool = F.configs.filter((c) => (params.active === undefined ? true : c.active === params.active));
            const start = params.starting_after ? pool.findIndex((c) => c.id === params.starting_after) + 1 : 0;
            const data = pool.slice(start, start + F.pageSize);
            return { data, has_more: start + F.pageSize < pool.length };
          },
          create: async (params) => {
            if (F.failCreate) throw new Error('stripe is down');
            F.created.push(params);
            const c = { id: `bpc_new${F.created.length}`, active: true, is_default: false, ...params };
            F.configs.push(c);
            return c;
          },
          update: async () => { F.updates += 1; },
        },
      };
    }
  },
}));
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

const { stripe } = await import('../lib/stripe.js');
const { getOrCreatePortalConfiguration, _resetPortalCache } = await import('../lib/stripePortal.js');
const { getOrCreateV2Price } = await import('../lib/stripe.js');

beforeEach(() => {
  F.configs.length = 0;
  F.created.length = 0;
  F.listCalls.length = 0;
  F.updates = 0;
  F.failCreate = false;
  _resetPortalCache();
});

const foreign = (over) => ({ id: 'bpc_prime', active: true, is_default: true, metadata: {}, business_profile: { headline: 'Manage your Prime Barber plan' }, ...over });

describe('getOrCreatePortalConfiguration', () => {
  it('creates our own configuration when none exists, with the exact rules', async () => {
    const id = await getOrCreatePortalConfiguration(stripe(), {});
    expect(id).toBe('bpc_new1');
    const c = F.created[0];
    expect(c.business_profile.headline).toBe('Manage your Sonallo plan');
    expect(c.metadata.app).toBe('ariyalab');
    expect(c.metadata.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(c.features.payment_method_update).toEqual({ enabled: true });
    expect(c.features.invoice_history).toEqual({ enabled: true });
    expect(c.features.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end' });
    const up = c.features.subscription_update;
    expect(up.enabled).toBe(true);
    expect(up.default_allowed_updates).toEqual(['price']);
    expect(up.proration_behavior).toBe('always_invoice');
    expect(up.schedule_at_period_end.conditions).toEqual([{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }]);
  });

  it('offers only the v2 plan prices: every plan, monthly and yearly, nothing else', async () => {
    F.prices.push({ id: 'price_other', active: true, lookup_key: 'prime_barber_monthly', product: 'prod_prime', recurring: { interval: 'month' } });
    await getOrCreatePortalConfiguration(stripe(), {});
    const products = F.created[0].features.subscription_update.products;
    const priceIds = products.flatMap((p) => p.prices);
    expect(priceIds).toHaveLength(6);
    expect(priceIds).not.toContain('price_other');
    const keys = priceIds.map((id) => F.prices.find((p) => p.id === id).lookup_key);
    expect(keys.every((k) => k.startsWith('ariya_v2_'))).toBe(true);
    expect(keys.filter((k) => k.includes('_month_'))).toHaveLength(3);
    expect(keys.filter((k) => k.includes('_year_'))).toHaveLength(3);
    for (const p of products) {
      expect(typeof p.product).toBe('string');
      // Stripe's default is a quantity the customer may raise: one plan, quantity 1, only.
      expect(p.adjustable_quantity).toEqual({ enabled: false });
    }
  });

  it('reuses ours when it already exists, and creates nothing', async () => {
    const first = await getOrCreatePortalConfiguration(stripe(), {});
    _resetPortalCache();
    const again = await getOrCreatePortalConfiguration(stripe(), {});
    expect(again).toBe(first);
    expect(F.created).toHaveLength(1);
  });

  it('pages through the list to find ours, active only', async () => {
    const first = await getOrCreatePortalConfiguration(stripe(), {});
    const ours = F.configs.find((c) => c.id === first);
    F.configs.length = 0;
    F.configs.push(foreign({ id: 'bpc_1' }), foreign({ id: 'bpc_2', is_default: false }), foreign({ id: 'bpc_3', is_default: false }), ours);
    F.created.length = 0;
    F.listCalls.length = 0;
    _resetPortalCache();
    expect(await getOrCreatePortalConfiguration(stripe(), {})).toBe(first);
    expect(F.listCalls.length).toBeGreaterThan(1);
    expect(F.listCalls.every((p) => p.active === true)).toBe(true);
    expect(F.created).toHaveLength(0);
  });

  it('never touches the default or a foreign configuration, even one that looks like ours', async () => {
    F.configs.push(
      foreign(),
      foreign({ id: 'bpc_lookalike', is_default: false, metadata: { app: 'ariyalab' } }), // our app, but another settings hash
      foreign({ id: 'bpc_othercase', is_default: false, metadata: { app: 'haelabs', hash: 'x' } })
    );
    const id = await getOrCreatePortalConfiguration(stripe(), {});
    expect(id).toBe('bpc_new1');
    expect(F.updates).toBe(0);
    expect(F.configs.filter((c) => c.id.startsWith('bpc_new'))).toHaveLength(1);
  });

  it('a pricing change makes a new configuration (the hash names the price ids)', async () => {
    const a = await getOrCreatePortalConfiguration(stripe(), {});
    _resetPortalCache();
    const b = await getOrCreatePortalConfiguration(stripe(), { plans: { creator: { usd: 55, credits: 1700 } } });
    expect(b).not.toBe(a);
    expect(F.created).toHaveLength(2);
    expect(F.created[0].metadata.hash).not.toBe(F.created[1].metadata.hash);
  });

  it('caches the id in memory for the next call', async () => {
    await getOrCreatePortalConfiguration(stripe(), {});
    F.listCalls.length = 0;
    await getOrCreatePortalConfiguration(stripe(), {});
    expect(F.listCalls).toHaveLength(0);
  });

  it('throws when the configuration cannot be made (the caller must not fall back to the default)', async () => {
    F.failCreate = true;
    await expect(getOrCreatePortalConfiguration(stripe(), {})).rejects.toThrow('stripe is down');
  });

  it('prices exist first: the plan prices are created through getOrCreateV2Price', async () => {
    await getOrCreatePortalConfiguration(stripe(), {});
    const ids = F.created[0].features.subscription_update.products.flatMap((p) => p.prices);
    for (const id of ids) expect(F.prices.find((p) => p.id === id)?.lookup_key).toMatch(/^ariya_v2_/);
    expect(await getOrCreateV2Price({ kind: 'plan', plan: 'creator', interval: 'month', amountCents: 4900, credits: 1500 })).toBeTruthy();
  });
});
