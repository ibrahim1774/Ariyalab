import { beforeEach, describe, expect, it, vi } from 'vitest';

// lib/stripePortal.js: two variants of ours. 'all' (monthly and yearly prices) and 'yearly' (yearly prices only, for a yearly subscriber).
const F = vi.hoisted(() => ({ prices: [], configs: [], created: [], listCalls: [], n: 0 }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor() {
      this.prices = {
        list: async (params) => {
          F.listCalls.push(params);
          let pool = F.prices;
          if (params.lookup_keys) pool = pool.filter((p) => params.lookup_keys.includes(p.lookup_key));
          if (params.active !== undefined) pool = pool.filter((p) => p.active === params.active);
          if (params.type === 'recurring') pool = pool.filter((p) => p.recurring);
          const start = params.starting_after ? pool.findIndex((p) => p.id === params.starting_after) + 1 : 0;
          const size = params.limit || 10;
          return { data: pool.slice(start, start + size), has_more: start + size < pool.length };
        },
        create: async (params) => {
          F.n += 1;
          const p = { id: `price_new${F.n}`, active: true, created: 2_000_000_000 + F.n, ...params };
          F.prices.push(p);
          return p;
        },
        update: async () => { throw new Error('prices are never updated here'); },
      };
      this.products = { create: async () => ({ id: `prod_new${++F.n}` }) };
      this.billingPortal = {
        configurations: {
          list: async (params) => {
            const pool = F.configs.filter((c) => c.active === params.active);
            return { data: pool, has_more: false };
          },
          create: async (params) => {
            F.created.push(params);
            const c = { id: `bpc_new${F.created.length}`, active: true, is_default: false, ...params };
            F.configs.push(c);
            return c;
          },
        },
      };
    }
  },
}));
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

const { stripe } = await import('../lib/stripe.js');
const { getOrCreatePortalConfiguration, _resetPortalCache, PORTAL_MAX_PRODUCTS } = await import('../lib/stripePortal.js');


const old = (n, interval, over = {}) => ({
  id: `price_old${n}`,
  active: true,
  product: `prod_old${n}`,
  created: 1_000_000_000 + n,
  lookup_key: `ariya_v2_creator_${interval}_${interval === 'year' ? 40000 + n : 4000 + n}_1500`,
  recurring: { interval },
  ...over,
});
const keysOf = (config) =>
  config.features.subscription_update.products.flatMap((p) => p.prices).map((id) => F.prices.find((x) => x.id === id).lookup_key);
const intervalsOf = (config) => keysOf(config).map((k) => (k.includes('_year_') ? 'year' : 'month'));

beforeEach(() => {
  F.prices = F.prices.filter((p) => !p.id.startsWith('price_old'));
  F.configs.length = 0;
  F.created.length = 0;
  F.listCalls.length = 0;
  _resetPortalCache();
});

describe('portal configuration variants', () => {
  it('the default variant offers monthly and yearly prices', async () => {
    await getOrCreatePortalConfiguration(stripe(), {});
    expect(new Set(intervalsOf(F.created[0]))).toEqual(new Set(['month', 'year']));
    expect(F.created[0].metadata.variant).toBe('all');
  });

  it('the yearly variant offers ONLY yearly prices: three plans, no monthly price at all, older monthly prices left out', async () => {
    F.prices.push(old(1, 'month'), old(2, 'year'));
    await getOrCreatePortalConfiguration(stripe(), {}, { variant: 'yearly' });
    const c = F.created[0];
    expect(intervalsOf(c).every((i) => i === 'year')).toBe(true);
    expect(keysOf(c).filter((k) => k.includes('_year_'))).toHaveLength(4); // 3 current + the older active yearly one
    expect(keysOf(c).some((k) => k.includes('_month_'))).toBe(false);
    expect(c.metadata).toMatchObject({ app: 'ariyalab', variant: 'yearly' });
    expect(c.features.subscription_update.proration_behavior).toBe('always_invoice');
    expect(c.business_profile.headline).toBe('Manage your Sonallo plan');
  });

  it('the two variants are separate configurations (different hashes), each reused by metadata afterwards', async () => {
    const all = await getOrCreatePortalConfiguration(stripe(), {});
    const yearly = await getOrCreatePortalConfiguration(stripe(), {}, { variant: 'yearly' });
    expect(all).not.toBe(yearly);
    expect(F.created).toHaveLength(2);
    expect(F.created[0].metadata.hash).not.toBe(F.created[1].metadata.hash);
    _resetPortalCache();
    expect(await getOrCreatePortalConfiguration(stripe(), {}, { variant: 'yearly' })).toBe(yearly);
    expect(await getOrCreatePortalConfiguration(stripe(), {})).toBe(all);
    expect(F.created).toHaveLength(2);
  });

  it('the cache keeps the variants apart', async () => {
    const all = await getOrCreatePortalConfiguration(stripe(), {});
    const yearly = await getOrCreatePortalConfiguration(stripe(), {}, { variant: 'yearly' });
    expect(await getOrCreatePortalConfiguration(stripe(), {})).toBe(all);
    expect(await getOrCreatePortalConfiguration(stripe(), {}, { variant: 'yearly' })).toBe(yearly);
  });

  it('an unknown variant is refused (never a silent fallback)', async () => {
    await expect(getOrCreatePortalConfiguration(stripe(), {}, { variant: 'weekly' })).rejects.toThrow(/variant/i);
  });

  it('a foreign or default configuration is never selected for either variant', async () => {
    F.configs.push({ id: 'bpc_default', active: true, is_default: true, metadata: {} }, { id: 'bpc_other', active: true, is_default: false, metadata: { app: 'primehub-pro', variant: 'yearly' } });
    const id = await getOrCreatePortalConfiguration(stripe(), {}, { variant: 'yearly' });
    expect(id).toMatch(/^bpc_new/);
  });
});
