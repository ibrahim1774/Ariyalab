import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.js';

// ---- in-memory Stripe (never the live account) ----------------------
const S = vi.hoisted(() => {
  const state = { customers: new Map(), sessions: new Map(), subs: new Map(), invoices: new Map(), charges: new Map(), created: [], v2Prices: [] };
  const clone = (o) => (o === undefined ? o : structuredClone(o));
  const api = {
    customers: {
      retrieve: async (id) => {
        const c = state.customers.get(id);
        if (!c) throw Object.assign(new Error(`No such customer: ${id}`), { code: 'resource_missing' });
        return clone(c);
      },
      search: async () => ({ data: [] }),
      list: async () => ({ data: [] }),
      update: async (id, { metadata }) => {
        const c = state.customers.get(id);
        c.metadata = { ...c.metadata, ...metadata };
        return clone(c);
      },
    },
    checkout: {
      sessions: {
        retrieve: async (id) => clone(state.sessions.get(id)),
        list: async ({ payment_intent }) => ({ data: [...state.sessions.values()].filter((s) => s.payment_intent === payment_intent).map(clone) }),
        create: async (params) => {
          state.created.push(params);
          return { id: `cs_test_new_${state.created.length}`, url: 'https://checkout.stripe.test/x' };
        },
      },
    },
    subscriptions: {
      retrieve: async (id) => clone(state.subs.get(id)),
      list: async ({ customer, status }) => ({
        data: [...state.subs.values()].filter((x) => x.customer === customer && x.status === status).map(clone),
        has_more: false,
      }),
    },
    invoices: { retrieve: async (id) => clone(state.invoices.get(id)) },
    charges: { retrieve: async (id) => clone(state.charges.get(id)) },
    disputes: { list: async () => ({ data: [] }) },
    webhooks: { constructEvent: (raw) => JSON.parse(raw.toString('utf8')) },
  };
  return { state, api };
});

const auth = vi.hoisted(() => ({ user: null, db: null }));

vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stripe: () => S.api,
    getOrCreatePrice: async (plan) => ({ id: `price_${plan}`, lookup_key: actual.PLANS[plan].lookupKey }),
    getOrCreateTopupPrice: async (pack) => ({ id: `price_topup_${pack}`, lookup_key: actual.TOPUPS[pack].lookupKey }),
    getOrCreateV2Price: async (offer) => {
      S.state.v2Prices.push(offer);
      const lookup_key = offer.kind === 'plan' ? actual.v2PlanLookupKey(offer) : actual.v2TopupLookupKey(offer);
      return { id: `price_${lookup_key}`, lookup_key, unit_amount: offer.amountCents };
    },
  };
});
vi.mock('../lib/meta', () => ({ sendCapiEvent: vi.fn(async () => {}) }));
vi.mock('../lib/supabaseServer', () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: (_col, id) => ({
          maybeSingle: async () => {
            const { rows } = await auth.db.query('select stripe_customer_id from public.profiles where id = $1', [id]);
            return { data: rows[0] || null, error: null };
          },
        }),
      }),
    }),
  };
  return {
    getUserFromRequest: async () => (auth.user ? { user: auth.user, supabase: client } : null),
    getSupabaseAdmin: () => client,
  };
});

import { PLANS, planFromPrice, topupFromPrice, parseV2LookupKey, v2PlanLookupKey, v2TopupLookupKey, planInfoFromPrice } from '../lib/stripe';
import { setCreditsDb, getBalance } from '../lib/credits.js';
import { setPricingDb, _resetPricingCache, v2Offers, getPricing } from '../lib/pricing.js';
import { setGrantsDb, grantYearlyMonths, dueYearlyMonths, yearlyRef, addMonthsUtc } from '../lib/grants.js';
import webhook from '../pages/api/stripe-webhook.js';
import checkout from '../pages/api/checkout.js';
import grantYearly from '../pages/api/cron/grant-yearly.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  auth.db = db;
  setCreditsDb(db);
  setPricingDb(db);
  setGrantsDb(db);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.CRON_SECRET = 'cron_test_secret';
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  setPricingDb(null);
  setGrantsDb(null);
  await db?.close();
});
beforeEach(() => {
  auth.user = null;
  S.state.created.length = 0;
  S.state.v2Prices.length = 0;
});

