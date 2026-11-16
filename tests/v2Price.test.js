import { beforeEach, describe, expect, it, vi } from 'vitest';

// getOrCreateV2Price (lib/stripe.js) against a fake Stripe client: an archived price with the key is
// reactivated, and a racing first click that loses the create reads the winner's price. Never live.
const F = vi.hoisted(() => ({ prices: [], creates: 0, failCreate: null, updates: [] }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor() {
      this.prices = {
        list: async ({ lookup_keys: keys }) => ({ data: F.prices.filter((p) => keys.includes(p.lookup_key)) }),
        create: async (params) => {
          F.creates += 1;
          if (F.failCreate) {
            const winner = F.failCreate;
            F.failCreate = null;
            F.prices.push(winner);
            throw new Error('A price with this lookup_key already exists.');
          }
          const p = { id: `price_${F.prices.length + 1}`, active: true, ...params };
          F.prices.push(p);
          return p;
        },
        update: async (id, { active }) => {
          F.updates.push(id);
          const p = F.prices.find((x) => x.id === id);
          p.active = active;
          return p;
        },
      };
      this.products = { create: async () => ({ id: 'prod_1' }) };
    }
  },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
const { getOrCreateV2Price, v2PlanLookupKey } = await import('../lib/stripe.js');

beforeEach(() => {
  F.prices.length = 0;
  F.creates = 0;
  F.updates.length = 0;
});

describe('getOrCreateV2Price', () => {
  it('reactivates an archived price with the same key instead of creating a second one', async () => {
    const offer = { kind: 'plan', plan: 'creator', interval: 'month', amountCents: 4901, credits: 2600 };
    F.prices.push({ id: 'price_old', active: false, lookup_key: v2PlanLookupKey(offer) });
    const p = await getOrCreateV2Price(offer);
    expect(p.id).toBe('price_old');
    expect(F.updates).toEqual(['price_old']);
    expect(F.creates).toBe(0);
  });

  it('a create that loses the race returns the price the other request created', async () => {
    const offer = { kind: 'plan', plan: 'studio', interval: 'year', amountCents: 118801, credits: 5400 };
    F.failCreate = { id: 'price_winner', active: true, lookup_key: v2PlanLookupKey(offer) };
    const p = await getOrCreateV2Price(offer);
    expect(p.id).toBe('price_winner');
  });
});
