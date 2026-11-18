import { beforeEach, describe, expect, it, vi } from 'vitest';

// lib/currentPlan.js: the buyer's current v2 plan from their own Stripe customer, cached. Stripe is a stub.
const S = vi.hoisted(() => ({ customer: 'cus_1', subs: [], lists: 0, fail: false }));
vi.mock('../lib/stripe.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stripe: () => ({
    subscriptions: {
      list: async () => {
        S.lists += 1;
        if (S.fail) throw new Error('stripe is down');
        return { data: S.subs };
      },
    },
  }),
}));
vi.mock('../lib/grants.js', () => ({ customerForUser: async () => S.customer }));

const { currentPlanFor, _resetPlanCache } = await import('../lib/currentPlan.js');
const { v2PlanLookupKey } = await import('../lib/stripe.js');

const sub = (over = {}, lookup = v2PlanLookupKey({ plan: 'creator', interval: 'month', amountCents: 4900, credits: 1500 })) => ({
  id: 'sub_1',
  status: 'active',
  current_period_end: 1795000000,
  cancel_at_period_end: false,
  cancel_at: null,
  items: { data: [{ price: { id: 'price_1', lookup_key: lookup } }] },
  ...over,
});

beforeEach(() => {
  S.customer = 'cus_1';
  S.subs = [];
  S.lists = 0;
  S.fail = false;
  _resetPlanCache();
});

describe('currentPlanFor', () => {
  it('no customer or no plan: null', async () => {
    S.customer = null;
    expect(await currentPlanFor('u1')).toBeNull();
    S.customer = 'cus_1';
    expect(await currentPlanFor('u2')).toBeNull();
  });

  it('a monthly plan: name, interval, renewal date, no end date', async () => {
    S.subs = [sub()];
    expect(await currentPlanFor('u1')).toEqual({
      plan: 'creator', interval: 'month', status: 'active', renewsAt: new Date(1795000000 * 1000).toISOString(), endsAt: null,
    });
  });

  it('a yearly plan', async () => {
    S.subs = [sub({}, v2PlanLookupKey({ plan: 'studio', interval: 'year', amountCents: 100980, credits: 3100 }))];
    expect(await currentPlanFor('u1')).toMatchObject({ plan: 'studio', interval: 'year' });
  });

  it('cancellation at period end pending: endsAt is the period end', async () => {
    S.subs = [sub({ cancel_at_period_end: true })];
    const p = await currentPlanFor('u1');
    expect(p.endsAt).toBe(new Date(1795000000 * 1000).toISOString());
  });

  it('a cancel_at date is the end date', async () => {
    S.subs = [sub({ cancel_at: 1796000000 })];
    expect((await currentPlanFor('u1')).endsAt).toBe(new Date(1796000000 * 1000).toISOString());
  });

  it('ignores ended subscriptions, other products\' prices and legacy plans', async () => {
    S.subs = [
      sub({ status: 'canceled' }),
      sub({}, 'prime_barber_monthly'),
      sub({}, 'ariyalab_monthly_v1'),
    ];
    expect(await currentPlanFor('u1')).toBeNull();
  });

  it('is cached per user: the second read makes no Stripe call', async () => {
    S.subs = [sub()];
    await currentPlanFor('u1');
    await currentPlanFor('u1');
    expect(S.lists).toBe(1);
  });

  it('a Stripe failure answers null (the page shows no plan), logs, and is not cached', async () => {
    S.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await currentPlanFor('u1')).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    S.fail = false;
    S.subs = [sub()];
    expect(await currentPlanFor('u1')).toMatchObject({ plan: 'creator' });
  });
});