async function setConfig(key, value) {
  await db.query('delete from public.pricing_config where key = $1', [key]);
  if (value !== undefined) await db.query('insert into public.pricing_config (key, value) values ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  _resetPricingCache();
}
const setV2 = (on) => setConfig('billing_v2', on ? true : undefined);

const nowS = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
    end(payload) { res.body = payload; return res; },
    setHeader(n, v) { res.headers[n] = v; },
    getHeader(n) { return res.headers[n]; },
  };
  return res;
}
async function deliver(event) {
  const raw = Buffer.from(JSON.stringify(event));
  const req = { method: 'POST', headers: { 'stripe-signature': 't=1' }, async *[Symbol.asyncIterator]() { yield raw; } };
  const res = makeRes();
  await webhook(req, res);
  return res;
}
const newUser = () => ({ id: randomUUID(), email: `${randomUUID().slice(0, 8)}@example.test`, email_confirmed_at: '2026-11-01T00:00:00Z' });
function linkedCustomer(user) {
  const id = `cus_${randomUUID().slice(0, 12)}`;
  S.state.customers.set(id, { id, email: user.email, metadata: { supabase_user_id: user.id } });
  return db.query('insert into public.profiles (id, stripe_customer_id) values ($1, $2)', [user.id, id]).then(() => id);
}
function newSub(customer, lookup_key, { start = nowS(), end = start + 30 * DAY, status = 'active' } = {}) {
  const id = `sub_${randomUUID().slice(0, 12)}`;
  S.state.subs.set(id, { id, customer, status, current_period_start: start, current_period_end: end, items: { data: [{ price: { id: `price_${lookup_key}`, lookup_key } }] } });
  return id;
}
function paidInvoice(customer, subId, reason = 'subscription_create') {
  const id = `in_${randomUUID().slice(0, 12)}`;
  S.state.invoices.set(id, { id, customer, subscription: subId, status: 'paid', amount_paid: 100, billing_reason: reason, currency: 'usd' });
  return id;
}
const invoiceEvent = (invoiceId) => ({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: { id: invoiceId } } });
const ledger = async (userId) =>
  (await db.query('select op, reason, ref, amount, bucket from public.credit_ledger where user_id = $1 order by id', [userId])).rows;

const STARTER_M = v2PlanLookupKey({ plan: 'starter', interval: 'month', amountCents: 2900, credits: 1500 });
const CREATOR_M = v2PlanLookupKey({ plan: 'creator', interval: 'month', amountCents: 4900, credits: 2600 });
const STUDIO_M = v2PlanLookupKey({ plan: 'studio', interval: 'month', amountCents: 9900, credits: 5400 });
const CREATOR_Y = v2PlanLookupKey({ plan: 'creator', interval: 'year', amountCents: 58800, credits: 2600 });

