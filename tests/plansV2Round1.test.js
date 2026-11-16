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
const STARTER_Y = v2PlanLookupKey({ plan: 'starter', interval: 'year', amountCents: 34800, credits: 1500 });
const STUDIO_Y = v2PlanLookupKey({ plan: 'studio', interval: 'year', amountCents: 118800, credits: 5400 });
const setPrice = (sub, key) => { S.state.subs.get(sub).items.data[0].price = { id: `price_${key}`, lookup_key: key }; };
function prorationInvoice(customer, subId, { oldKey, newKey, paid }) {
  const id = `in_${randomUUID().slice(0, 12)}`;
  S.state.invoices.set(id, {
    id, customer, subscription: subId, status: 'paid', billing_reason: 'subscription_update', currency: 'usd', amount_paid: paid,
    lines: { data: [
      { proration: true, amount: -100, price: { id: `price_${oldKey}`, lookup_key: oldKey } },
      { proration: true, amount: 100 + paid, price: { id: `price_${newKey}`, lookup_key: newKey } },
    ] },
  });
  return id;
}
const subUpdated = (sub) => ({ id: `evt_${randomUUID()}`, type: 'customer.subscription.updated', data: { object: { id: sub }, previous_attributes: {} } });
const bal = async (u) => { const b = await getBalance(u.id); return { plan: b.plan, topup: b.topup, available: b.available }; };


// Regression tests from the Task 27 Fable adversarial review (A1-A11) and the Opus review (O1-O3).
const renews = async (u) => (await ledger(u.id)).filter((r) => r.op === 'renew');
const upgrades = async (u) => (await ledger(u.id)).filter((r) => r.reason === 'plan_upgrade' && r.op === 'grant');
const refund = async (customer, invoice, amount, refunded) => {
  const ch = `ch_${randomUUID().slice(0, 8)}`;
  S.state.charges.set(ch, { id: ch, customer, invoice, amount, amount_refunded: refunded });
  return deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: ch } } });
};
const yearlyRow = async (sub) => (await db.query('select plan, credits, status from public.credit_yearly_subs where sub_id = $1', [sub])).rows[0];

