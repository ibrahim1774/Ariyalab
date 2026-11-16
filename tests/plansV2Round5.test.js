import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.js';

// ---- in-memory Stripe (never the live account) ----------------------
const S = vi.hoisted(() => {
  const state = { customers: new Map(), sessions: new Map(), subs: new Map(), invoices: new Map(), charges: new Map(), created: [], v2Prices: [], cancels: [], refunds: [] };
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
      retrieve: async (id, opts) => {
        const sub = clone(state.subs.get(id));
        if (sub && opts?.expand?.includes('latest_invoice') && typeof sub.latest_invoice === 'string') {
          sub.latest_invoice = clone(state.invoices.get(sub.latest_invoice)) || sub.latest_invoice;
        }
        return sub;
      },
      cancel: async (id, _params, opts) => {
        state.cancels.push({ id, key: opts?.idempotencyKey });
        state.subs.get(id).status = 'canceled';
        return clone(state.subs.get(id));
      },
      list: async ({ customer, status }) => ({
        data: [...state.subs.values()].filter((x) => x.customer === customer && x.status === status).map(clone),
        has_more: false,
      }),
    },
    invoices: { retrieve: async (id) => clone(state.invoices.get(id)) },
    charges: { retrieve: async (id) => clone(state.charges.get(id)) },
    disputes: { list: async () => ({ data: [] }) },
    refunds: {
      create: async (params, opts) => {
        state.refunds.push({ ...params, key: opts?.idempotencyKey });
        return { id: `re_${state.refunds.length}` };
      },
    },
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
import { setCreditsDb, getBalance, spendCredits, grantCredits } from '../lib/credits.js';
import { setPricingDb, _resetPricingCache, v2Offers, getPricing } from '../lib/pricing.js';
import { setGrantsDb, grantYearlyMonths, dueYearlyMonths, yearlyRef, addMonthsUtc } from '../lib/grants.js';
import webhook from '../pages/api/stripe-webhook.js';
import checkout from '../pages/api/checkout.js';
import grantYearly from '../pages/api/cron/grant-yearly.js';
import claim from '../pages/api/checkout/claim.js';
import confirm from '../pages/api/checkout/confirm.js';

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

// ---------------------------------------------------------------------------
// Task 27 round 4: plan-change invoices are credited by MONEY (the controller's
// ruling). Every invoice here is built the way Stripe builds it: a proration
// line is the price's amount times the share of the period left at the change
// (`period: { start: change, end }`), an interval change bills the new period
// as a full non-proration line and moves the anchor. Each flip happens at its
// own time (the earlier tests flipped every step at the same `now`).
//
// The expected credits follow the ruling, line by line:
//   - a period line (non-proration): the price's allotment (monthly: its
//     credits; yearly: 12 x its monthly credits for that period),
//   - a proration charge: floor(amount x rate), a proration credit:
//     -ceil(|amount| x rate), rate = the price's period credits / its amount,
//   - a yearly period gives at most what its lines add up to (never below 0).
// Net credits are read from the ledger amounts (renew/grant minus clawback),
// so rollover expiry and uncollectable claws do not blur them.

const HOUR = 3600;
const info = (key) => parseV2LookupKey(key);
const isYear = (key) => info(key).interval === 'year';
const periodCredits = (key) => info(key).credits * (isYear(key) ? 12 : 1);
const creditsFor = (key, amount) => (amount >= 0
  ? Math.floor((amount * periodCredits(key)) / info(key).amountCents)
  : -Math.ceil((-amount * periodCredits(key)) / info(key).amountCents));
const addMonthsS = (s, n) => Math.floor(addMonthsUtc(new Date(s * 1000), n).getTime() / 1000);
const nextEnd = (key, t) => addMonthsS(t, isYear(key) ? 12 : 1);

let lineSeq = 0;
function planLine(key, amount, start, end, proration) {
  lineSeq += 1;
  return {
    id: `il_r4_${lineSeq}`, object: 'line_item', type: proration ? 'invoiceitem' : 'subscription', proration, amount,
    currency: 'usd', period: { start, end },
    price: { id: `price_${key}`, object: 'price', lookup_key: key, currency: 'usd', unit_amount: info(key).amountCents },
  };
}
function addInvoice(customer, sub, { reason, lines, t }) {
  const id = `in_${randomUUID().slice(0, 12)}`;
  const total = lines.reduce((n, l) => n + l.amount, 0);
  S.state.invoices.set(id, {
    id, object: 'invoice', customer, subscription: sub, status: 'paid', billing_reason: reason, currency: 'usd',
    total, amount_due: Math.max(0, total), amount_paid: Math.max(0, total), created: t,
    status_transitions: { paid_at: t }, lines: { data: lines },
  });
  return id;
}
const invoiceAs = (type, invoiceId) => ({ id: `evt_${randomUUID()}`, type, data: { object: { id: invoiceId } } });

/** One subscription driven the way Stripe drives it; remembers every invoice it issued. */
async function account({ key, start }) {
  const user = newUser();
  const customer = await linkedCustomer(user);
  const end = nextEnd(key, start);
  const sub = newSub(customer, key, { start, end });
  const invs = [];
  const cur = () => S.state.subs.get(sub);
  const priceKey = () => cur().items.data[0].price.lookup_key;
  const a = {
    user, customer, sub, invs,
    balance: 0, // the Stripe customer balance (credit): money given back, paying later invoices first
    cash: 0, // money actually charged
    spent: 0,
    async issue(reason, lines, t, type = 'invoice.payment_succeeded') {
      const id = addInvoice(customer, sub, { reason, lines, t });
      const inv = S.state.invoices.get(id);
      const fromBalance = inv.total < 0 ? inv.total : Math.min(a.balance, inv.total);
      a.balance -= fromBalance;
      Object.assign(inv, { starting_balance: -a.balance - fromBalance, amount_paid: inv.total - fromBalance, amount_due: inv.total - fromBalance });
      if (inv.total < 0) Object.assign(inv, { amount_paid: 0, amount_due: 0 });
      a.cash += inv.amount_paid;
      invs.push(inv);
      const res = await deliver(invoiceAs(type, id));
      expect(res.statusCode).toBe(200);
      return id;
    },
    first() {
      return a.issue('subscription_create', [planLine(key, info(key).amountCents, start, end, false)], start);
    },
    /** The next period starts at the current period end and is billed in full. */
    renew(prorationLines = []) {
      const k = priceKey();
      const t = cur().current_period_end;
      const e = nextEnd(k, t);
      Object.assign(cur(), { current_period_start: t, current_period_end: e });
      return a.issue('subscription_cycle', [planLine(k, info(k).amountCents, t, e, false), ...prorationLines], t);
    },
    /** The lines Stripe writes for a change to `newKey` at time t (and moves the period on an interval change). */
    changeLines(newKey, t) {
      const oldKey = priceKey();
      const { current_period_start: ps, current_period_end: pe } = cur();
      const left = (k) => Math.round((info(k).amountCents * (pe - t)) / (pe - ps));
      const lines = [planLine(oldKey, -left(oldKey), t, pe, true)];
      if (info(oldKey).interval === info(newKey).interval) {
        lines.push(planLine(newKey, left(newKey), t, pe, true));
      } else {
        const e = nextEnd(newKey, t);
        lines.push(planLine(newKey, info(newKey).amountCents, t, e, false));
        Object.assign(cur(), { current_period_start: t, current_period_end: e });
      }
      setPrice(sub, newKey);
      return lines;
    },
    /** A plan change invoiced at once (proration "always invoice"). */
    change(newKey, t, type) {
      return a.issue('subscription_update', a.changeLines(newKey, t), t, type);
    },
    /** The customer spends every credit available (a video, say). */
    async spendAll() {
      const { available } = await getBalance(user.id);
      if (available > 0) {
        await spendCredits({ userId: user.id, currency: 'video', amount: available, reason: 'test_spend', ref: randomUUID() });
        a.spent += available;
      }
    },
    /** What the customer actually got: spent plus still available. */
    delivered: async () => a.spent + (await getBalance(user.id)).available,
    /** Credits a plan change could not take back (spent), still owed. */
    debt: async () => {
      try {
        const { rows } = await db.query('select plan_debt from public.credit_accounts where user_id = $1 and currency = $2', [user.id, 'video']);
        return rows[0]?.plan_debt ?? 0;
      } catch {
        return 0; // before round 4 there is no debt
      }
    },
    net: async () => (await ledger(user.id)).reduce((n, r) => {
      if (r.op === 'clawback') return r.reason === 'plan_debt' ? n : n - r.amount;
      if ((r.op === 'renew' || r.op === 'grant') && (r.reason === 'plan_renewal' || r.reason === 'plan_upgrade')) return n + r.amount;
      return n;
    }, 0),
  };
  return a;
}

/** Credits the ruling gives for these invoices. Yearly periods in `running` are left out (released month by month). */
function fairOf(invs, { running = [] } = {}) {
  let monthly = 0;
  const periods = new Map();
  for (const inv of invs) {
    for (const l of inv.lines.data) {
      const k = l.price.lookup_key;
      if (!isYear(k)) {
        monthly += l.proration ? creditsFor(k, l.amount) : info(k).credits;
        continue;
      }
      const c = l.proration ? creditsFor(k, l.amount) : periodCredits(k);
      periods.set(l.period.end, (periods.get(l.period.end) || 0) + c);
    }
  }
  let yearly = 0;
  for (const [end, e] of periods) if (!running.includes(end)) yearly += Math.max(0, e);
  return { total: monthly + yearly, monthly, periods };
}

const GAPS = [['1 h', HOUR], ['10 days', 10 * DAY], ['27 days', 27 * DAY]];

// ---------------------------------------------------------------------------
// Task 27 round 5 (task-27-round5-findings.md): the re-review probes Q1, Q2, Q3, R5a and D4 (N-3), as regression
// tests. The fixture above is the round 4 one, unchanged.

const RATE_MAX = 5400 / 9900; // the highest rate of any plan price
const lab = (g) => (g < DAY ? `${g / HOUR} h` : `${g / DAY} d`);
/** Like a.issue, but only writes the invoice (Stripe has it; the webhook has not been delivered yet). */
function stage(a, reason, lines, t) {
  const id = addInvoice(a.customer, a.sub, { reason, lines, t });
  const inv = S.state.invoices.get(id);
  const fromBalance = inv.total < 0 ? inv.total : Math.min(a.balance, inv.total);
  a.balance -= fromBalance;
  Object.assign(inv, { amount_paid: inv.total - fromBalance, amount_due: inv.total - fromBalance });
  if (inv.total < 0) Object.assign(inv, { amount_paid: 0, amount_due: 0 });
  a.cash += inv.amount_paid;
  a.invs.push(inv);
  return id;
}
const clawReasons = async (a) => (await ledger(a.user.id)).filter((r) => r.op === 'clawback').map((r) => r.reason);

describe('Task 27 round 5, N-1: a plan change claws before it grants (the rollover cap never expires what is about to be clawed)', () => {
  for (const gap of [HOUR, 5 * DAY, 20 * DAY]) {
    it(`Q1: monthly Starter -> yearly Studio -> monthly Starter an hour later, no spending (${lab(gap)} in): the money rule, no debt`, async () => {
      await setV2(true);
      const a = await account({ key: STARTER_M, start: nowS() - 40 * DAY });
      await a.first();
      const p0 = S.state.subs.get(a.sub).current_period_start;
      await a.change(STUDIO_Y, p0 + gap);
      await a.change(STARTER_M, p0 + gap + HOUR);
      await deliver(subUpdated(a.sub));
      const fair = fairOf(a.invs).total;
      expect((await bal(a.user)).available).toBe(fair);
      expect(await a.debt()).toBe(0);
      expect((await ledger(a.user.id)).filter((r) => r.op === 'expire')).toEqual([]);
    });
  }

  for (const gap of [HOUR, 10 * DAY]) {
    it(`Q2: monthly Studio -> yearly Starter, no spending (${lab(gap)} in): the Studio time is clawed, month 0 kept, no debt`, async () => {
      await setV2(true);
      const start = nowS() - gap - 2 * HOUR;
      const a = await account({ key: STUDIO_M, start });
      await a.first();
      await a.change(STARTER_Y, start + gap);
      const yEnd = S.state.subs.get(a.sub).current_period_end;
      const expected = fairOf(a.invs, { running: [yEnd] }).monthly + 1500; // month 0 of the Starter year
      expect((await bal(a.user)).available).toBe(expected);
      expect(await a.debt()).toBe(0);
    });
  }

  it('Q2 then back: monthly Studio -> yearly Starter -> monthly Starter, no spending: no debt', async () => {
    await setV2(true);
    const start = nowS() - 3 * HOUR;
    const a = await account({ key: STUDIO_M, start });
    await a.first();
    await a.change(STARTER_Y, start + HOUR);
    await a.change(STARTER_M, start + 2 * HOUR);
    await deliver(subUpdated(a.sub));
    expect((await bal(a.user)).available).toBe(fairOf(a.invs).total);
    expect(await a.debt()).toBe(0);
  });

  it('R5a: invoice.paid and invoice.payment_succeeded delivered concurrently (create, -> yearly Studio, -> monthly Starter): the money rule, no debt', async () => {
    await setV2(true);
    const start = nowS() - 10 * DAY;
    const a = await account({ key: STARTER_M, start });
    const c = stage(a, 'subscription_create', [planLine(STARTER_M, 2900, start, nextEnd(STARTER_M, start), false)], start);
    await Promise.all([deliver(invoiceAs('invoice.paid', c)), deliver(invoiceAs('invoice.payment_succeeded', c)), deliver(invoiceAs('invoice.paid', c))]);
    const up = stage(a, 'subscription_update', a.changeLines(STUDIO_Y, start + 5 * DAY), start + 5 * DAY);
    await Promise.all([deliver(invoiceAs('invoice.paid', up)), deliver(invoiceAs('invoice.payment_succeeded', up)), deliver(invoiceAs('invoice.paid', up))]);
    const dn = stage(a, 'subscription_update', a.changeLines(STARTER_M, start + 5 * DAY + HOUR), start + 5 * DAY + HOUR);
    await Promise.all([deliver(invoiceAs('invoice.paid', dn)), deliver(invoiceAs('invoice.payment_succeeded', dn)), deliver(subUpdated(a.sub))]);
    await grantYearlyMonths({ now: new Date((start + 300 * DAY) * 1000) });
    const fair = fairOf(a.invs).total;
    expect(await a.net()).toBe(fair);
    expect((await bal(a.user)).available).toBe(fair);
    expect(await a.debt()).toBe(0);
  });

  it('spending first still owes what a downgrade could not take (claw-first keeps the round 4 debt rule)', async () => {
    await setV2(true);
    const start = nowS() - 3 * HOUR;
    const a = await account({ key: STUDIO_M, start });
    await a.first();
    await a.spendAll();
    await a.change(STARTER_Y, start + HOUR);
    const fair = fairOf(a.invs, { running: [S.state.subs.get(a.sub).current_period_end] }).monthly + 1500;
    // Delivered beyond the money rule is exactly what is owed (and the grant that followed paid part of it).
    expect((await a.delivered()) - (await a.debt())).toBe(fair);
    expect(await a.debt()).toBeGreaterThan(0);
  });
});

describe('Task 27 round 5, N-2: time given back on a yearly period counts whatever order the invoices arrive in', () => {
  /** Q3: A (monthly Starter -> yearly Studio) and B (-> monthly Starter an hour later), 3 loops, spending after each event. */
  async function q3(gap, outOfOrder) {
    const a = await account({ key: STARTER_M, start: nowS() - 200 * DAY });
    await a.first();
    await a.spendAll();
    for (let loop = 0; loop < 3; loop += 1) {
      const p0 = S.state.subs.get(a.sub).current_period_start;
      const A = stage(a, 'subscription_update', a.changeLines(STUDIO_Y, p0 + gap), p0 + gap);
      const B = stage(a, 'subscription_update', a.changeLines(STARTER_M, p0 + gap + HOUR), p0 + gap + HOUR);
      const order = outOfOrder ? [B, A] : [A, B];
      await deliver(invoiceAs('invoice.paid', order[0]));
      await a.spendAll();
      if (outOfOrder) await deliver(subUpdated(a.sub));
      await deliver(invoiceAs('invoice.paid', order[1]));
      await a.spendAll();
      if (!outOfOrder) await deliver(subUpdated(a.sub));
      await grantYearlyMonths({ now: new Date((p0 + gap + 2 * HOUR) * 1000) });
      await a.spendAll();
      await a.renew();
      await a.spendAll();
      await deliver(subUpdated(a.sub));
    }
    const negLines = Number((await db.query(
      "select count(*) as n from public.credit_plan_lines where sub_id = $1 and kind = 'year' and amount_cents < 0", [a.sub]
    )).rows[0].n);
    return {
      a, delivered: await a.delivered(), debt: await a.debt(), fair: fairOf(a.invs).total, kept: a.cash - a.balance, negLines,
    };
  }

  for (const gap of [HOUR, 10 * DAY]) {
    it(`Q3 (${lab(gap)} in): the switch back delivered before the switch, spending after each event, 3 loops, delivers what in order does`, async () => {
      await setV2(true);
      const late = await q3(gap, true);
      const inOrder = await q3(gap, false);
      expect(late.negLines).toBe(3); // every unused-time line on a yearly period is recorded, period row or not
      expect(late.delivered).toBeLessThanOrEqual(Math.floor(late.kept * RATE_MAX) + 5400);
      expect(late.delivered - late.debt).toBe(late.fair);
      expect(inOrder.delivered - inOrder.debt).toBe(inOrder.fair);
      expect(late.fair).toBe(inOrder.fair);
      expect(late.delivered - late.debt).toBe(inOrder.delivered - inOrder.debt);
      // Each yearly period a late invoice started was already left by the switch back delivered before it.
      const { rows } = await db.query('select ended_at from public.credit_yearly_periods where sub_id = $1', [late.a.sub]);
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.ended_at)).toBe(true);
    });
  }

  for (const [label, gap] of GAPS) {
    it(`R5b (${label}): out of order with no spending ends where in order does`, async () => {
      await setV2(true);
      async function run(outOfOrder) {
        const a = await account({ key: STARTER_M, start: nowS() - 200 * DAY });
        await a.first();
        const p0 = S.state.subs.get(a.sub).current_period_start;
        const A = stage(a, 'subscription_update', a.changeLines(STUDIO_Y, p0 + gap), p0 + gap);
        const B = stage(a, 'subscription_update', a.changeLines(STARTER_M, p0 + gap + HOUR), p0 + gap + HOUR);
        for (const id of outOfOrder ? [B, A] : [A, B]) await deliver(invoiceAs('invoice.paid', id));
        await deliver(subUpdated(a.sub));
        await grantYearlyMonths({ now: new Date((p0 + gap + 20 * DAY) * 1000) });
        await a.renew();
        await deliver(subUpdated(a.sub));
        await grantYearlyMonths({ now: new Date((nowS() + 400 * DAY) * 1000) });
        return { net: await a.net(), fair: fairOf(a.invs).total, available: (await bal(a.user)).available, debt: await a.debt() };
      }
      const late = await run(true);
      const inOrder = await run(false);
      expect(late.net).toBe(late.fair);
      expect(inOrder.net).toBe(inOrder.fair);
      expect(late.available).toBe(inOrder.available);
      expect(late.debt).toBe(0);
      expect(inOrder.debt).toBe(0);
    });
  }
});