describe('v2 lookup keys (CRITICAL carry: recognised before any v2 price is sold)', () => {
  it('planFromPrice and topupFromPrice recognise ariya_v2_ keys; legacy keys unchanged', () => {
    expect(planFromPrice({ lookup_key: CREATOR_M })).toBe('creator');
    expect(planFromPrice({ lookup_key: CREATOR_Y })).toBe('creator');
    expect(planFromPrice({ lookup_key: PLANS.pro.lookupKey })).toBe('pro');
    expect(planFromPrice({ lookup_key: 'ariyalab_monthly_glow_up_v1' })).toBe('monthly');
    const pack = topupFromPrice({ lookup_key: v2TopupLookupKey({ pack: 's', amountCents: 1500, credits: 700 }) });
    expect(pack).toMatchObject({ key: 's', kind: 'video', v2: true, credits: 700, amountCents: 1500 });
    expect(topupFromPrice({ lookup_key: CREATOR_M })).toBeNull();
    expect(planFromPrice({ lookup_key: v2TopupLookupKey({ pack: 's', amountCents: 1500, credits: 700 }) })).toBeNull();
  });
  it('rejects malformed or foreign keys (haelabs keys stay "not ours")', () => {
    for (const k of ['ariya_v2_creator_week_100_1', 'ariya_v2_creator_month_0_1', 'ariya_v2_gold_month_100_1', 'haelabs_pro_v1', 'ariya_v2_topup_xl_1_1']) {
      expect(parseV2LookupKey(k)).toBeNull();
      expect(planFromPrice({ lookup_key: k })).toBeNull();
      expect(topupFromPrice({ lookup_key: k })).toBeNull();
    }
  });
  it('planInfoFromPrice gives the version, interval, amount and credits', () => {
    expect(planInfoFromPrice({ lookup_key: CREATOR_Y })).toEqual({ plan: 'creator', version: 'v2', interval: 'year', amountCents: 58800, credits: 2600 });
    expect(planInfoFromPrice({ lookup_key: PLANS.yearly.lookupKey })).toMatchObject({ plan: 'yearly', version: 'legacy', credits: 3840 });
  });
});

describe('v2 offers from pricing config', () => {
  it('defaults: PLANS_V2 prices, yearly = 12 x monthly (no discount until the owner sets one)', async () => {
    await setConfig('plans', undefined);
    await setConfig('yearlyDiscount', undefined);
    const o = v2Offers(await getPricing());
    expect(o.yearlyDiscount).toBe(0);
    expect(o.plans.creator).toMatchObject({ usd: 49, credits: 2600, monthlyCents: 4900, yearlyCents: 58800 });
    expect(o.topups.s).toEqual({ usd: 15, credits: 700, cents: 1500 });
  });
  it('config overrides, a discount, and bad values fall back to defaults', async () => {
    await setConfig('plans', { creator: { usd: 59 }, studio: { usd: -1, credits: 1.5 } });
    await setConfig('yearlyDiscount', 0.2);
    const o = v2Offers(await getPricing());
    expect(o.plans.creator).toMatchObject({ usd: 59, credits: 2600, monthlyCents: 5900, yearlyCents: 56640 });
    expect(o.plans.studio).toMatchObject({ usd: 99, credits: 5400 });
    await setConfig('plans', undefined);
    await setConfig('yearlyDiscount', undefined);
  });
});

describe('checkout', () => {
  it('with billing_v2 off still sells legacy plans and refuses v2 plans', async () => {
    await setV2(false);
    auth.user = null;
    let res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'pro' } }, res);
    expect(res.statusCode).toBe(200);
    expect(S.state.created.at(-1).line_items[0].price).toBe('price_pro');
    expect(S.state.v2Prices).toHaveLength(0);
    res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'starter' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('with billing_v2 on sells starter|creator|studio (monthly and yearly) at the configured price, and refuses legacy names', async () => {
    await setV2(true);
    await setConfig('yearlyDiscount', 0.1);
    const user = newUser();
    auth.user = user;
    let res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'creator' } }, res);
    expect(res.statusCode).toBe(200);
    expect(S.state.v2Prices.at(-1)).toEqual({ kind: 'plan', plan: 'creator', interval: 'month', amountCents: 4900, credits: 2600 });
    expect(S.state.created.at(-1).line_items[0].price).toBe(`price_${CREATOR_M}`);
    expect(res.body.meta.value).toBe(49);

    res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'studio', interval: 'year' } }, res);
    expect(res.statusCode).toBe(200);
    expect(S.state.v2Prices.at(-1)).toEqual({ kind: 'plan', plan: 'studio', interval: 'year', amountCents: 106920, credits: 5400 });

    res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { mode: 'topup', pack: 'm', catalog: 'v2' } }, res);
    expect(res.statusCode).toBe(200);
    expect(S.state.v2Prices.at(-1)).toEqual({ kind: 'topup', pack: 'm', amountCents: 4000, credits: 1900 });

    // A page that drew the legacy packs ($50 for 7,600) never buys the v2 pack behind the same key.
    const before = S.state.created.length;
    res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { mode: 'topup', pack: 'm' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('RELOAD');
    expect(S.state.created).toHaveLength(before);

    res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'monthly' } }, res);
    expect(res.statusCode).toBe(400);
    await setConfig('yearlyDiscount', undefined);
  });

  it('refuses a second plan for a customer who already has one (no double billing)', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    newSub(customer, STARTER_M);
    auth.user = user;
    const res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'studio' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('HAS_PLAN');
    expect(S.state.created).toHaveLength(0);
  });

  it('answers 503 (sells nothing) when the billing flag cannot be read on a cold instance', async () => {
    const failing = { query: async () => { throw new Error('db down'); } };
    setPricingDb(failing);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'pro' } }, res);
    err.mockRestore();
    setPricingDb(db);
    expect(res.statusCode).toBe(503);
    expect(S.state.created).toHaveLength(0);
  });
});

