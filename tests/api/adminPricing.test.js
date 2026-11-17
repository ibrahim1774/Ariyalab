// The admin pricing editor (pages/api/admin/pricing.js): admins only, checked
// writes to pricing_config, the billing_v2 switch, and the owner's readouts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/apiMock';

const S = vi.hoisted(() => ({ user: null }));
vi.mock('../../lib/supabaseServer', () => ({
  getUserFromRequest: async () => (S.user ? { user: S.user, supabase: {} } : null),
  getSupabaseAdmin: () => {
    throw new Error('no live database in tests');
  },
}));

import { setPricingDb, _resetPricingCache, getPricing } from '../../lib/pricing.js';
import { isBillingV2 } from '../../lib/billingFlags.js';
import { pricingReadout, validatePricingWrite } from '../../lib/adminPricing.js';
import { DEFAULTS, PROVIDER_COSTS_USD } from '../../lib/pricingConstants.js';
import pricingRoute from '../../pages/api/admin/pricing.js';

const ADMIN = { id: 'admin-1', email: 'owner@example.test', email_confirmed_at: '2026-11-01T00:00:00Z' };
const UNCONFIRMED_ADMIN = { id: 'admin-2', email: 'owner@example.test' };
const CUSTOMER = { id: 'user-1', email: 'someone@example.test', email_confirmed_at: '2026-11-01T00:00:00Z' };

let db;
beforeAll(async () => {
  db = await createTestDb();
  setPricingDb(db);
}, 60_000);
afterAll(async () => {
  setPricingDb(null);
  await db?.close();
});
beforeEach(async () => {
  vi.stubEnv('ADMIN_EMAILS', 'owner@example.test');
  S.user = null;
  await db.query('delete from public.pricing_config');
  _resetPricingCache();
});

const call = async (user, req) => {
  S.user = user;
  const res = makeRes();
  await pricingRoute(makeReq(req), res);
  return res;
};

describe('admin pricing routes reject non-admins', () => {
  it('401 signed out, 403 for a customer or an unconfirmed admin email, 503 when ADMIN_EMAILS is unset', async () => {
    expect((await call(null, { method: 'GET' })).statusCode).toBe(401);
    expect((await call(CUSTOMER, { method: 'GET' })).statusCode).toBe(403);
    expect((await call(UNCONFIRMED_ADMIN, { method: 'GET' })).statusCode).toBe(403);
    const write = await call(CUSTOMER, { method: 'POST', body: { key: 'billing_v2', value: true, confirm: 'billing_v2' } });
    expect(write.statusCode).toBe(403);
    expect(await isBillingV2()).toBe(false);
    vi.stubEnv('ADMIN_EMAILS', '');
    expect((await call(ADMIN, { method: 'GET' })).statusCode).toBe(503);
  });
});

describe('admin pricing editor', () => {
  it('GET shows the config, cost per credit and margins per quality', async () => {
    const res = await call(ADMIN, { method: 'GET' });
    expect(res.statusCode).toBe(200);
    expect(res.body.billingV2).toBe(false);
    expect(res.body.readout.plans.studio.usdPerCredit).toBeCloseTo(99 / 3100, 8);
    const m = res.body.readout.margins.standard;
    expect(m.providerUsdPerSecond).toBe(PROVIDER_COSTS_USD.perSecond.standard);
    expect(m.marginLow).toBeCloseTo(1 - 0.05 / (8 * ((99 * 0.85) / 3100)), 6);
    expect(res.body.readout.drift).toEqual([]);
  });

  it('POST writes a checked value, the next read uses it, and drift from the homepage defaults is flagged', async () => {
    const res = await call(ADMIN, { method: 'POST', body: { key: 'plans', value: { creator: { usd: 59, credits: 3000 } } } });
    expect(res.statusCode).toBe(200);
    expect((await getPricing()).plans.creator).toEqual({ usd: 59, credits: 3000 });
    expect(res.body.readout.plans.creator).toMatchObject({ usd: 59, credits: 3000, monthlyCents: 5900 });
    expect(res.body.readout.drift).toEqual(['plans']);
    expect(res.body.rows).toEqual([{ key: 'plans', value: { creator: { usd: 59, credits: 3000 } } }]);
  });

  it('refuses unknown keys and bad values', async () => {
    const bad = [
      { key: 'relink_mode', value: 'auto' },
      { key: 'plans', value: { gold: { usd: 1, credits: 1 } } },
      { key: 'plans', value: { creator: { usd: -5 } } },
      { key: 'plans', value: { creator: { usd: 4.999 } } },
      { key: 'topups', value: { s: { credits: 0.5 } } },
      { key: 'perSecond', value: { economy: 0 } },
      { key: 'yearlyDiscount', value: 0.95 },
      { key: 'retentionDays', value: 0 },
      { key: 'billing_v2', value: 'yes' },
    ];
    for (const body of bad) {
      const res = await call(ADMIN, { method: 'POST', body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const { rows } = await db.query('select count(*)::int as n from public.pricing_config');
    expect(rows[0].n).toBe(0);
    expect(validatePricingWrite('yearlyDiscount', 0.2)).toBeNull();
  });

  it('turning billing_v2 on needs an explicit confirm; turning it off does not', async () => {
    let res = await call(ADMIN, { method: 'POST', body: { key: 'billing_v2', value: true } });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('CONFIRM_REQUIRED');
    expect(await isBillingV2()).toBe(false);
    res = await call(ADMIN, { method: 'POST', body: { key: 'billing_v2', value: true, confirm: 'billing_v2' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.billingV2).toBe(true);
    expect(await isBillingV2()).toBe(true);
    res = await call(ADMIN, { method: 'POST', body: { key: 'billing_v2', value: false } });
    expect(res.body.billingV2).toBe(false);
  });

  it('O4: billing_v2 cannot be turned off once the legacy migration moved anyone (409 ONE_WAY)', async () => {
    await call(ADMIN, { method: 'POST', body: { key: 'billing_v2', value: true, confirm: 'billing_v2' } });
    await db.query(`insert into public.credit_legacy_migrations (customer_id, currency, plan, topup, parked) values ('cus_moved', 'video', 10, 0, false)`);
    const res = await call(ADMIN, { method: 'POST', body: { key: 'billing_v2', value: false } });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ONE_WAY');
    expect(await isBillingV2()).toBe(true);
    await db.query(`delete from public.credit_legacy_migrations where customer_id = 'cus_moved'`);
  });

  it('F-M4 / F-M5 (Fable P1): two-decimal prices are accepted, a 0-credit voice clone is not', () => {
    for (const usd of [19.99, 29.99, 0.55, 8.95, 1.15, 49]) expect(validatePricingWrite('plans', { starter: { usd } })).toBeNull();
    expect(validatePricingWrite('plans', { starter: { usd: 19.999 } })).not.toBeNull();
    expect(validatePricingWrite('voiceClone', 0)).not.toBeNull();
    expect(validatePricingWrite('voiceClone', 1)).toBeNull();
  });

  it('readout margins stay at or above the 2x rule with the default prices', () => {
    const r = pricingReadout(structuredClone(DEFAULTS));
    for (const m of Object.values(r.margins)) expect(m.marginLow).toBeGreaterThan(0.4);
  });
});
