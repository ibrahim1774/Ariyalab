import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/apiMock';

// /api/billing/portal: a portal session for the signed-in buyer's own Stripe customer. Stripe is a stub.
const S = vi.hoisted(() => ({ user: null, created: [], v2: false, v2Throws: false, configFails: false, configCalls: 0, variants: [], plan: null, planImpl: null, planCalls: [] }));
vi.mock('../../lib/stripe', async (importOriginal) => ({
  ...(await importOriginal()),
  stripe: () => ({
    billingPortal: {
      sessions: {
        create: async (params) => {
          S.created.push(params);
          return { url: `https://billing.stripe.test/${params.customer}` };
        },
      },
    },
  }),
}));
vi.mock('../../lib/billingFlags', () => ({
  isBillingV2Strict: async () => {
    if (S.v2Throws) throw new Error('pricing config unreadable');
    return S.v2;
  },
}));
vi.mock('../../lib/pricing', () => ({ getPricing: async () => ({}) }));
vi.mock('../../lib/currentPlan', () => ({
  currentPlanFor: (userId, opts) => {
    S.planCalls.push(opts || {});
    return S.planImpl ? S.planImpl() : Promise.resolve(S.plan);
  },
}));
vi.mock('../../lib/stripePortal', () => ({
  getOrCreatePortalConfiguration: async (_client, _pricing, opts) => {
    S.configCalls += 1;
    S.variants.push(opts?.variant);
    if (S.configFails) throw new Error('stripe is down');
    return 'bpc_ariya';
  },
}));
vi.mock('../../lib/supabaseServer', () => ({
  getUserFromRequest: async () => (S.user ? { user: S.user, supabase: {} } : null),
  getSupabaseAdmin: () => {
    throw new Error('no live database in tests');
  },
}));

import { setGrantsDb } from '../../lib/grants.js';
import portal from '../../pages/api/billing/portal.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  setGrantsDb(db);
  await db.query(`insert into public.profiles (id, stripe_customer_id) values ('00000000-0000-4000-8000-0000000000a1', 'cus_mine')`);
}, 60_000);
afterAll(async () => {
  setGrantsDb(null);
  await db?.close();
});
beforeEach(() => {
  S.user = null;
  S.created.length = 0;
  S.v2 = false;
  S.v2Throws = false;
  S.configFails = false;
  S.configCalls = 0;
  S.variants = [];
  S.plan = null;
  S.planImpl = null;
  S.planCalls = [];
  vi.stubEnv('APP_URL', 'https://ariyalab.test');
});