describe('invoice grants (billing_v2)', () => {
  it('a monthly v2 invoice paid renews with the plan allotment named by its price', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const sub = newSub(customer, CREATOR_M);
    const inv = paidInvoice(customer, sub);
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    expect(await ledger(user.id)).toEqual([{ op: 'renew', reason: 'plan_renewal', ref: `invoice:${inv}`, amount: 2600, bucket: 'plan' }]);
    // A repeat delivery grants nothing more.
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    expect((await getBalance(user.id)).plan).toBe(2600);
  });

  it('a legacy subscriber renewal grants ceil(legacyCredits x 21 / 100)', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const sub = newSub(customer, PLANS.pro.lookupKey);
    const inv = paidInvoice(customer, sub, 'subscription_cycle');
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    const rows = await ledger(user.id);
    expect(rows[0]).toMatchObject({ op: 'renew', amount: Math.ceil((PLANS.pro.cap * 21) / 100) });
    expect(rows[0].amount).toBe(479);
  });

  it('a v2 top-up grants its own credits (never the 21% legacy conversion)', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const lookup_key = v2TopupLookupKey({ pack: 's', amountCents: 1500, credits: 700 });
    const id = `cs_test_${randomUUID().replace(/-/g, '')}`;
    S.state.sessions.set(id, {
      id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', customer, client_reference_id: user.id,
      metadata: { supabase_user_id: user.id }, created: nowS(), payment_intent: `pi_${id}`,
      line_items: { data: [{ price: { lookup_key } }] },
    });
    const res = await deliver({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id, mode: 'payment', payment_status: 'paid', customer } } });
    expect(res.statusCode).toBe(200);
    expect((await getBalance(user.id)).topup).toBe(700);
  });

  it('a v2 price is granted in the ledger even when billing_v2 is off (never into legacy metadata)', async () => {
    await setV2(false);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    const inv = paidInvoice(customer, sub);
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    expect((await getBalance(user.id)).plan).toBe(1500);
    expect(S.state.customers.get(customer).metadata.al_credits).toBeUndefined();
  });
});