describe('Task 27 round 1: upgrades', () => {
  it('F-C1 / A1: an upgrade one hour before renewal grants the difference prorated by the time left, not the whole difference', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const t0 = nowS() - 30 * DAY + 3600; // the period ends in one hour
    const sub = newSub(customer, STARTER_M, { start: t0, end: t0 + 30 * DAY });
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, STUDIO_M);
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 60 })));
    const [up] = await upgrades(user);
    expect(up.amount).toBeGreaterThan(0);
    expect(up.amount).toBeLessThanOrEqual(7); // ceil(3900 x 1 h / 720 h) = 6
    expect((await bal(user)).plan).toBeLessThan(1600);
  });

  it('F-I1 / A2: a renewal invoice paid after an upgrade is granted at the plan it paid for (its own line)', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    const cycle = paidInvoice(customer, sub, 'subscription_cycle');
    S.state.invoices.get(cycle).lines = { data: [{ proration: false, amount: 2900, price: { id: `price_${STARTER_M}`, lookup_key: STARTER_M } }] };
    S.state.invoices.get(cycle).amount_paid = 2900;
    setPrice(sub, STUDIO_M);
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 7000 })));
    await deliver(invoiceEvent(cycle));
    expect((await renews(user)).map((r) => r.amount)).toEqual([1500]);
  });

  it('F-I2 / A3: a yearly plan switched to a dearer yearly price with nothing paid keeps its level in the cron', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const start = nowS() - 100 * DAY;
    const sub = newSub(customer, STARTER_Y, { start, end: start + 365 * DAY });
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    await grantYearlyMonths();
    setPrice(sub, STUDIO_Y);
    await deliver(subUpdated(sub));
    expect(await yearlyRow(sub)).toMatchObject({ plan: 'starter', credits: 1500, status: 'active' });
    await grantYearlyMonths({ now: new Date((start + 160 * DAY) * 1000) });
    expect(new Set((await renews(user)).map((r) => r.amount))).toEqual(new Set([1500]));
    // A downgrade does lower it.
    setPrice(sub, v2PlanLookupKey({ plan: 'starter', interval: 'year', amountCents: 24000, credits: 1000 }));
    await deliver(subUpdated(sub));
    expect((await yearlyRow(sub)).credits).toBe(1000);
  });

  it('F-I6 / A6: a second paid upgrade in the same period grants the prorated rest up to the new level', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, CREATOR_M);
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: CREATOR_M, paid: 2000 })));
    setPrice(sub, STUDIO_M);
    expect((await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: CREATOR_M, newKey: STUDIO_M, paid: 5000 })))).statusCode).toBe(200);
    const ups = await upgrades(user);
    expect(ups.map((r) => r.ref.split(':').pop())).toEqual(['2600', '5400']);
    expect((await bal(user)).plan).toBeGreaterThanOrEqual(5395);
    expect((await bal(user)).plan).toBeLessThanOrEqual(5400);
    // Down and up again in the same period: the 5400 level was already granted.
    setPrice(sub, CREATOR_M);
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STUDIO_M, newKey: CREATOR_M, paid: 0 })));
    setPrice(sub, STUDIO_M);
    await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: CREATOR_M, newKey: STUDIO_M, paid: 5000 })));
    expect(await upgrades(user)).toHaveLength(2);
  });

  it('F-I6 / A9: an upgrade paid from the customer balance (amount_paid 0, total > 0) is granted', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, STUDIO_M);
    const inv = prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 0 });
    Object.assign(S.state.invoices.get(inv), { total: 7000, amount_due: 0, starting_balance: -7000, amount_paid: 0 });
    await deliver(invoiceEvent(inv));
    expect(await upgrades(user)).toHaveLength(1);
  });

  it('A8: a legacy plan change with billing v2 off writes nothing and never 500s', async () => {
    await setV2(false);
    const user = newUser(); const customer = await linkedCustomer(user);
    const sub = newSub(customer, PLANS.pro.lookupKey);
    expect((await deliver(subUpdated(sub))).statusCode).toBe(200);
    const inv = paidInvoice(customer, sub, 'subscription_update');
    S.state.invoices.get(inv).lines = { data: [] };
    expect((await deliver(invoiceEvent(inv))).statusCode).toBe(200);
    expect(await ledger(user.id)).toEqual([]);
  });

  it('O3 / A10: monthly -> yearly grants month 0 of the new year at once, then exactly 12 grants over the paid year', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const t0 = nowS() - 20 * DAY;
    const sub = newSub(customer, STARTER_M, { start: t0, end: t0 + 30 * DAY });
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, STARTER_Y);
    const yStart = nowS();
    Object.assign(S.state.subs.get(sub), { current_period_start: yStart, current_period_end: yStart + 365 * DAY });
    await deliver(subUpdated(sub));
    expect((await deliver(invoiceEvent(prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STARTER_Y, paid: 33800 })))).statusCode).toBe(200);
    expect((await renews(user)).filter((r) => r.ref.startsWith('yearly:'))).toHaveLength(1);
    await grantYearlyMonths();
    await grantYearlyMonths({ now: new Date((yStart + 364 * DAY) * 1000) });
    await grantYearlyMonths({ now: new Date((yStart + 364 * DAY) * 1000) });
    const yearly = (await renews(user)).filter((r) => r.ref.startsWith('yearly:'));
    expect(yearly).toHaveLength(12);
    expect(new Set(yearly.map((r) => r.ref)).size).toBe(12);
  });
});