describe('/api/billing/portal', () => {
  it('opens the portal for the buyer\'s own customer, never one named in the request', async () => {
    S.user = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@example.test' };
    const res = makeRes();
    await portal(makeReq({ method: 'POST', body: { customer: 'cus_someone_else' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBe('https://billing.stripe.test/cus_mine');
    expect(S.created).toEqual([{ customer: 'cus_mine', return_url: 'https://ariyalab.test/app/billing?from=portal' }]);
  });

  it('R4: the return URL never comes from the Host header; production without APP_URL answers 500', async () => {
    S.user = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@example.test' };
    let res = makeRes();
    await portal(makeReq({ method: 'POST', headers: { host: 'evil.example' } }), res);
    expect(S.created.at(-1).return_url).toBe('https://ariyalab.test/app/billing?from=portal');
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    S.created.length = 0;
    res = makeRes();
    await portal(makeReq({ method: 'POST', headers: { host: 'evil.example' } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("We couldn't open billing. Please try again in a moment.");
    expect(S.created).toHaveLength(0);
    vi.stubEnv('NODE_ENV', 'test');
    res = makeRes();
    await portal(makeReq({ method: 'POST', headers: { host: 'evil.example' } }), res);
    expect(S.created.at(-1).return_url).toBe('http://localhost:3000/app/billing?from=portal');
    vi.unstubAllEnvs();
  });

  it('401 signed out, 404 without a customer, 405 on GET', async () => {
    let res = makeRes();
    await portal(makeReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(401);
    S.user = { id: '00000000-0000-4000-8000-0000000000b2', email: 'b@example.test' };
    res = makeRes();
    await portal(makeReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(404);
    res = makeRes();
    await portal(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
    expect(S.created).toHaveLength(0);
  });

  describe('billing v2', () => {
    const buyer = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@example.test' };

    it('the portal session carries our configuration', async () => {
      S.v2 = true;
      S.user = buyer;
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(S.created).toEqual([{ customer: 'cus_mine', return_url: 'https://ariyalab.test/app/billing?from=portal', configuration: 'bpc_ariya' }]);
    });

    const planOf = (over) => ({ plan: 'studio', interval: 'month', legacy: false, status: 'active', renewsAt: null, endsAt: null, ...over });

    it('a customer on a yearly Ariya plan gets the yearly-only configuration', async () => {
      S.v2 = true;
      S.user = buyer;
      S.plan = planOf({ interval: 'year' });
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(S.variants).toEqual(['yearly']);
      expect(S.planCalls).toEqual([{ fresh: true }]);
    });

    it.each([
      ['a monthly plan', () => { S.plan = planOf(); }],
      ['no plan', () => { S.plan = null; }],
      ['a legacy plan, even a yearly one', () => { S.plan = planOf({ plan: 'yearly', interval: 'year', legacy: true }); }],
    ])('%s gets the monthly-and-yearly configuration', async (_name, setup) => {
      S.v2 = true;
      S.user = buyer;
      setup();
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(S.variants).toEqual(['all']);
    });

    it('an unknown plan is retried once: fails once, then a yearly plan -> the yearly-only configuration', async () => {
      S.v2 = true;
      S.user = buyer;
      let n = 0;
      S.planImpl = () => (++n === 1 ? Promise.reject(new Error('stripe is down')) : Promise.resolve(planOf({ interval: 'year' })));
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(S.planCalls).toEqual([{ fresh: true }, { fresh: true }]);
      expect(S.variants).toEqual(['yearly']);
    });

    it('fails once, then a monthly plan -> the full configuration', async () => {
      S.v2 = true;
      S.user = buyer;
      let n = 0;
      S.planImpl = () => (++n === 1 ? Promise.reject(new Error('stripe is down')) : Promise.resolve(planOf()));
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(S.variants).toEqual(['all']);
    });

    it('the plan stays unknown after the retry: no portal session at all (never the full configuration), the plain line, the cause logged', async () => {
      S.v2 = true;
      S.user = buyer;
      S.planImpl = () => Promise.reject(new Error('stripe is down'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe("We couldn't open billing. Please try again in a moment.");
      expect(S.created).toHaveLength(0);
      expect(S.configCalls).toBe(0);
      expect(S.planCalls).toHaveLength(2);
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });

    it('a lookup that never answers is cut at 3 seconds, retried once, then the plain line and no session', async () => {
      vi.useFakeTimers();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        S.v2 = true;
        S.user = buyer;
        S.planImpl = () => new Promise(() => {});
        const res = makeRes();
        const done = portal(makeReq({ method: 'POST' }), res);
        await vi.advanceTimersByTimeAsync(6200);
        await done;
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("We couldn't open billing. Please try again in a moment.");
        expect(S.created).toHaveLength(0);
        expect(S.planCalls).toHaveLength(2);
      } finally {
        err.mockRestore();
        vi.useRealTimers();
      }
    });

    it('v2 off: no configuration is made or passed (today\'s behaviour), no plan lookup', async () => {
      S.user = buyer;
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(S.configCalls).toBe(0);
      expect(S.planCalls).toHaveLength(0);
      expect(S.created[0]).not.toHaveProperty('configuration');
    });

    it('when the configuration cannot be made the plain line is answered and no portal opens (never the account default)', async () => {
      S.v2 = true;
      S.configFails = true;
      S.user = buyer;
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe("We couldn't open billing. Please try again in a moment.");
      expect(S.created).toHaveLength(0);
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });

    it('when the billing flag cannot be read the plain line is answered and no portal opens', async () => {
      S.v2Throws = true;
      S.user = buyer;
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = makeRes();
      await portal(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe("We couldn't open billing. Please try again in a moment.");
      expect(S.created).toHaveLength(0);
      err.mockRestore();
    });
  });
});