describe('yearly grants', () => {
  it('works out months from the subscription anchor, clamped (a sub on the 31st)', () => {
    const start = new Date(Date.UTC(2027, 0, 31, 12));
    expect(addMonthsUtc(start, 1).toISOString()).toBe('2027-02-28T12:00:00.000Z');
    const months = dueYearlyMonths({ periodStart: start, periodEnd: addMonthsUtc(start, 12), now: new Date(Date.UTC(2027, 3, 1)) });
    expect(months.map((d) => yearlyRef('sub_x', d))).toEqual(['yearly:sub_x:2027-02', 'yearly:sub_x:2027-03']);
    // Never month 12 (the next invoice) and never past the period end.
    expect(dueYearlyMonths({ periodStart: start, periodEnd: addMonthsUtc(start, 12), now: addMonthsUtc(start, 30) })).toHaveLength(11);
  });

  it('the invoice grants month 0; the cron grants one per month, idempotent on yearly:<subId>:<YYYY-MM>', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const start = nowS() - 70 * DAY; // the anchor, a bit more than two months ago
    const sub = newSub(customer, CREATOR_Y, { start, end: start + 365 * DAY });
    const inv = paidInvoice(customer, sub);
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    expect((await ledger(user.id)).map((r) => r.ref)).toEqual([`invoice:${inv}`]);

    const res = makeRes();
    await grantYearly({ method: 'GET', headers: { authorization: 'Bearer cron_test_secret' } }, res);
    expect(res.statusCode).toBe(200);
    const months = dueYearlyMonths({ periodStart: new Date(start * 1000), periodEnd: new Date((start + 365 * DAY) * 1000) });
    expect(months).toHaveLength(2);
    const rows = await ledger(user.id);
    expect(rows.filter((r) => r.op === 'renew').map((r) => [r.ref, r.amount])).toEqual([
      [`invoice:${inv}`, 2600],
      ...months.map((d) => [yearlyRef(sub, d), 2600]),
    ]);

    // Running again (or twice in a day) grants nothing new.
    await grantYearlyMonths();
    await grantYearlyMonths();
    expect((await ledger(user.id)).filter((r) => r.op === 'renew')).toHaveLength(3);
  });

  it('the cron rejects calls without CRON_SECRET', async () => {
    const res = makeRes();
    await grantYearly({ method: 'GET', headers: { authorization: 'Bearer nope' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('skips canceled subscriptions and parks months for a customer with no linked user', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const start = nowS() - 40 * DAY;
    const sub = newSub(customer, CREATOR_Y, { start, end: start + 365 * DAY });
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    S.state.subs.get(sub).status = 'canceled';
    expect((await deliver({ id: `evt_${randomUUID()}`, type: 'customer.subscription.deleted', data: { object: { id: sub } } })).statusCode).toBe(200);
    await grantYearlyMonths();
    expect((await ledger(user.id)).filter((r) => r.op === 'renew')).toHaveLength(1);

    const orphan = `cus_${randomUUID().slice(0, 12)}`;
    S.state.customers.set(orphan, { id: orphan, metadata: {} });
    const sub2 = newSub(orphan, CREATOR_Y, { start, end: start + 365 * DAY });
    await deliver(invoiceEvent(paidInvoice(orphan, sub2)));
    await grantYearlyMonths();
    const parked = await db.query('select ref, amount from public.credit_pending_grants where stripe_customer_id = $1 order by ref', [orphan]);
    expect(parked.rows.map((r) => r.ref).some((r) => r.startsWith(`yearly:${sub2}:`))).toBe(true);
  });

  it('a partial (goodwill) refund of a yearly invoice keeps the later months', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const start = nowS() - 40 * DAY;
    const sub = newSub(customer, CREATOR_Y, { start, end: start + 365 * DAY });
    const inv = paidInvoice(customer, sub);
    await deliver(invoiceEvent(inv));
    const chargeId = `ch_${randomUUID().slice(0, 10)}`;
    S.state.charges.set(chargeId, { id: chargeId, customer, invoice: inv, amount: 58800, amount_refunded: 500 });
    expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: chargeId } } })).statusCode).toBe(200);
    await grantYearlyMonths();
    expect((await ledger(user.id)).filter((r) => r.ref.startsWith('yearly:'))).toHaveLength(1);
  });

  it('a refunded yearly invoice stops the later months', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const start = nowS() - 40 * DAY;
    const sub = newSub(customer, CREATOR_Y, { start, end: start + 365 * DAY });
    const inv = paidInvoice(customer, sub);
    await deliver(invoiceEvent(inv));
    const chargeId = `ch_${randomUUID().slice(0, 10)}`;
    S.state.charges.set(chargeId, { id: chargeId, customer, invoice: inv, amount: 58800, amount_refunded: 58800 });
    expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: chargeId } } })).statusCode).toBe(200);
    await grantYearlyMonths();
    expect((await ledger(user.id)).filter((r) => r.ref.startsWith('yearly:'))).toHaveLength(0);
  });
});

