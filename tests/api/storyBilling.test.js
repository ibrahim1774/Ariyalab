import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock';

let signedIn = true;
let v2 = true;
let rows = [];
const ledgerCalls = [];

// Minimal PostgREST-style query builder over `rows` that really applies eq/neq/order/limit.
function ledgerQuery() {
  let out = rows.slice();
  const q = {
    select: () => q,
    eq: (col, val) => { ledgerCalls.push(['eq', col, val]); out = out.filter((r) => r[col] === val); return q; },
    neq: (col, val) => { ledgerCalls.push(['neq', col, val]); out = out.filter((r) => r[col] !== val); return q; },
    order: (col, { ascending }) => { out.sort((a, b) => (a[col] < b[col] ? 1 : -1) * (ascending ? -1 : 1)); return q; },
    limit: (n) => { out = out.slice(0, n); return q; },
    then: (resolve) => resolve({ data: out, error: null }),
  };
  return q;
}

vi.mock('../../lib/supabaseServer.js', () => ({
  getUserFromRequest: async () => (signedIn ? { user: { id: 'u1', email: 'a@example.test' }, supabase: {} } : null),
  getSupabaseAdmin: () => ({ from: (t) => { if (t !== 'credit_ledger') throw new Error(t); return ledgerQuery(); } }),
}));
vi.mock('../../lib/billingFlags.js', () => ({ isBillingV2: async () => v2 }));
vi.mock('../../lib/credits.js', () => ({ getBalance: async () => ({ plan: 100, topup: 40, held: 10, available: 130 }) }));
vi.mock('../../lib/entitlement.js', () => ({ getEntitlement: async () => ({ creditsRemaining: 7 }) }));

import { PLANS, TOPUPS } from '../../lib/stripe.js';
const handler = (await import('../../pages/api/story/billing.js')).default;

const row = (over) => ({ user_id: 'u1', currency: 'video', delta: 5, reason: 'topup', balance_after: 5, created_at: '2026-11-01T00:00:00Z', ...over });

beforeEach(() => {
  signedIn = true;
  v2 = true;
  ledgerCalls.length = 0;
  rows = [];
});

describe('GET /api/story/billing', () => {
  it('returns 401 without a session', async () => {
    signedIn = false;
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('leaves zero-delta rows out and lists newest first', async () => {
    rows = [
      row({ delta: 1500, reason: 'plan_renewal', created_at: '2026-11-01T00:00:00Z' }),
      row({ delta: 0, reason: 'release', created_at: '2026-11-02T00:00:00Z' }),
      row({ delta: -90, reason: 'project-fee', created_at: '2026-11-03T00:00:00Z' }),
      row({ user_id: 'someone-else', delta: 9, created_at: '2026-11-04T00:00:00Z' }),
    ];
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.v2).toBe(true);
    expect(res.body.balance).toEqual({ plan: 100, topup: 40, held: 10, available: 130 });
    expect(res.body.history.map((r) => r.delta)).toEqual([-90, 1500]);
    expect(ledgerCalls).toContainEqual(['neq', 'delta', 0]);
  });

  it('caps history at 50 rows', async () => {
    rows = Array.from({ length: 80 }, (_, i) => row({ delta: i + 1, created_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }));
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.body.history).toHaveLength(50);
  });

  it('falls back to the single entitlement number when billing v2 is off', async () => {
    v2 = false;
    rows = [row()];
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.body).toMatchObject({ v2: false, balance: { plan: null, topup: null, held: 0, available: 7 }, history: [] });
    for (const [k, p] of Object.entries(PLANS)) {
      expect(res.body.offers.plans[k]).toEqual({ usd: p.amountCents / 100, credits: p.cap, interval: p.interval });
    }
    for (const [k, t] of Object.entries(TOPUPS).filter(([, x]) => x.kind === 'video')) {
      expect(res.body.offers.topups[k]).toEqual({ usd: t.amountCents / 100, credits: t.credits });
    }
    expect(Object.keys(res.body.offers.topups).sort()).toEqual(['l', 'm', 's']);
  });
});