describe('Task 27 round 5, N-3: only a plan-change invoice\'s own clawback can become plan debt', () => {
  /** Yearly Studio, 3 months granted and spent, then refunded in full; `fail` makes the refund's first settle die and the cron run before Stripe's retry. */
  async function d4(fail, { spend = true } = {}) {
    const start = nowS() - 100 * DAY;
    const a = await account({ key: STUDIO_Y, start });
    const inv = await a.first();
    await grantYearlyMonths({ now: new Date((start + 95 * DAY) * 1000) });
    if (spend) await a.spendAll();
    const ch = `ch_${randomUUID().slice(0, 8)}`;
    S.state.charges.set(ch, { id: ch, customer: a.customer, invoice: inv, amount: 118800, amount_refunded: 118800 });
    const event = () => ({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: ch } } });
    if (fail) {
      let n = 0;
      const flaky = {
        query: (sql, params) => {
          if (/credit_period_apply/.test(sql)) {
            n += 1;
            if (n === 1) return Promise.reject(new Error('connection reset'));
          }
          return db.query(sql, params);
        },
      };
      setCreditsDb(flaky);
      setGrantsDb(flaky);
      try {
        expect((await deliver(event())).statusCode).not.toBe(200);
      } finally {
        setCreditsDb(db);
        setGrantsDb(db);
      }
      await grantYearlyMonths({ now: new Date((start + 96 * DAY) * 1000) }); // the cron, before Stripe's retry
    }
    expect((await deliver(event())).statusCode).toBe(200);
    return { a, net: await a.net(), debt: await a.debt(), available: (await bal(a.user)).available, reasons: await clawReasons(a) };
  }

  it('D4: a refund whose settle fails, then the cron, then the retry: no plan debt, and the same result as a clean refund', async () => {
    await setV2(true);
    const clean = await d4(false);
    const failed = await d4(true);
    expect(clean.debt).toBe(0);
    expect(failed.debt).toBe(0);
    expect(failed.reasons).not.toContain('plan_change');
    expect(failed.net).toBe(clean.net);
    expect(failed.available).toBe(clean.available);
    expect(failed.available).toBe(0);
  });

  it('D4 without spending: a full refund settled by the cron leaves nothing, and no debt', async () => {
    await setV2(true);
    const failed = await d4(true, { spend: false });
    expect(failed.net).toBe(0);
    expect(failed.available).toBe(0);
    expect(failed.debt).toBe(0);
    expect(failed.reasons).not.toContain('plan_change');
  });

  it('a plan change processed while a refund\'s settle is still owed books only its own unused time as debt (same as in order)', async () => {
    await setV2(true);
    async function run(fail) {
      const start = nowS() - 100 * DAY;
      const a = await account({ key: STUDIO_Y, start });
      const inv = await a.first();
      await grantYearlyMonths({ now: new Date((start + 95 * DAY) * 1000) });
      await a.spendAll();
      const ch = `ch_${randomUUID().slice(0, 8)}`;
      S.state.charges.set(ch, { id: ch, customer: a.customer, invoice: inv, amount: 118800, amount_refunded: 106920 });
      const event = () => ({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: ch } } });
      if (fail) {
        let n = 0;
        const flaky = {
          query: (sql, params) => {
            if (/credit_period_apply/.test(sql) && (n += 1) === 1) return Promise.reject(new Error('connection reset'));
            return db.query(sql, params);
          },
        };
        setCreditsDb(flaky);
        setGrantsDb(flaky);
        try {
          expect((await deliver(event())).statusCode).not.toBe(200);
        } finally {
          setCreditsDb(db);
          setGrantsDb(db);
        }
      } else {
        expect((await deliver(event())).statusCode).toBe(200);
      }
      await a.change(STARTER_M, start + 96 * DAY, 'invoice.paid');
      await a.spendAll();
      expect((await deliver(event())).statusCode).toBe(200); // Stripe's retry (a replay when nothing failed)
      await deliver(subUpdated(a.sub));
      return { net: await a.net(), debt: await a.debt(), delivered: await a.delivered() };
    }
    const inOrder = await run(false);
    const late = await run(true);
    expect(late.debt).toBe(inOrder.debt);
    expect(late.net).toBe(inOrder.net);
    expect(late.delivered).toBe(inOrder.delivered);
  });

  it('the SQL refuses plan debt for any reason but plan_change', async () => {
    const user = newUser();
    await grantCredits({ userId: user.id, currency: 'video', amount: 100, bucket: 'plan', reason: 'plan_renewal', ref: `r5:${user.id}` });
    await expect(db.query("select public.credit_plan_clawback($1, 500, 'stripe_refund', $2)", [user.id, `r5c:${user.id}`])).rejects.toThrow(/plan_debt_reason/);
    await expect(db.query("select public.credit_plan_clawback($1, 500, 'period_settle', $2)", [user.id, `r5d:${user.id}`])).rejects.toThrow(/plan_debt_reason/);
    // A period claw for any other reason takes what is there and owes nothing.
    const prefix = `period:sub_r5_${user.id.slice(0, 8)}:1`;
    const s = (await db.query("select public.credit_period_state($1, 'cus_none', '{}'::text[], $2) as s", [user.id, prefix])).rows[0].s;
    await db.query("select public.credit_period_apply($1, 'cus_none', '{}'::text[], $2, $3, 'claw', 500, 'period_settle')", [user.id, prefix, s.granted]);
    const { rows } = await db.query("select plan_debt from public.credit_accounts where user_id = $1 and currency = 'video'", [user.id]);
    expect(rows[0].plan_debt).toBe(0);
    expect((await getBalance(user.id)).available).toBe(0);
  });
});