describe('mid-period plan changes', () => {
  const updated = (sub, oldKey) => ({
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.updated',
    data: { object: { id: sub }, previous_attributes: { items: { data: [{ price: { id: `price_${oldKey}`, lookup_key: oldKey } }] } } },
  });
  // The proration invoice Stripe issues for a switch (API 2024-06-20 line shape).
  function prorationInvoice(customer, subId, { oldKey, newKey, paid }) {
    const id = `in_${randomUUID().slice(0, 12)}`;
    S.state.invoices.set(id, {
      id, customer, subscription: subId, status: 'paid', billing_reason: 'subscription_update', currency: 'usd',
      amount_paid: paid,
      lines: { data: [
        { proration: true, amount: -2000, price: { id: `price_${oldKey}`, lookup_key: oldKey } },
        { proration: true, amount: 2000 + paid, price: { id: `price_${newKey}`, lookup_key: newKey } },
      ] },
    });
    return id;
  }

  it('the subscription.updated event alone grants nothing (no credits before the upgrade is paid)', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    S.state.subs.get(sub).items.data[0].price = { id: `price_${STUDIO_M}`, lookup_key: STUDIO_M };
    expect((await deliver(updated(sub, STARTER_M))).statusCode).toBe(200);
    expect((await ledger(user.id)).filter((r) => r.reason === 'plan_upgrade')).toHaveLength(0);
    expect((await getBalance(user.id)).plan).toBe(1500);
  });

  it('a paid upgrade invoice grants the allotment difference once for the period (upgrade:<subId>:<periodStart>)', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    S.state.subs.get(sub).items.data[0].price = { id: `price_${STUDIO_M}`, lookup_key: STUDIO_M };
    const inv = prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 3500 });
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    const periodStart = S.state.subs.get(sub).current_period_start;
    expect((await ledger(user.id)).at(-1)).toMatchObject({ op: 'grant', reason: 'plan_upgrade', ref: `upgrade:${sub}:${periodStart}`, amount: 3900, bucket: 'plan' });
    // A repeat delivery, or a second upgrade invoice in the same period, grants nothing more.
    await deliver(invoiceEvent(inv));
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 3500 })));
    expect((await ledger(user.id)).filter((r) => r.reason === 'plan_upgrade')).toHaveLength(1);
    expect((await getBalance(user.id)).plan).toBe(5400);
  });

  it('a downgrade (net credit, nothing paid) grants nothing', async () => {
    await setV2(true);
    const user = newUser();
    const customer = await linkedCustomer(user);
    const sub = newSub(customer, STUDIO_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    S.state.subs.get(sub).items.data[0].price = { id: `price_${CREATOR_M}`, lookup_key: CREATOR_M };
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STUDIO_M, newKey: CREATOR_M, paid: 0 })));
    await deliver(updated(sub, STUDIO_M));
    expect((await ledger(user.id)).filter((r) => r.reason === 'plan_upgrade')).toHaveLength(0);
    expect((await getBalance(user.id)).plan).toBe(5400);
  });

  it('ignores subscriptions that are not this app\'s', async () => {
    await setV2(true);
    const customer = `cus_${randomUUID().slice(0, 12)}`;
    S.state.customers.set(customer, { id: customer, metadata: {} });
    const sub = newSub(customer, 'haelabs_pro_monthly');
    expect((await deliver(updated(sub, 'haelabs_basic'))).statusCode).toBe(200);
  });
});
