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
      plan: 'creator', interval: 'month', legacy: false, status: 'active', renewsAt: new Date(1795000000 * 1000).toISOString(), endsAt: null,
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

  it('ignores ended subscriptions and other products\' prices', async () => {
    S.subs = [sub({ status: 'canceled' }), sub({}, 'prime_barber_monthly')];
    expect(await currentPlanFor('u1')).toBeNull();
  });

  it('a legacy plan is returned too, marked legacy', async () => {
    S.subs = [sub({}, 'ariyalab_pro_v1')];
    expect(await currentPlanFor('u1')).toMatchObject({ plan: 'pro', interval: 'month', legacy: true });
  });

  it('a v2 plan wins over a legacy one when both are live', async () => {
    S.subs = [sub({}, 'ariyalab_pro_v1'), sub()];
    expect(await currentPlanFor('u1')).toMatchObject({ plan: 'creator', legacy: false });
  });

  it('past_due keeps its status so the page can say the payment failed', async () => {
    S.subs = [sub({ status: 'past_due' })];
    expect((await currentPlanFor('u1')).status).toBe('past_due');
  });

  it('fresh skips the cache and refreshes it (a change made in the portal shows at once)', async () => {
    vi.useFakeTimers();
    try {
      S.subs = [sub()];
      expect((await currentPlanFor('u1')).endsAt).toBeNull();
      S.subs = [sub({ cancel_at_period_end: true })];
      await vi.advanceTimersByTimeAsync(5000);
      expect((await currentPlanFor('u1')).endsAt).toBeNull(); // a normal read: still the cached one
      expect((await currentPlanFor('u1', { fresh: true })).endsAt).not.toBeNull();
      expect(S.lists).toBe(2);
      expect((await currentPlanFor('u1')).endsAt).not.toBeNull(); // the cache now holds the fresh read
      expect(S.lists).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a forced fresh read is limited to one per user every 5 seconds; inside the window it is served from the cache', async () => {
    vi.useFakeTimers();
    try {
      S.subs = [sub()];
      await currentPlanFor('u1', { fresh: true });
      expect(S.lists).toBe(1);
      S.subs = [sub({ cancel_at_period_end: true })];
      await vi.advanceTimersByTimeAsync(4000);
      expect((await currentPlanFor('u1', { fresh: true })).endsAt).toBeNull();
      expect(S.lists).toBe(1);
      await currentPlanFor('u2', { fresh: true }); // another user is not held back
      expect(S.lists).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await currentPlanFor('u1', { fresh: true })).endsAt).not.toBeNull();
      expect(S.lists).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the cache is capped at 500 users, oldest dropped', async () => {
    S.subs = [sub()];
    for (let i = 0; i < 501; i += 1) await currentPlanFor(`user-${i}`);
    expect(S.lists).toBe(501);
    await currentPlanFor('user-500'); // newest: still cached
    expect(S.lists).toBe(501);
    await currentPlanFor('user-0'); // oldest: dropped, read again
    expect(S.lists).toBe(502);
  });

  it('is cached per user: the second read makes no Stripe call', async () => {
    S.subs = [sub()];
    await currentPlanFor('u1');
    await currentPlanFor('u1');
    expect(S.lists).toBe(1);
  });

  it('a Stripe failure throws (the caller says the plan is unknown), logs, and is not cached', async () => {
    S.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(currentPlanFor('u1')).rejects.toThrow('stripe is down');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    S.fail = false;
    S.subs = [sub()];
    expect(await currentPlanFor('u1')).toMatchObject({ plan: 'creator' });
  });
});
