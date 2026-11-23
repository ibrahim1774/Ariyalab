import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock';

let signedIn = true;
let ent = { tier: 'monthly', creditsRemaining: 10 };
let entFails = false;
let planImpl = null;
const planCalls = [];

vi.mock('../../lib/supabaseServer', () => ({
  getUserFromRequest: async () => (signedIn ? { user: { id: 'u1', email: 'a@example.test' }, supabase: {} } : null),
}));
vi.mock('../../lib/entitlement', () => ({
  getEntitlement: async () => {
    if (entFails) throw new Error('boom');
    return ent;
  },
}));
vi.mock('../../lib/currentPlan.js', () => ({
  currentPlanFor: (userId, opts) => {
    planCalls.push([userId, opts]);
    return planImpl();
  },
}));

const handler = (await import('../../pages/api/entitlement.js')).default;

const get = async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  return res;
};

beforeEach(() => {
  signedIn = true;
  ent = { tier: 'monthly', creditsRemaining: 10 };
  entFails = false;
  planCalls.length = 0;
  planImpl = async () => null;
});
afterEach(() => vi.useRealTimers());

describe('GET /api/entitlement legacyPlan', () => {
  it('is true for a customer on an old (legacy) plan, and keeps the rest of the entitlement', async () => {
    planImpl = async () => ({ plan: 'monthly', interval: 'month', legacy: true, status: 'active' });
    const res = await get();
    expect(res.body.legacyPlan).toBe(true);
    expect(res.body.tier).toBe('monthly');
    expect(res.body.creditsRemaining).toBe(10);
    expect(planCalls).toEqual([['u1', undefined]]);
  });

  it('is false for a v2 plan', async () => {
    planImpl = async () => ({ plan: 'creator', interval: 'month', legacy: false, status: 'active' });
    expect((await get()).body.legacyPlan).toBe(false);
  });

  it('is false with no plan', async () => {
    planImpl = async () => null;
    expect((await get()).body.legacyPlan).toBe(false);
  });

  it('is false for an admin, without asking Stripe', async () => {
    ent = { tier: 'admin', isAdmin: true };
    planImpl = async () => ({ legacy: true });
    const res = await get();
    expect(res.body.legacyPlan).toBe(false);
    expect(planCalls).toHaveLength(0);
  });

  it('is false when the plan lookup fails', async () => {
    planImpl = async () => { throw new Error('stripe down'); };
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body.legacyPlan).toBe(false);
    expect(res.body.tier).toBe('monthly');
  });

  it('is false when the plan lookup is slower than 3 seconds', async () => {
    vi.useFakeTimers();
    planImpl = () => new Promise(() => {});
    const pending = get();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).body.legacyPlan).toBe(false);
  });

  it('is false for a signed-out visitor and when the entitlement itself fails', async () => {
    signedIn = false;
    expect((await get()).body.legacyPlan).toBe(false);
    signedIn = true;
    entFails = true;
    const res = await get();
    expect(res.body.legacyPlan).toBe(false);
    expect(planCalls).toHaveLength(0);
  });
});
