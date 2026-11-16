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
import { setCreditsDb, getBalance } from '../lib/credits.js';
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
    async issue(reason, lines, t, type = 'invoice.payment_succeeded') {
      const id = addInvoice(customer, sub, { reason, lines, t });
      invs.push(S.state.invoices.get(id));
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
    net: async () => (await ledger(user.id)).reduce((n, r) => {
      if (r.op === 'clawback') return n - r.amount;
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

describe('Task 27 round 4: plan changes credited by money (probes P1-P4, flips at different times)', () => {
  for (const [label, gap] of GAPS) {
    it(`P1 (${label} into each month): monthly Starter -> yearly Studio -> back to monthly Starter, three loops, nets only the money kept`, async () => {
      await setV2(true);
      const a = await account({ key: STARTER_M, start: nowS() - 260 * DAY });
      await a.first();
      for (let loop = 0; loop < 3; loop += 1) {
        const p0 = S.state.subs.get(a.sub).current_period_start;
        await a.change(STUDIO_Y, p0 + gap); // unused Starter credited, the year billed in full
        await a.change(STARTER_M, p0 + gap + HOUR); // unused year credited to the balance, nothing paid
        await deliver(subUpdated(a.sub));
        await a.renew(); // paid (from the balance)
      }
      const fair = fairOf(a.invs);
      expect(await a.net()).toBe(fair.total);
      // In words: about one Starter month per month paid, plus an hour of Studio each loop. Never the 3 x ~4,000 of
      // Studio months the old level markers kept.
      expect(fair.total).toBeLessThanOrEqual(7 * 1500 + 3 * 10);
      expect((await yearlyRow(a.sub)).status).not.toBe('active');
    });

    it(`P2 (${label} into each month): monthly Starter -> Studio upgrade -> immediate downgrade, three loops`, async () => {
      await setV2(true);
      const a = await account({ key: STARTER_M, start: nowS() - 200 * DAY });
      await a.first();
      for (let loop = 0; loop < 3; loop += 1) {
        const p0 = S.state.subs.get(a.sub).current_period_start;
        await a.change(STUDIO_M, p0 + gap);
        await a.change(STARTER_M, p0 + gap + 600); // ten minutes later; the credit goes to the balance
        await a.renew();
      }
      const fair = fairOf(a.invs);
      expect(await a.net()).toBe(fair.total);
      expect(fair.total).toBeLessThanOrEqual(4 * 1500 + 3 * 5);
    });

    it(`converse (${label} into the month): monthly Studio -> yearly Starter claws the Studio time credited back`, async () => {
      await setV2(true);
      const start = nowS() - gap - 2 * HOUR;
      const a = await account({ key: STUDIO_M, start });
      await a.first();
      await a.change(STARTER_Y, start + gap);
      const yEnd = S.state.subs.get(a.sub).current_period_end;
      const fair = fairOf(a.invs, { running: [yEnd] });
      // Studio for the time used, then month 0 of the paid year.
      expect(await a.net()).toBe(fair.monthly + 1500);
      expect(fair.monthly).toBeLessThan(5400);
      // The whole year, month by month: exactly the year paid for.
      await grantYearlyMonths({ now: new Date((yEnd - DAY) * 1000) });
      expect(await a.net()).toBe(fair.monthly + 12 * 1500);
    });
  }

  it('P3: yearly upgrade, partial refund, more months, full refund: never more than the money kept, and the year totals it', async () => {
    await setV2(true);
    const start = nowS() - 10 * DAY;
    const a = await account({ key: STARTER_Y, start });
    await a.first();
    const yEnd = S.state.subs.get(a.sub).current_period_end;
    const up = await a.change(STUDIO_Y, start + 10 * DAY);
    const upInv = S.state.invoices.get(up);
    const upCredits = upInv.lines.data.reduce((n, l) => n + creditsFor(l.price.lookup_key, l.amount), 0);
    const half = Math.floor(upInv.total / 2);
    const entitled = (share) => 18000 + upCredits - Math.ceil(upCredits * share);
    await grantYearlyMonths({ now: new Date((start + 70 * DAY) * 1000) }); // months 1..2 at Studio
    expect(await a.net()).toBeLessThanOrEqual(entitled(0));
    await refund(a.customer, up, upInv.total, half);
    expect(await a.net()).toBeLessThanOrEqual(entitled(half / upInv.total));
    await grantYearlyMonths({ now: new Date((start + 130 * DAY) * 1000) }); // months 3..4, bounded by the lowered money
    expect(await a.net()).toBeLessThanOrEqual(entitled(half / upInv.total));
    await refund(a.customer, up, upInv.total, upInv.total);
    expect(await a.net()).toBeLessThanOrEqual(18000);
    await grantYearlyMonths({ now: new Date((yEnd - DAY) * 1000) });
    // The upgrade money is all back: the year gives exactly the Starter year paid for.
    expect(await a.net()).toBe(18000);
  });

  it('S3b: a refund whose clawback dies half-way finishes the job when Stripe retries it', async () => {
    await setV2(true);
    const base = nowS() - 100 * DAY;
    async function run(failAt) {
      const a = await account({ key: STARTER_Y, start: base });
      await a.first();
      const up = await a.change(STUDIO_Y, base + 5 * DAY);
      await grantYearlyMonths({ now: new Date((base + 100 * DAY) * 1000) }); // months 1..3 at Studio
      const upInv = S.state.invoices.get(up);
      const ch = `ch_${randomUUID().slice(0, 8)}`;
      S.state.charges.set(ch, { id: ch, customer: a.customer, invoice: up, amount: upInv.total, amount_refunded: 0, disputed: true });
      S.api.disputes.list = async () => ({ data: [{ id: `dp_${ch}`, amount: upInv.total }] });
      const event = { id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: { id: `dp_${ch}`, charge: ch, amount: upInv.total } } };
      let calls = 0;
      const flaky = {
        query: (sql, params) => {
          if (failAt && /credit_clawback|credit_period_apply/.test(sql)) {
            calls += 1;
            if (calls === failAt) return Promise.reject(new Error('connection reset'));
          }
          return db.query(sql, params);
        },
      };
      setCreditsDb(flaky);
      setGrantsDb(flaky);
      try {
        const first = await deliver(event);
        if (failAt && calls >= failAt) expect(first.statusCode).toBe(500);
        expect((await deliver(event)).statusCode).toBe(200); // Stripe's retry of the same event
      } finally {
        setCreditsDb(db);
        setGrantsDb(db);
        S.api.disputes.list = async () => ({ data: [] });
      }
      return a.net();
    }
    const clean = await run(0);
    expect(clean).toBeLessThanOrEqual(18000);
    for (const failAt of [1, 2, 3]) expect(await run(failAt)).toBe(clean);
  });

  for (const offsetDays of [0, 20]) {
    it(`P4: a switch to yearly with no unused-time line, ${offsetDays} days into the paid month, grants month 0 in full`, async () => {
      await setV2(true);
      const yStart = nowS() - HOUR;
      const a = await account({ key: STARTER_M, start: yStart - offsetDays * DAY });
      await a.first();
      setPrice(a.sub, STARTER_Y);
      Object.assign(S.state.subs.get(a.sub), { current_period_start: yStart, current_period_end: nextEnd(STARTER_Y, yStart) });
      // proration_behavior none: nothing credited back, the year billed in full.
      await a.issue('subscription_update', [planLine(STARTER_Y, 34800, yStart, nextEnd(STARTER_Y, yStart), true)], yStart);
      const rows = await ledger(a.user.id);
      const m0 = rows.filter((r) => r.ref.endsWith(':m0'));
      expect(m0.map((r) => [r.op, r.amount])).toEqual([['renew', 1500]]);
      expect(await a.net()).toBe(1500 + 1500);
    });
  }

  it('a downgrade invoice delivered as invoice.paid (negative total, nothing charged) claws the credited time', async () => {
    await setV2(true);
    const start = nowS() - 12 * DAY;
    const a = await account({ key: STUDIO_M, start });
    await a.first();
    await a.change(CREATOR_M, start + 12 * DAY - HOUR, 'invoice.paid');
    const fair = fairOf(a.invs);
    expect(fair.total).toBeLessThan(5400);
    expect(await a.net()).toBe(fair.total);
  });

  it('prorations left for the cycle invoice (create_prorations) are priced on that invoice', async () => {
    await setV2(true);
    const start = nowS() - 31 * DAY;
    const a = await account({ key: STUDIO_M, start });
    await a.first();
    const lines = a.changeLines(STARTER_M, start + 15 * DAY); // not invoiced now
    await a.renew(lines);
    const fair = fairOf(a.invs);
    expect(await a.net()).toBe(fair.total);
    expect(fair.total).toBeLessThan(5400 + 1500);
  });

  it('a yearly upgrade gives the current month\'s prorated step at once and the new level monthly; the year totals the money', async () => {
    await setV2(true);
    const start = nowS() - 45 * DAY;
    const a = await account({ key: STARTER_Y, start });
    await a.first();
    await grantYearlyMonths({ now: new Date((start + 32 * DAY) * 1000) }); // month 1
    const yEnd = S.state.subs.get(a.sub).current_period_end;
    await a.change(STUDIO_Y, start + 45 * DAY);
    const fair = fairOf(a.invs, { running: [yEnd] });
    const E = fair.periods.get(yEnd);
    const before = 2 * 1500;
    const step = (await a.net()) - before;
    // About (5400 - 1500) x the part of month 1 that is left: roughly 2 weeks of 4.
    expect(step).toBeGreaterThan(3900 * 0.4);
    expect(step).toBeLessThan(3900 * 0.6);
    expect((await yearlyRow(a.sub)).credits).toBe(5400);
    await grantYearlyMonths({ now: new Date((start + 65 * DAY) * 1000) }); // month 2
    expect((await renews(a.user)).at(-1).amount).toBe(5400);
    await grantYearlyMonths({ now: new Date((yEnd - DAY) * 1000) });
    expect(await a.net()).toBe(E);
  });
});

// The round 1-3 findings that the level markers answered, re-expressed by money with Stripe-shaped lines at their
// own times (they replace the tests that pinned the markers' refs and levels, see task-27-report.md round 4).
describe('Task 27 rounds 1-3, re-expressed by money', () => {
  const dispute = async (a, invoiceId, amount) => {
    const ch = `ch_${randomUUID().slice(0, 8)}`;
    S.state.charges.set(ch, { id: ch, customer: a.customer, invoice: invoiceId, amount, amount_refunded: 0, disputed: true });
    S.api.disputes.list = async () => ({ data: [{ id: `dp_${ch}`, amount }] });
    try {
      return await deliver({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: { id: `dp_${ch}`, charge: ch, amount } } });
    } finally {
      S.api.disputes.list = async () => ({ data: [] });
    }
  };
  const invTotal = (id) => S.state.invoices.get(id).total;
  const toYearEnd = (a) => grantYearlyMonths({ now: new Date((S.state.subs.get(a.sub).current_period_end - DAY) * 1000) });

  it('F-C1 / A1: an upgrade one hour before renewal gives only that hour of the difference', async () => {
    await setV2(true);
    const start = nowS() - 30 * DAY;
    const a = await account({ key: STARTER_M, start });
    await a.first();
    await a.change(STUDIO_M, S.state.subs.get(a.sub).current_period_end - HOUR);
    const step = (await a.net()) - 1500;
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(7); // (5400 - 1500) x 1 h / ~720 h, about 5
    expect(await a.net()).toBe(fairOf(a.invs).total);
  });

  it('F-I6 / A6: a second upgrade in the period gives the prorated rest; a later down and up again nets nothing', async () => {
    await setV2(true);
    const start = nowS() - 20 * DAY;
    const a = await account({ key: STARTER_M, start });
    await a.first();
    await a.change(CREATOR_M, start + 5 * DAY);
    await a.change(STUDIO_M, start + 10 * DAY);
    const afterUps = await a.net();
    expect(afterUps).toBe(fairOf(a.invs).total);
    const left = (S.state.subs.get(a.sub).current_period_end - (start + 10 * DAY)) / (S.state.subs.get(a.sub).current_period_end - start);
    expect(Math.abs(afterUps - (1500 + 1100 * (1 - 5 / 30.5) + 2800 * left))).toBeLessThan(40);
    await a.change(CREATOR_M, start + 12 * DAY);
    await a.change(STUDIO_M, start + 12 * DAY + HOUR); // paid from the balance the downgrade left
    const pair = (await a.net()) - afterUps;
    // An hour on Creator instead of Studio is about (5400 - 2600) / 720 = 4 credits less, and each of the four lines
    // rounds toward the business by under one credit.
    expect(pair).toBeLessThanOrEqual(0);
    expect(pair).toBeGreaterThanOrEqual(-9);
  });

  it('R1: down and back up in one period (the way back paid from the balance) gives nothing new', async () => {
    await setV2(true);
    const start = nowS() - 10 * DAY;
    const a = await account({ key: STUDIO_M, start });
    await a.first(); // 5400 for this period
    await a.change(STARTER_M, start + 5 * DAY);
    await a.change(STUDIO_M, start + 5 * DAY + 60);
    expect(await a.net()).toBeLessThanOrEqual(5400);
    expect(await a.net()).toBeGreaterThanOrEqual(5397);
  });

  it('R1 (yearly): down and back up within a granted month gives nothing new', async () => {
    await setV2(true);
    const start = nowS() - 10 * DAY;
    const a = await account({ key: STUDIO_Y, start });
    await a.first(); // month 0 at 5400
    await a.change(STARTER_Y, start + 5 * DAY);
    await a.change(STUDIO_Y, start + 5 * DAY + 60);
    expect(await a.net()).toBeLessThanOrEqual(5400);
    await toYearEnd(a);
    expect(await a.net()).toBeLessThanOrEqual(12 * 5400);
    expect(await a.net()).toBeGreaterThanOrEqual(12 * 5400 - 5);
  });

  it('a late upgrade webhook (after the renewal) is priced by its own lines, whatever the order', async () => {
    await setV2(true);
    const start = nowS() - 40 * DAY;
    const a = await account({ key: STARTER_M, start });
    await a.first();
    const lines = a.changeLines(STUDIO_M, start + 15 * DAY);
    const up = addInvoice(a.customer, a.sub, { reason: 'subscription_update', lines, t: start + 15 * DAY });
    a.invs.push(S.state.invoices.get(up));
    await a.renew(); // the renewal (at Studio) is delivered first
    await deliver(invoiceEvent(up));
    expect(await a.net()).toBe(fairOf(a.invs).total);
    expect((await upgrades(a.user)).map((r) => r.ref)).toEqual([`upgrade:${up}`]);
  });

  it('O2: a partial yearly refund claws nothing yet; later months are smaller and the year gives what was kept', async () => {
    await setV2(true);
    const start = nowS() - 40 * DAY;
    const a = await account({ key: CREATOR_Y, start });
    const inv = await a.first();
    await grantYearlyMonths(); // month 1
    await refund(a.customer, inv, 58800, 5880); // 10 %
    expect((await ledger(a.user.id)).filter((r) => r.op === 'clawback')).toEqual([]);
    await grantYearlyMonths({ now: new Date((start + 70 * DAY) * 1000) }); // month 2
    const month2 = (await renews(a.user)).at(-1);
    expect(month2.amount).toBeLessThan(2600);
    expect(month2.amount).toBeGreaterThan(2200);
    expect((await yearlyRow(a.sub)).status).toBe('active');
    await toYearEnd(a);
    expect(await a.net()).toBe(31200 - 3120);
  });

  it('O2: a dispute after N months takes back every month granted so far and stops the year', async () => {
    await setV2(true);
    const start = nowS() - 70 * DAY;
    const a = await account({ key: STARTER_Y, start });
    const inv = await a.first();
    await grantYearlyMonths(); // months 1..2
    await dispute(a, inv, 34800);
    const claws = (await ledger(a.user.id)).filter((r) => r.reason === 'stripe_dispute');
    expect(claws.reduce((n, r) => n + r.amount, 0)).toBe(3 * 1500);
    expect((await bal(a.user)).available).toBe(0);
    expect((await yearlyRow(a.sub)).status).toBe('refunded');
    await toYearEnd(a);
    expect(await a.net()).toBe(0);
  });

  it('O1 / A11: a dispute on a paid monthly upgrade invoice takes back what the upgrade gave', async () => {
    await setV2(true);
    const start = nowS() - 5 * DAY;
    const a = await account({ key: STARTER_M, start });
    await a.first();
    const up = await a.change(STUDIO_M, start + 5 * DAY);
    const [grant] = await upgrades(a.user);
    expect(grant.amount).toBeGreaterThan(2000);
    await dispute(a, up, invTotal(up));
    const claw = (await ledger(a.user.id)).filter((r) => r.reason === 'stripe_dispute');
    expect(claw.map((r) => r.amount)).toEqual([grant.amount]);
    expect(await a.net()).toBe(1500 + fairOf(a.invs).total - 1500 - grant.amount);
  });

  it('F-I5 / A5: refunding a yearly upgrade in full keeps the year running on the money kept', async () => {
    await setV2(true);
    const start = nowS() - 40 * DAY;
    const a = await account({ key: STARTER_Y, start });
    await a.first();
    await grantYearlyMonths(); // month 1
    const up = await a.change(STUDIO_Y, start + 40 * DAY);
    expect((await yearlyRow(a.sub)).credits).toBe(5400);
    expect((await refund(a.customer, up, invTotal(up), invTotal(up))).statusCode).toBe(200);
    expect(await a.net()).toBe(3000); // the upgrade's step for this month taken back
    expect((await yearlyRow(a.sub)).status).toBe('active');
    await grantYearlyMonths({ now: new Date((start + 70 * DAY) * 1000) }); // month 2: the Starter money still buys 1500
    expect((await renews(a.user)).at(-1).amount).toBe(1500);
    await toYearEnd(a);
    expect(await a.net()).toBe(18000);
  });

  it('S2: yearly <-> monthly flips (and up a plan) three times, each at its own time, give only the money kept', async () => {
    await setV2(true);
    const a = await account({ key: STARTER_M, start: nowS() - 200 * DAY });
    await a.first();
    let t = S.state.subs.get(a.sub).current_period_start;
    const step = async (key, gap) => {
      t += gap;
      await a.change(key, t);
    };
    await step(STARTER_Y, 3 * DAY);
    await step(STUDIO_M, 2 * DAY);
    for (let i = 0; i < 3; i += 1) {
      await step(STARTER_Y, 4 * DAY);
      await step(STUDIO_M, HOUR);
      await step(STUDIO_Y, 2 * DAY);
      await step(STUDIO_M, 3 * HOUR);
    }
    const fair = fairOf(a.invs);
    expect(await a.net()).toBe(fair.total);
    // About: 3 days of Starter, a month of Studio paid at the last switch, and the days spent on each plan.
    expect(fair.total).toBeLessThan(1500 + 5400 + 5400);
  });

  it('S3 / S4: refunds of yearly upgrades never leave more than the money kept, and the year gives exactly that', async () => {
    await setV2(true);
    const start = nowS() - 100 * DAY;
    const a = await account({ key: STARTER_Y, start });
    await a.first();
    const up1 = await a.change(CREATOR_Y, start + 2 * DAY);
    const up2 = await a.change(STUDIO_Y, start + 4 * DAY);
    await grantYearlyMonths(); // months 1..3 at Studio
    const yEnd = S.state.subs.get(a.sub).current_period_end;
    const partOf = (id) => S.state.invoices.get(id).lines.data.reduce((n, l) => n + creditsFor(l.price.lookup_key, l.amount), 0);
    const n1 = partOf(up1);
    const n2 = partOf(up2);
    expect(await a.net()).toBeLessThanOrEqual(18000 + n1 + n2);
    await dispute(a, up1, invTotal(up1)); // the earlier upgrade, in full
    expect(await a.net()).toBeLessThanOrEqual(18000 + n2);
    const half = Math.floor(invTotal(up2) / 2);
    await refund(a.customer, up2, invTotal(up2), half); // half of the later one
    const entitled = 18000 + n2 - Math.ceil((n2 * half) / invTotal(up2));
    expect(await a.net()).toBeLessThanOrEqual(entitled);
    await grantYearlyMonths({ now: new Date((yEnd - DAY) * 1000) });
    expect(await a.net()).toBe(entitled);
  });

  it('a retried yearly upgrade invoice (died before it was marked done) credits nothing twice', async () => {
    await setV2(true);
    const start = nowS() - 10 * DAY;
    const a = await account({ key: STARTER_Y, start });
    await a.first();
    const up = await a.change(STUDIO_Y, start + 10 * DAY);
    const once = await a.net();
    await db.query('delete from public.stripe_events where id = $1', [`invoice:${up}:done`]);
    await deliver(invoiceEvent(up));
    expect(await a.net()).toBe(once);
    const { rows } = await db.query('select count(*)::int as n from public.credit_plan_lines where invoice_id = $1', [up]);
    expect(rows[0].n).toBe(2);
  });
});
