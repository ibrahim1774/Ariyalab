import { beforeEach, describe, expect, it, vi } from 'vitest';

// lib/stripePortal.js: the configuration also offers the OLDER active ariya_v2_ plan prices subscribers may still be on.
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

const old = (n, over = {}) => ({
  id: `price_old${n}`,
  active: true,
  product: `prod_old${n}`,
  created: 1_000_000_000 + n, // older than every price created in this file
  lookup_key: `ariya_v2_creator_month_${4000 + n}_1500`,
  recurring: { interval: 'month' },
  ...over,
});
const offered = () => F.created.at(-1).features.subscription_update.products.flatMap((p) => p.prices);

beforeEach(() => {
  F.prices = F.prices.filter((p) => !p.id.startsWith('price_old') && !p.id.startsWith('price_x'));
  F.configs.length = 0;
  F.created.length = 0;
  F.listCalls.length = 0;
  _resetPortalCache();
});

describe('older plan prices in the configuration', () => {
  it('an older ACTIVE ariya_v2_ plan price is included, after the current ones', async () => {
    F.prices.push(old(1));
    await getOrCreatePortalConfiguration(stripe(), {});
    const ids = offered();
    expect(ids).toContain('price_old1');
    expect(ids.indexOf('price_old1')).toBeGreaterThanOrEqual(6);
    const products = F.created.at(-1).features.subscription_update.products;
    expect(products.find((p) => p.product === 'prod_old1')).toMatchObject({ prices: ['price_old1'], adjustable_quantity: { enabled: false } });
  });

  it('an archived price is never included; neither are other products\' prices, top-ups or odd keys', async () => {
    F.prices.push(
      old(2, { active: false }),
      old(3, { id: 'price_x_prime', product: 'prod_prime', lookup_key: 'prime_barber_monthly' }),
      old(4, { id: 'price_x_topup', product: 'prod_topup', lookup_key: 'ariya_v2_topup_s_1500_450', recurring: null }),
      old(5, { id: 'price_x_legacy', product: 'prod_legacy', lookup_key: 'ariyalab_pro_v1' })
    );
    await getOrCreatePortalConfiguration(stripe(), {});
    const ids = offered();
    for (const id of ['price_old2', 'price_x_prime', 'price_x_topup', 'price_x_legacy']) expect(ids).not.toContain(id);
    expect(ids).toHaveLength(6);
    expect(F.listCalls.some((p) => p.active === true && p.type === 'recurring')).toBe(true);
  });

  it('over Stripe\'s limit: the six current prices stay, the newest older ones are kept, the oldest dropped, one warning', async () => {
    expect(PORTAL_MAX_PRODUCTS).toBe(10);
    for (let n = 10; n < 16; n += 1) F.prices.push(old(n)); // 6 older + 6 current = 12 products
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getOrCreatePortalConfiguration(stripe(), {});
    const products = F.created.at(-1).features.subscription_update.products;
    expect(products).toHaveLength(10);
    const ids = offered();
    expect(ids.filter((id) => !id.startsWith('price_old'))).toHaveLength(6); // all current kept
    expect(ids).toEqual(expect.arrayContaining(['price_old15', 'price_old14', 'price_old13', 'price_old12']));
    expect(ids).not.toContain('price_old10');
    expect(ids).not.toContain('price_old11');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the settings hash names the final price list: an older price appearing makes a new configuration', async () => {
    await getOrCreatePortalConfiguration(stripe(), {});
    const first = F.created.at(-1).metadata.hash;
    _resetPortalCache();
    F.prices.push(old(20));
    await getOrCreatePortalConfiguration(stripe(), {});
    expect(F.created).toHaveLength(2);
    expect(F.created.at(-1).metadata.hash).not.toBe(first);
    // and with the same list, the same hash is found again (nothing new is created)
    _resetPortalCache();
    await getOrCreatePortalConfiguration(stripe(), {});
    expect(F.created).toHaveLength(2);
  });

  it('pages through the price list', async () => {
    for (let n = 100; n < 230; n += 1) F.prices.push({ id: `price_x_other${n}`, active: true, product: `prod_x${n}`, created: 1, lookup_key: `prime_${n}`, recurring: { interval: 'month' } });
    F.prices.push(old(40));
    await getOrCreatePortalConfiguration(stripe(), {});
    expect(offered()).toContain('price_old40');
    expect(F.listCalls.filter((p) => p.type === 'recurring').length).toBeGreaterThan(1);
  });
});