describe('Task 27 round 1: refunds and disputes', () => {
  it('O2 / A4: a full refund of a yearly invoice reverses month 0 and every month granted so far, and stops the rest', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const start = nowS() - 100 * DAY;
    const sub = newSub(customer, STUDIO_Y, { start, end: start + 365 * DAY });
    const inv = paidInvoice(customer, sub);
    await deliver(invoiceEvent(inv));
    await grantYearlyMonths();
    expect(await renews(user)).toHaveLength(4);
    await refund(customer, inv, 118800, 118800);
    expect((await bal(user)).available).toBe(0);
    expect((await yearlyRow(sub)).status).toBe('refunded');
    await grantYearlyMonths({ now: new Date((start + 300 * DAY) * 1000) });
    expect(await renews(user)).toHaveLength(4);
  });

  it('O2: a partial refund takes its share off the months granted so far and off each later month; months continue', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const start = nowS() - 40 * DAY;
    const sub = newSub(customer, CREATOR_Y, { start, end: start + 365 * DAY });
    const inv = paidInvoice(customer, sub);
    await deliver(invoiceEvent(inv));
    await grantYearlyMonths(); // month 1
    await refund(customer, inv, 58800, 5880); // 10 %
    let claws = (await ledger(user.id)).filter((r) => r.reason === 'stripe_refund');
    expect(claws.map((r) => r.amount)).toEqual([260, 260]);
    await grantYearlyMonths({ now: new Date((start + 70 * DAY) * 1000) }); // month 2
    claws = (await ledger(user.id)).filter((r) => r.reason === 'stripe_refund');
    expect(claws.map((r) => r.amount)).toEqual([260, 260, 260]);
    expect((await yearlyRow(sub)).status).toBe('active');
  });

  it('O2: a dispute after N months reverses every month granted so far', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const start = nowS() - 70 * DAY;
    const sub = newSub(customer, STARTER_Y, { start, end: start + 365 * DAY });
    const inv = paidInvoice(customer, sub);
    await deliver(invoiceEvent(inv));
    await grantYearlyMonths();
    const ch = `ch_${randomUUID().slice(0, 8)}`;
    S.state.charges.set(ch, { id: ch, customer, invoice: inv, amount: 34800, amount_refunded: 0, disputed: true });
    S.api.disputes.list = async () => ({ data: [{ id: 'dp_y', amount: 34800 }] });
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: { id: 'dp_y', charge: ch, amount: 34800 } } });
    S.api.disputes.list = async () => ({ data: [] });
    expect((await ledger(user.id)).filter((r) => r.reason === 'stripe_dispute')).toHaveLength(3);
    expect((await bal(user)).available).toBe(0);
  });

  it('O1 / A11: a dispute on a paid upgrade invoice reverses the upgrade grant', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, STUDIO_M);
    const inv = prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 7000 });
    await deliver(invoiceEvent(inv));
    const [up] = await upgrades(user);
    const ch = `ch_${randomUUID().slice(0, 8)}`;
    S.state.charges.set(ch, { id: ch, customer, invoice: inv, amount: 7000, amount_refunded: 0, disputed: true });
    S.api.disputes.list = async () => ({ data: [{ id: 'dp_1', amount: 7000 }] });
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: ch, amount: 7000 } } });
    S.api.disputes.list = async () => ({ data: [] });
    const claw = (await ledger(user.id)).filter((r) => r.reason === 'stripe_dispute');
    expect(claw.map((r) => r.amount)).toEqual([up.amount]);
    expect((await bal(user)).plan).toBe(1500);
  });

  it('O1: a refund that arrives before the upgrade is granted means no grant', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const sub = newSub(customer, STARTER_M);
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, STUDIO_M);
    const inv = prorationInvoice(customer, sub, { oldKey: STARTER_M, newKey: STUDIO_M, paid: 7000 });
    await refund(customer, inv, 7000, 7000);
    await deliver(invoiceEvent(inv));
    expect(await upgrades(user)).toHaveLength(0);
  });

  it('F-I5 / A5: refunding an upgrade invoice of a yearly plan keeps the yearly months and puts the level back', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const start = nowS() - 40 * DAY;
    const sub = newSub(customer, STARTER_Y, { start, end: start + 365 * DAY });
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    setPrice(sub, STUDIO_Y);
    const up = prorationInvoice(customer, sub, { oldKey: STARTER_Y, newKey: STUDIO_Y, paid: 500 });
    await deliver(invoiceEvent(up));
    expect((await yearlyRow(sub)).credits).toBe(5400);
    expect((await refund(customer, up, 500, 500)).statusCode).toBe(200);
    expect(await yearlyRow(sub)).toMatchObject({ status: 'active', credits: 1500 });
    await grantYearlyMonths({ now: new Date((start + 200 * DAY) * 1000) });
    expect((await renews(user)).length).toBeGreaterThan(1);
  });

  it('A7: several months due at once are each granted (the plan rollover cap applies, documented)', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    const start = nowS() - 100 * DAY;
    const sub = newSub(customer, STARTER_Y, { start, end: start + 365 * DAY });
    await deliver(invoiceEvent(paidInvoice(customer, sub)));
    await grantYearlyMonths();
    expect(await renews(user)).toHaveLength(4);
  });
});

describe('Task 27 round 1: checkout minors', () => {
  it('a v2 plan needs a signed-in buyer (the one-plan check needs the customer)', async () => {
    await setV2(true);
    auth.user = null;
    const res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'creator' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('SIGN_IN');
    expect(S.state.created).toHaveLength(0);
  });

  it('F-M8: a past_due plan counts as a plan (no second subscription)', async () => {
    await setV2(true);
    const user = newUser(); const customer = await linkedCustomer(user);
    newSub(customer, STARTER_M, { status: 'past_due' });
    auth.user = user;
    const res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { plan: 'studio' } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('F-M9: an inherited property name is not a pack', async () => {
    await setV2(false);
    auth.user = newUser();
    const res = makeRes();
    await checkout({ method: 'POST', headers: { host: 'localhost:3000' }, body: { mode: 'topup', pack: 'constructor' } }, res);
    expect(res.statusCode).toBe(400);
  });
});
