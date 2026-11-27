import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';

// ---- in-memory Stripe (never the live account) ----------------------
const S = vi.hoisted(() => {
  const state = {
    customers: new Map(),
    sessions: new Map(),
    subs: new Map(),
    invoices: new Map(),
    charges: new Map(),
    disputes: new Map(),
    paymentIntents: new Map(),
    failCustomerUpdates: 0,
    failSessionRetrieves: 0,
    created: [], // checkout.sessions.create params
    cancelledSubs: [], // subscriptions.cancel calls
    updates: [], // customers.update calls: { id, metadata }
    failUpdatesFor: new Map(), // customer id -> failures left
    creditWrites: new Map(), // customer id -> number of customers.update calls
    beforeUpdate: null, // async (id) => {}: lets a test hold a customers.update in flight
    failSessionCreate: null, // error message for the next checkout.sessions.create
  };
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const clone = (o) => (o === undefined ? o : structuredClone(o));
  const api = {
    customers: {
      retrieve: async (id) => {
        await tick();
        const c = state.customers.get(id);
        if (!c) throw Object.assign(new Error(`No such customer: ${id}`), { code: 'resource_missing' });
        return clone(c);
      },
      search: async ({ query }) => {
        const m = /metadata\['supabase_user_id'\]:'([^']+)'/.exec(query);
        return { data: [...state.customers.values()].filter((c) => m && c.metadata?.supabase_user_id === m[1]).map(clone) };
      },
      list: async ({ email }) => ({ data: [...state.customers.values()].filter((c) => c.email === email).map(clone) }),
      update: async (id, { metadata }) => {
        await tick();
        if (state.beforeUpdate) await state.beforeUpdate(id);
        if (state.failCustomerUpdates > 0) {
          state.failCustomerUpdates -= 1;
          throw new Error('stripe unavailable');
        }
        if (state.failUpdatesFor.get(id) > 0) {
          state.failUpdatesFor.set(id, state.failUpdatesFor.get(id) - 1);
          throw new Error('stripe unavailable');
        }
        const c = state.customers.get(id);
        if (!c || c.deleted) throw Object.assign(new Error(`No such customer: ${id}`), { code: 'resource_missing' });
        state.updates.push({ id, metadata: { ...metadata } });
        // In these flows only a grant writes customer metadata.
        state.creditWrites.set(id, (state.creditWrites.get(id) || 0) + 1);
        // Stripe merges metadata: listed keys are set, '' removes a key.
        const next = { ...c.metadata };
        for (const [k, v] of Object.entries(metadata || {})) {
          if (v === '') delete next[k];
          else next[k] = v;
        }
        c.metadata = next;
        return clone(c);
      },
    },
    checkout: {
      sessions: {
        retrieve: async (id) => {
          await tick();
          if (state.failSessionRetrieves > 0) {
            state.failSessionRetrieves -= 1;
            throw new Error('stripe unavailable');
          }
          const s = state.sessions.get(id);
          if (!s) throw new Error(`No such session: ${id}`);
          return clone(s);
        },
        list: async ({ payment_intent }) => ({
          data: [...state.sessions.values()].filter((s) => s.payment_intent === payment_intent).map(clone),
        }),
        create: async (params) => {
          if (state.failSessionCreate) {
            const message = state.failSessionCreate;
            state.failSessionCreate = null;
            throw new Error(message);
          }
          state.created.push(params);
          const id = `cs_test_new_${state.created.length}_${Math.random().toString(36).slice(2, 10)}`;
          const s = { id, object: 'checkout.session', ...structuredClone(params), payment_status: 'unpaid', created: Math.floor(Date.now() / 1000), url: `https://checkout.stripe.test/${id}` };
          state.sessions.set(id, s);
          return clone(s);
        },
      },
    },
    subscriptions: {
      retrieve: async (id) => clone(state.subs.get(id)),
      // The one-plan guard (lib/planGuard.js) cancels a refused second plan.
      cancel: async (id) => {
        const x = state.subs.get(id);
        if (x) x.status = 'canceled';
        state.cancelledSubs.push(id);
        return clone(x);
      },
      // Paginated like Stripe: `limit` per page, `starting_after`, `has_more`.
      list: async ({ customer, status, limit = 10, starting_after: after }) => {
        const all = [...state.subs.values()].filter(
          (x) => x.customer === customer && (status === 'all' || x.status === status)
        );
        const from = after ? all.findIndex((x) => x.id === after) + 1 : 0;
        return { data: all.slice(from, from + limit).map(clone), has_more: from + limit < all.length };
      },
    },
    invoices: { retrieve: async (id) => clone(state.invoices.get(id)) },
    charges: { retrieve: async (id) => clone(state.charges.get(id)) },
    paymentIntents: {
      retrieve: async (id, { expand = [] } = {}) => {
        const pi = clone(state.paymentIntents.get(id));
        if (!pi) throw Object.assign(new Error(`No such payment_intent: ${id}`), { code: 'resource_missing' });
        if (expand.includes('latest_charge') && typeof pi.latest_charge === 'string') {
          pi.latest_charge = clone(state.charges.get(pi.latest_charge)) || pi.latest_charge;
        }
        return pi;
      },
    },
    disputes: {
      list: async ({ charge }) => ({ data: [...state.disputes.values()].filter((d) => d.charge === charge).map(clone) }),
    },
    webhooks: { constructEvent: (raw) => JSON.parse(raw.toString('utf8')) },
  };
  return { state, api };
});

const auth = vi.hoisted(() => ({ user: null, db: null, failProfileRead: false, users: [], endlessUsers: false, listCalls: 0 }));

vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stripe: () => S.api,
    getOrCreatePrice: async (plan) => ({ id: `price_${plan}`, lookup_key: actual.PLANS[plan].lookupKey }),
    getOrCreateTopupPrice: async (pack) => ({ id: `price_topup_${pack}`, lookup_key: actual.TOPUPS[pack].lookupKey }),
    getOrCreateV2Price: async (offer) => ({
      id: `price_v2_${offer.kind}`,
      lookup_key: offer.kind === 'plan'
        ? actual.v2PlanLookupKey(offer)
        : actual.v2TopupLookupKey(offer),
    }),
  };
});
vi.mock('../../lib/meta', () => ({ sendCapiEvent: vi.fn(async () => {}) }));
vi.mock('../../lib/supabaseServer', () => {
  // Writes profile links into the PGlite profiles table.
  const profileClient = {
    // pages/api/admin/heal-topups.js finds the account by email.
    auth: {
      admin: {
        // Paginated like Supabase: `perPage` users per page, pages from 1,
        // and nextPage (null on the last page).
        listUsers: async ({ page = 1, perPage = 50 } = {}) => {
          auth.listCalls += 1;
          if (auth.endlessUsers) {
            const users = Array.from({ length: perPage }, (_, i) => ({ id: `filler-${page}-${i}`, email: `filler-${page}-${i}@example.test` }));
            return { data: { users, nextPage: page + 1 }, error: null };
          }
          const users = auth.users.slice((page - 1) * perPage, page * perPage);
          return { data: { users, nextPage: page * perPage < auth.users.length ? page + 1 : null }, error: null };
        },
      },
    },
    from: () => ({
      select: () => ({
        eq: (_col, id) => ({
          maybeSingle: async () => {
            if (auth.failProfileRead) return { data: null, error: { message: 'db down', code: '08006' } };
            const { rows } = await auth.db.query('select stripe_customer_id from public.profiles where id = $1', [id]);
            return { data: rows[0] || null, error: null };
          },
        }),
      }),
      upsert: async (row) => {
        await auth.db.query(
          `insert into public.profiles (id, stripe_customer_id) values ($1, $2)
           on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id`,
          [row.id, row.stripe_customer_id]
        );
        return { error: null };
      },
    }),
  };
  return {
    getUserFromRequest: async () => (auth.user ? { user: auth.user, supabase: profileClient } : null),
    getSupabaseAdmin: () => profileClient,
  };
});

import { TOPUPS, PLANS } from '../../lib/stripe';
import { KEY } from '../../lib/metaKeys';
import { setCreditsDb, getBalance } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { setGrantsDb, hashClaimTicket, checkSessionOwner, GrantInProgressError } from '../../lib/grants.js';
import { signClaimNonces, verifyClaimNonces } from '../../lib/jobToken.js';
const signClaimNonce = (nonce) => signClaimNonces([nonce]);
const verifyClaimNonce = (signed) => verifyClaimNonces(signed)?.[0]?.nonce ?? null;
import webhook from '../../pages/api/stripe-webhook.js';
import confirm from '../../pages/api/checkout/confirm.js';
import claimTicket from '../../pages/api/checkout/claim-ticket.js';
import claim from '../../pages/api/checkout/claim.js';
import checkout from '../../pages/api/checkout.js';
import heal from '../../pages/api/admin/heal-topups.js';
import { getEntitlement, linkStripeCustomerToProfile, assertCanLink } from '../../lib/entitlement';
import { relinkModeStrict } from '../../lib/billingFlags.js';
import { getSupabaseAdmin } from '../../lib/supabaseServer';
import { renewPlanCredits } from '../../lib/credits.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  auth.db = db;
  setCreditsDb(db);
  setPricingDb(db);
  setGrantsDb(db);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  setPricingDb(null);
  setGrantsDb(null);
  await db?.close();
});

beforeEach(() => {
  auth.user = null;
  S.state.failCustomerUpdates = 0;
  S.state.failSessionRetrieves = 0;
  S.state.beforeUpdate = null;
  S.state.failSessionCreate = null;
});

// ---- builders -------------------------------------------------------
const nowS = () => Math.floor(Date.now() / 1000);
const TOPUP_S = TOPUPS.s; // 2,280 legacy video credits, $15
const V2_TOPUP_S = Math.ceil((TOPUP_S.credits * 21) / 100); // 479
const V2_MONTHLY = Math.ceil((PLANS.monthly.cap * 21) / 100); // 160

// While billing_v2 is on, only this app's own (ariya_v2_*) prices are credited, so the fixtures sell v2 prices
// then (same credit amounts as the converted legacy ones); with it off they sell the classic (ariyalab_*) ones.
let flagOn = false;
const v2TopupKey = (pack) => `ariya_v2_topup_${pack}_${TOPUPS[pack].amountCents}_${Math.ceil((TOPUPS[pack].credits * 21) / 100)}`;
const v2MonthlyKey = `ariya_v2_starter_month_${PLANS.monthly.amountCents}_${V2_MONTHLY}`;
const topupKeyFor = (pack) => (flagOn ? v2TopupKey(pack) : TOPUPS[pack].lookupKey);
const monthlyKey = () => (flagOn ? v2MonthlyKey : PLANS.monthly.lookupKey);

function newUser(email) {
  const id = randomUUID();
  return { id, email: email || `${id.slice(0, 8)}@example.test`, email_confirmed_at: '2026-11-01T00:00:00Z' };
}
function newCustomer(metadata = {}, email = null) {
  const id = `cus_${randomUUID().slice(0, 12)}`;
  S.state.customers.set(id, { id, email, metadata });
  return id;
}
let seq = 0;
function topupSession({ customer, buyer, pack = 's', created = nowS(), email, extra = {} }) {
  seq += 1;
  const id = `cs_test_${String(seq).padStart(4, '0')}_${randomUUID().replace(/-/g, '')}`;
  const s = {
    id,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    customer,
    client_reference_id: buyer ? buyer.id : null,
    metadata: buyer ? { supabase_user_id: buyer.id } : {},
    customer_details: { email: email ?? buyer?.email ?? null },
    created,
    payment_intent: `pi_${id}`,
    amount_total: TOPUPS[pack].amountCents,
    line_items: { data: [{ price: { lookup_key: topupKeyFor(pack) } }] },
    ...extra,
  };
  S.state.sessions.set(id, s);
  return s;
}
function subSession({ customer, metadata = {}, email = null, created = nowS(), extra = {} }) {
  seq += 1;
  const id = `cs_test_sub_${seq}_${randomUUID().replace(/-/g, '')}`;
  const subId = `sub_${id}`;
  // The session's subscription is the customer's existing one when it has one (the invoice paid for it),
  // not a second plan (the one-plan guard would refuse that under v2).
  const existingSub = [...S.state.subs.values()].find((x) => x.customer === customer);
  const sub = existingSub || { id: subId, status: 'active', current_period_start: nowS(), items: { data: [{ price: { lookup_key: monthlyKey() } }] } };
  if (!existingSub) S.state.subs.set(subId, sub);
  const s = {
    id,
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'paid',
    customer,
    client_reference_id: null,
    metadata,
    customer_details: { email },
    created,
    subscription: existingSub || sub,
    amount_total: PLANS.monthly.amountCents,
    line_items: { data: [{ price: { lookup_key: monthlyKey() } }] },
    ...extra,
  };
  S.state.sessions.set(id, s);
  return s;
}
function paidInvoice({ customer, subId, reason = 'subscription_create' }) {
  const id = `in_${randomUUID().slice(0, 12)}`;
  const inv = { id, customer, subscription: subId, status: 'paid', amount_paid: PLANS.monthly.amountCents, billing_reason: reason, currency: 'usd' };
  S.state.invoices.set(id, inv);
  return inv;
}
function newSub(customer) {
  const subId = `sub_${randomUUID().slice(0, 12)}`;
  S.state.subs.set(subId, { id: subId, customer, status: 'active', current_period_start: nowS(), items: { data: [{ price: { lookup_key: monthlyKey() } }] } });
  return subId;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    end(payload) {
      res.body = payload;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    getHeader(name) {
      return res.headers[name];
    },
  };
  return res;
}

async function deliver(event) {
  const raw = Buffer.from(JSON.stringify(event));
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=test' },
    async *[Symbol.asyncIterator]() {
      yield raw;
    },
  };
  const res = makeRes();
  await webhook(req, res);
  return res;
}
const completedEvent = (session, id = `evt_${randomUUID()}`) => ({
  id,
  type: 'checkout.session.completed',
  data: { object: { id: session.id, mode: session.mode, payment_status: session.payment_status, customer: session.customer } },
});

async function callRoute(route, { user, query = {}, cookies = {} }) {
  auth.user = user;
  const res = makeRes();
  await route({ method: 'POST', query, cookies, headers: {} }, res);
  return res;
}
const confirmAs = (user, sessionId, cookies) => callRoute(confirm, { user, query: { session_id: sessionId }, cookies });

const creditWrites = (customerId) => S.state.creditWrites.get(customerId) || 0;
const legacyCredits = (customerId) => parseInt(S.state.customers.get(customerId).metadata[KEY.credits] || '0', 10);
const recorded = async (id) => (await db.query('select 1 from public.stripe_events where id = $1', [id])).rows.length > 0;
const link = (userId, customerId) =>
  db.query(
    `insert into public.profiles (id, stripe_customer_id) values ($1, $2)
     on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id`,
    [userId, customerId]
  );

async function setBillingV2(on) {
  flagOn = Boolean(on);
  await db.query("delete from public.pricing_config where key = 'billing_v2'");
  if (on) await db.query("insert into public.pricing_config (key, value) values ('billing_v2', 'true'::jsonb)");
  _resetPricingCache();
}
// 'support' is the default (no row). 'auto' lets customer-triggered paths move
// a profile off an existing customer.
async function setRelinkMode(mode) {
  await db.query("delete from public.pricing_config where key = 'relink_mode'");
  if (mode !== 'support') {
    await db.query("insert into public.pricing_config (key, value) values ('relink_mode', $1::jsonb)", [JSON.stringify(mode)]);
  }
  _resetPricingCache();
}

// =====================================================================
describe('billing_v2 off (legacy metadata grants)', () => {
  beforeAll(() => setBillingV2(false));

  it('same event id grants once', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });
    const event = completedEvent(session);

    // The webhook ignores a classic price whatever the flag says (classic's own endpoint credits it); the grant
    // here is /confirm's (a sonallo legacy sale while billing v2 is still off).
    expect((await deliver(event)).statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(0);
    const results = await Promise.all([confirmAs(buyer, session.id), confirmAs(buyer, session.id)]);
    const again = await confirmAs(buyer, session.id);
    // A call racing the one that holds the grant lock answers in progress; it never grants.
    for (const r of [...results, again]) expect(r.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    // Two racing grants can lose an update and still end at 2,280: count the writes.
    expect(creditWrites(customer)).toBe(1);
    expect(await recorded(`checkout:${session.id}`)).toBe(true);
  });

  it('webhook and /confirm racing on one session grant once', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });

    const event = completedEvent(session);
    const [hook, conf] = await Promise.all([deliver(event), confirmAs(buyer, session.id)]);

    // The webhook ignores the classic price (200, writes nothing); /confirm grants once.
    expect(hook.statusCode).toBe(200);
    expect(conf.statusCode).toBe(200);
    expect((await deliver(event)).statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    expect(creditWrites(customer)).toBe(1);
  });

  it('a handler error returns 500 (so Stripe retries) and does not record the event', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });
    const event = completedEvent(session);

    S.state.failCustomerUpdates = 1;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failed;
    try {
      failed = await confirmAs(buyer, session.id);
    } finally {
      errors.mockRestore();
    }
    expect(failed.statusCode).toBe(500);
    expect(await recorded(`checkout:${session.id}`)).toBe(false);
    expect(legacyCredits(customer)).toBe(0);

    const retried = await confirmAs(buyer, session.id);
    expect(retried.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    // The webhook ignores the classic price either way.
    expect((await deliver(event)).statusCode).toBe(200);
  });

  it('/confirm with a session whose client_reference_id or customer email does not match the caller returns 403', async () => {
    const owner = newUser();
    const stranger = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer: owner });

    const denied = await confirmAs(stranger, session.id);
    expect(denied.statusCode).toBe(403);
    expect(legacyCredits(customer)).toBe(0);
    expect((await db.query('select 1 from public.profiles where id = $1', [stranger.id])).rows).toHaveLength(0);

    const ok = await confirmAs(owner, session.id);
    expect(ok.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
  });

  it('/confirm accepts a matching verified email and rejects an unverified one', async () => {
    const payer = newUser('Payer@Example.test');
    const customer = newCustomer();
    // No client_reference_id or metadata: only the email ties it to the caller.
    const session = topupSession({ customer, buyer: null, email: 'payer@example.test' });

    const unverified = await confirmAs({ ...payer, email_confirmed_at: null }, session.id);
    expect(unverified.statusCode).toBe(403);

    const ok = await confirmAs(payer, session.id);
    expect(ok.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
  });

  it('replaying an old top-up session after 11 newer ones grants nothing', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const sessions = Array.from({ length: 12 }, () => topupSession({ customer, buyer }));
    for (const s of sessions) expect((await confirmAs(buyer, s.id)).statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(12 * TOPUP_S.credits);
    // The oldest tag has been pushed out of the 10-entry processedSessions list.
    expect(S.state.customers.get(customer).metadata[KEY.processedSessions]).not.toContain(sessions[0].id.slice(-32));

    const replay = await confirmAs(buyer, sessions[0].id);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.creditsAdded).toBe(0);
    const hookReplay = await deliver(completedEvent(sessions[0]));
    expect(hookReplay.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(12 * TOPUP_S.credits);
  });

  it('does not grant a session older than the replay window', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer, created: nowS() - 8 * 24 * 3600 });
    const res = await confirmAs(buyer, session.id);
    expect(res.statusCode).toBe(200);
    expect(res.body.creditsAdded).toBe(0);
    expect(legacyCredits(customer)).toBe(0);
  });

  it('seeds a legacy subscription from /confirm once and never from the webhook', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = subSession({ customer, metadata: { supabase_user_id: buyer.id } });

    const hook = await deliver(completedEvent(session));
    expect(hook.statusCode).toBe(200);
    expect(await recorded(`checkout:${session.id}`)).toBe(false);

    const [a, b] = await Promise.all([confirmAs(buyer, session.id), confirmAs(buyer, session.id)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const md = S.state.customers.get(customer).metadata;
    expect(md[KEY.plan]).toBe('monthly');
    expect(md[KEY.credits]).toBe(String(PLANS.monthly.cap));
  });

  it('refuses to link a customer that is already linked to another user', async () => {
    const owner = newUser();
    const other = newUser();
    const customer = newCustomer();
    await link(other.id, customer);
    const session = topupSession({ customer, buyer: owner });

    const res = await confirmAs(owner, session.id);
    expect(res.statusCode).toBe(409);
    expect(legacyCredits(customer)).toBe(0);
  });

  it('acknowledges refunds and disputes without changing anything', async () => {
    const res = await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: 'ch_x', amount: 1500, amount_refunded: 1500 } } });
    expect(res.statusCode).toBe(200);
    const unknown = await deliver({ id: `evt_${randomUUID()}`, type: 'customer.created', data: { object: {} } });
    expect(unknown.statusCode).toBe(200);
  });

  it('claim-ticket requires the ticket this app issued to the browser', async () => {
    const customer = newCustomer();
    const nonce = 'nonce-' + randomUUID();
    const session = subSession({
      customer,
      metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) },
      email: 'paid-with@example.test',
      extra: { success_url: 'https://x.test/ugc-2/claim?session_id={CHECKOUT_SESSION_ID}' },
    });
    const newcomer = newUser('different@example.test');

    const noTicket = await callRoute(claimTicket, { user: newcomer, cookies: { ugc2_claim_sid: session.id } });
    expect(noTicket.statusCode).toBe(403);

    const wrong = await callRoute(claimTicket, {
      user: newcomer,
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: 'guess' },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await callRoute(claimTicket, {
      user: newcomer,
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: signClaimNonce(nonce) },
    });
    expect(ok.statusCode).toBe(200);
    expect(S.state.customers.get(customer).metadata[KEY.plan]).toBe('monthly');
  });

  it('claim-ticket still accepts a ticket-flow session created before tickets carried a nonce', async () => {
    const customer = newCustomer();
    const session = subSession({
      customer,
      metadata: { pending_supabase_link: 'true' },
      extra: { success_url: 'https://x.test/ugc-2/claim?session_id={CHECKOUT_SESSION_ID}&r=%2Fugc-2' },
    });
    const ok = await callRoute(claimTicket, { user: newUser(), cookies: { ugc2_claim_sid: session.id } });
    expect(ok.statusCode).toBe(200);

    const stale = subSession({
      customer: newCustomer(),
      metadata: { pending_supabase_link: 'true' },
      created: nowS() - 2 * 3600,
      extra: { success_url: 'https://x.test/ugc-2/claim?session_id={CHECKOUT_SESSION_ID}' },
    });
    const denied = await callRoute(claimTicket, { user: newUser(), cookies: { ugc2_claim_sid: stale.id } });
    expect(denied.statusCode).toBe(403);
  });

  it('claim (email match) returns 403 for another email and binds the matching one once', async () => {
    const customer = newCustomer();
    const session = subSession({ customer, metadata: { pending_supabase_link: 'true' }, email: 'payer2@example.test' });
    const wrong = await callRoute(claim, { user: newUser('someone@example.test'), query: { session_id: session.id } });
    expect(wrong.statusCode).toBe(403);
    const payer = newUser('payer2@example.test');
    const ok = await callRoute(claim, { user: payer, query: { session_id: session.id } });
    expect(ok.statusCode).toBe(200);
    const again = await callRoute(claim, { user: payer, query: { session_id: session.id } });
    expect(again.statusCode).toBe(200);
    expect(again.body.alreadyProcessed).toBe(true);
  });
});

// =====================================================================
describe('billing_v2 on (ledger grants)', () => {
  beforeAll(() => setBillingV2(true));
  afterAll(() => setBillingV2(false));

  it('same event id grants once', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    const event = completedEvent(session);

    const results = await Promise.all([deliver(event), deliver(event)]);
    const again = await deliver(event);
    for (const r of [...results, again]) expect(r.statusCode).toBe(200);
    expect(await getBalance(buyer.id)).toMatchObject({ topup: V2_TOPUP_S, plan: 0 });
    expect(await recorded(event.id)).toBe(true);
    expect(legacyCredits(customer)).toBe(0);
  });

  it('webhook and /confirm racing on one session grant once', async () => {
    const buyer = newUser();
    const customer = newCustomer(); // not linked yet: the webhook may park a pending grant
    const session = topupSession({ customer, buyer });

    const [hook, conf] = await Promise.all([deliver(completedEvent(session)), confirmAs(buyer, session.id)]);
    expect(hook.statusCode).toBe(200);
    expect(conf.statusCode).toBe(200);
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S);
    const unclaimed = await db.query(
      'select 1 from public.credit_pending_grants where stripe_customer_id = $1 and claimed_by is null',
      [customer]
    );
    expect(unclaimed.rows).toHaveLength(0);
  });

  it('a handler error returns 500 (so Stripe retries) and does not record the event', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    const event = completedEvent(session);

    S.state.failSessionRetrieves = 1;
    const failed = await deliver(event);
    expect(failed.statusCode).toBe(500);
    expect(await recorded(event.id)).toBe(false);
    expect((await getBalance(buyer.id)).topup).toBe(0);

    expect((await deliver(event)).statusCode).toBe(200);
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S);
  });

  it('/confirm with a session whose client_reference_id or customer email does not match the caller returns 403', async () => {
    const owner = newUser();
    const stranger = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer: owner });
    expect((await confirmAs(stranger, session.id)).statusCode).toBe(403);
    expect((await getBalance(stranger.id)).available).toBe(0);
    expect((await getBalance(owner.id)).available).toBe(0);
  });

  it('does not re-grant a session granted on the legacy path before the flip', async () => {
    const buyer = newUser();
    const session = topupSession({ customer: 'pending', buyer });
    const customer = newCustomer({ [KEY.processedSessions]: session.id.replace(/^cs_test_/, '').slice(-32) });
    S.state.sessions.get(session.id).customer = customer;
    const res = await confirmAs(buyer, session.id);
    expect(res.statusCode).toBe(200);
    expect((await getBalance(buyer.id)).available).toBe(0);
  });

  it('parks a grant for an unlinked customer and lands it when the customer is claimed', async () => {
    const customer = newCustomer();
    const subId = newSub(customer);
    const invoice = paidInvoice({ customer, subId });
    const event = { id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } };
    expect((await deliver(event)).statusCode).toBe(200);
    const pending = await db.query('select amount, claimed_by from public.credit_pending_grants where ref = $1', [
      `invoice:${invoice.id}`,
    ]);
    expect(pending.rows).toEqual([{ amount: V2_MONTHLY, claimed_by: null }]);

    const nonce = 'n-' + randomUUID();
    const session = subSession({
      customer,
      metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) },
    });
    const newcomer = newUser();
    const res = await callRoute(claimTicket, {
      user: newcomer,
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: signClaimNonce(nonce) },
    });
    expect(res.statusCode).toBe(200);
    expect(await getBalance(newcomer.id)).toMatchObject({ plan: V2_MONTHLY });

    // A late redelivery of the invoice does not grant it again.
    expect((await deliver({ ...event, id: `evt_${randomUUID()}` })).statusCode).toBe(200);
    expect((await getBalance(newcomer.id)).plan).toBe(V2_MONTHLY);
  });

  it('grants a paid subscription invoice once with renewPlanCredits', async () => {
    const user = newUser();
    const customer = newCustomer();
    await link(user.id, customer);
    const invoice = paidInvoice({ customer, subId: newSub(customer), reason: 'subscription_cycle' });
    const event = { id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } };
    await Promise.all([deliver(event), deliver(event)]);
    await deliver({ ...event, id: `evt_${randomUUID()}` });
    expect(await getBalance(user.id)).toMatchObject({ plan: V2_MONTHLY });
    const rows = await db.query("select op from public.credit_ledger where ref = $1 and op = 'renew'", [
      `invoice:${invoice.id}`,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('charge.refunded and charge.dispute.created call clawback for the credits that purchase granted (v2 only)', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    await deliver(completedEvent(session));
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S);

    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 750, payment_intent: session.payment_intent, invoice: null };
    S.state.charges.set(charge.id, charge);
    const refund = { id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } };
    expect((await deliver(refund)).statusCode).toBe(200);
    const half = Math.ceil(V2_TOPUP_S / 2); // 240: partial refunds round up
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - half);
    await deliver({ ...refund, id: `evt_${randomUUID()}` }); // redelivered under a new event id
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - half);

    // Dispute on the rest of the charge: claws back what is left, never more than was granted.
    const dispute = { id: `dp_${randomUUID().slice(0, 8)}`, object: 'dispute', charge: charge.id, amount: 750, payment_intent: session.payment_intent };
    expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: dispute } })).statusCode).toBe(200);
    expect((await getBalance(buyer.id)).available).toBe(0);
    const clawed = await db.query(
      "select coalesce(sum(amount), 0)::int as n from public.credit_ledger where user_id = $1 and op = 'clawback'",
      [buyer.id]
    );
    expect(clawed.rows[0].n).toBe(V2_TOPUP_S);

    // A subscription invoice refunded in full claws back its plan allotment.
    const subscriber = newUser();
    const subCustomer = newCustomer();
    await link(subscriber.id, subCustomer);
    const invoice = paidInvoice({ customer: subCustomer, subId: newSub(subCustomer), reason: 'subscription_cycle' });
    await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
    expect((await getBalance(subscriber.id)).plan).toBe(V2_MONTHLY);
    const subCharge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 500, amount_refunded: 500, invoice: invoice.id, payment_intent: 'pi_sub' };
    S.state.charges.set(subCharge.id, subCharge);
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: subCharge } });
    expect((await getBalance(subscriber.id)).plan).toBe(0);
  });

  it('lowers an unclaimed pending grant when its payment is refunded', async () => {
    const customer = newCustomer();
    const invoice = paidInvoice({ customer, subId: newSub(customer) });
    await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 500, amount_refunded: 250, invoice: invoice.id };
    S.state.charges.set(charge.id, charge);
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    const rows = await db.query('select amount from public.credit_pending_grants where ref = $1', [`invoice:${invoice.id}`]);
    expect(rows.rows).toEqual([{ amount: V2_MONTHLY - Math.ceil(V2_MONTHLY / 2) }]);
  });
});

// =====================================================================
// Review fix round 1
// =====================================================================
const cookieValue = (res, name) => {
  const raw = res.headers['Set-Cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0].slice(name.length + 1) : undefined;
};
async function callCheckout({ user = null, body, host = 'ariyalab.test', cookie = '' }) {
  auth.user = user;
  const res = makeRes();
  await checkout({ method: 'POST', body, headers: { host, cookie }, query: {}, cookies: {} }, res);
  return res;
}
const lastCreated = () => S.state.created[S.state.created.length - 1];
const lockRow = (id, age = '0 seconds') =>
  db.query(`insert into public.stripe_events (id, received_at) values ($1, now() - $2::interval)`, [id, age]);

describe('review fixes, billing_v2 off', () => {
  beforeAll(() => setBillingV2(false));

  it('C1: checkout never adopts a customer that another user owns', async () => {
    const victim = newUser('victim@example.test');
    const attacker = newUser();
    const linkedToAttacker = newCustomer({}, 'victim@example.test');
    await link(attacker.id, linkedToAttacker);
    newCustomer({ supabase_user_id: attacker.id }, 'victim@example.test');

    const res = await callCheckout({ user: victim, body: { mode: 'topup', pack: 's' } });
    expect(res.statusCode).toBe(200);
    const params = lastCreated();
    expect(params.customer).toBeUndefined();
    expect(params.customer_creation).toBe('always');
    expect((await db.query('select 1 from public.profiles where id = $1', [victim.id])).rows).toHaveLength(0);
  });

  it('I1: a stale grant lock left by a dead path is taken over and grants once', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });
    await lockRow(`checkout:${session.id}`, '3 minutes');

    const first = await confirmAs(buyer, session.id);
    expect(first.statusCode).toBe(200);
    expect(first.body.creditsAdded).toBe(TOPUP_S.credits);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    expect(await recorded(`checkout:${session.id}:done`)).toBe(true);
    expect((await confirmAs(buyer, session.id)).body.creditsAdded).toBe(0);
    expect(creditWrites(customer)).toBe(1);
  });

  it('I1: a live grant lock makes /confirm answer in progress (the webhook ignores the classic price)', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });
    await lockRow(`checkout:${session.id}`);
    const event = completedEvent(session);

    expect((await deliver(event)).statusCode).toBe(200);
    const conf = await confirmAs(buyer, session.id);
    expect(conf.statusCode).toBe(200);
    expect(conf.body.inProgress).toBe(true);
    expect(legacyCredits(customer)).toBe(0);
  });

  it('I3: pay, then /confirm 8 days later, never hands out two allotments', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = subSession({ customer, metadata: { supabase_user_id: buyer.id }, created: nowS() - 8 * 24 * 3600 });
    S.state.subs.get(session.subscription.id).customer = customer;

    const res = await confirmAs(buyer, session.id);
    expect(res.statusCode).toBe(200);
    const ent = await getEntitlement({ supabase: getSupabaseAdmin(), userId: buyer.id, email: buyer.email });
    expect(ent.tier).toBe('monthly');
    expect(ent.creditsRemaining).toBe(PLANS.monthly.cap);
  });

  it('I4: the attribution cookie cannot set server-owned session metadata', async () => {
    const attr = encodeURIComponent(
      JSON.stringify({ supabase_user_id: 'evil', claim_ticket: 'evil', pending_supabase_link: 'false', utm_source: 'fb' })
    );
    const res = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' }, cookie: `al_attr=${attr}` });
    expect(res.statusCode).toBe(200);
    const md = lastCreated().metadata;
    expect(md.supabase_user_id).toBeUndefined();
    expect(md.pending_supabase_link).toBe('true');
    expect(md.claim_ticket).toBe(hashClaimTicket(verifyClaimNonce(cookieValue(res, 'ugc2_claim_nonce'))));
    expect(md.utm_source).toBe('fb');
  });

  it('O2/I5: /api/checkout -> Set-Cookie -> claim-ticket end to end, after two checkout calls paying the first', async () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://ariyalab.test';
    try {
      const first = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' }, host: 'www.ariyalab.test' });
      const firstSession = lastCreated();
      expect(firstSession.success_url.startsWith('https://www.ariyalab.test/ugc-2/claim?')).toBe(true);
      const nonce1 = cookieValue(first, 'ugc2_claim_nonce');
      expect(verifyClaimNonce(nonce1)).toMatch(/^[A-Za-z0-9_-]{32}$/);

      // Second click / second tab in the same browser: the cookie is reused.
      const second = await callCheckout({
        body: { plan: 'monthly', returnTo: '/ugc-2' },
        host: 'www.ariyalab.test',
        cookie: `ugc2_claim_nonce=${nonce1}`,
      });
      const browserNonce = cookieValue(second, 'ugc2_claim_nonce') || nonce1;

      // The buyer pays the FIRST session.
      const paid = [...S.state.sessions.values()].find((x) => x.success_url === firstSession.success_url && x.metadata?.claim_ticket === firstSession.metadata.claim_ticket);
      const customer = newCustomer();
      const subId = newSub(customer);
      Object.assign(paid, {
        payment_status: 'paid',
        customer,
        subscription: structuredClone(S.state.subs.get(subId)),
        line_items: { data: [{ price: { lookup_key: monthlyKey() } }] },
      });
      const res = await callRoute(claimTicket, {
        user: newUser(),
        cookies: { ugc2_claim_sid: paid.id, ugc2_claim_nonce: browserNonce },
      });
      expect(res.statusCode).toBe(200);
      expect(S.state.customers.get(customer).metadata[KEY.plan]).toBe('monthly');
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });

  it('refuses to move a profile off a customer with a live plan, allows it when that customer is gone', async () => {
    await setRelinkMode('auto');
    const buyer = newUser();
    const existing = newCustomer();
    await link(buyer.id, existing);
    newSub(existing); // active plan on the old customer
    const other = newCustomer();
    const session = topupSession({ customer: other, buyer });
    const refused = await confirmAs(buyer, session.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe(
      'You already have an active plan on this account. Contact support so we can merge your new purchase.'
    );
    expect(legacyCredits(other)).toBe(0);

    // A customer deleted in Stripe counts as no customer, in either mode.
    await setRelinkMode('support');
    S.state.customers.get(existing).deleted = true;
    expect((await confirmAs(buyer, session.id)).statusCode).toBe(200);
    expect(legacyCredits(other)).toBe(TOPUP_S.credits);
  });

  it('a deleted Stripe customer is a recorded skip, not a permanent 500', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    S.state.customers.get(customer).deleted = true;
    const session = topupSession({ customer, buyer });
    const res = await confirmAs(buyer, session.id);
    expect(res.statusCode).toBe(200);
    expect(await recorded(`checkout:${session.id}:done`)).toBe(true);
  });

  it('claim reports a too-old session as skipped, and the 7-day cut spares finished sessions', async () => {
    const payer = newUser('late-payer@example.test');
    const old = subSession({ customer: newCustomer(), email: payer.email, created: nowS() - 8 * 24 * 3600 });
    const late = await callRoute(claim, { user: payer, query: { session_id: old.id } });
    expect(late.statusCode).toBe(200);
    expect(late.body.skipped).toBe('too_old');
    expect(late.body.alreadyProcessed).toBe(false);

    const payer2 = newUser('payer3@example.test');
    const fresh = subSession({ customer: newCustomer(), email: payer2.email });
    expect((await callRoute(claim, { user: payer2, query: { session_id: fresh.id } })).statusCode).toBe(200);
    S.state.sessions.get(fresh.id).created = nowS() - 8 * 24 * 3600;
    const again = await callRoute(claim, { user: payer2, query: { session_id: fresh.id } });
    expect(again.body.alreadyProcessed).toBe(true);
    expect(again.body.skipped).toBeUndefined();
  });
});

describe('review fixes, billing_v2 on', () => {
  beforeAll(() => setBillingV2(true));
  afterAll(() => setBillingV2(false));

  it('O1: the webhook writes nothing for another app\'s purchase', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });
    session.line_items = { data: [{ price: { lookup_key: 'haelabs_topup_s_v1' } }] };
    expect((await deliver(completedEvent(session))).statusCode).toBe(200);
    expect((await db.query('select 1 from public.profiles where id = $1', [buyer.id])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.stripe_events where id like $1", [`checkout:${session.id}%`])).rows).toHaveLength(0);
    expect((await db.query('select 1 from public.credit_pending_grants where stripe_customer_id = $1', [customer])).rows).toHaveLength(0);

    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 1500, payment_intent: session.payment_intent };
    S.state.charges.set(charge.id, charge);
    expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } })).statusCode).toBe(200);
    expect((await db.query('select 1 from public.credit_reversals where source_ref = $1', [`checkout:${session.id}`])).rows).toHaveLength(0);
  });

  it('I2: a cold instance that cannot read billing_v2 retries instead of granting on the legacy path', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    // A classic price: the flag decides whether it is ours, so an unreadable flag must retry.
    const session = topupSession({ customer, buyer, extra: { line_items: { data: [{ price: { lookup_key: TOPUPS.s.lookupKey } }] } } });
    setPricingDb({ query: async () => { throw new Error('db down'); } });
    let res;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      res = await confirmAs(buyer, session.id);
    } finally {
      setPricingDb(db);
      errors.mockRestore();
    }
    expect(res.statusCode).toBe(500);
    expect(legacyCredits(customer)).toBe(0);
    expect((await getBalance(buyer.id)).available).toBe(0);
  });

  it('I6: a refund that arrives before the grant scales it down, a full one skips it', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 750, payment_intent: session.payment_intent };
    S.state.charges.set(charge.id, charge);
    const refund = { id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } };
    expect((await deliver(refund)).statusCode).toBe(200);
    expect((await deliver(completedEvent(session))).statusCode).toBe(200);
    const half = Math.ceil(V2_TOPUP_S / 2);
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - half);
    await deliver({ ...refund, id: `evt_${randomUUID()}` });
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - half);

    const full = topupSession({ customer, buyer });
    const fullCharge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 1500, payment_intent: full.payment_intent };
    S.state.charges.set(fullCharge.id, fullCharge);
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: fullCharge } });
    await deliver(completedEvent(full));
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - half);
    expect((await db.query('select 1 from public.credit_ledger where ref = $1', [`checkout:${full.id}`])).rows).toHaveLength(0);
  });

  it('O3a: a customer linked to several users parks the grant instead of failing forever', async () => {
    const customer = newCustomer();
    await link(newUser().id, customer);
    await link(newUser().id, customer);
    const session = topupSession({ customer, buyer: null });
    expect((await deliver(completedEvent(session))).statusCode).toBe(200);
    const parked = await db.query('select claimed_by from public.credit_pending_grants where ref = $1', [`checkout:${session.id}`]);
    expect(parked.rows).toEqual([{ claimed_by: null }]);
  });

  it('O3b: a stranded duplicate pending grant is dropped and the rest is claimed', async () => {
    const user = newUser();
    const customer = newCustomer();
    await link(user.id, customer);
    const invoiceRef = `invoice:in_${randomUUID().slice(0, 8)}`;
    await renewPlanCredits({ userId: user.id, allotment: V2_MONTHLY, ref: invoiceRef });
    await db.query(
      `insert into public.credit_pending_grants (stripe_customer_id, currency, amount, bucket, reason, ref) values
       ($1, 'video', $2, 'plan', 'plan_renewal', $3), ($1, 'video', 50, 'topup', 'stripe_topup', $4)`,
      [customer, V2_MONTHLY, invoiceRef, `checkout:manual_${randomUUID().slice(0, 8)}`]
    );
    const session = topupSession({ customer, buyer: user });
    const res = await confirmAs(user, session.id);
    expect(res.statusCode).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ plan: V2_MONTHLY, topup: V2_TOPUP_S + 50 });
    expect((await db.query('select 1 from public.credit_pending_grants where ref = $1', [invoiceRef])).rows).toHaveLength(0);
  });

  it('invoices grant only for paid first and cycle periods, read through the SDK', async () => {
    const user = newUser();
    const customer = newCustomer();
    await link(user.id, customer);
    const send = (inv, payload) => deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: payload || inv } });

    const proration = paidInvoice({ customer, subId: newSub(customer), reason: 'subscription_update' });
    await send(proration);
    expect((await getBalance(user.id)).plan).toBe(0);

    const trialSub = newSub(customer);
    S.state.subs.get(trialSub).status = 'trialing';
    await send(paidInvoice({ customer, subId: trialSub }));
    expect((await getBalance(user.id)).plan).toBe(0);

    // 100% promo: paid with amount 0 still renews. The event payload here
    // lacks `subscription` (newer endpoint API versions); the SDK read has it.
    const promo = paidInvoice({ customer, subId: newSub(customer), reason: 'subscription_cycle' });
    S.state.invoices.get(promo.id).amount_paid = 0;
    expect((await send(promo, { id: promo.id, object: 'invoice' })).statusCode).toBe(200);
    expect((await getBalance(user.id)).plan).toBe(V2_MONTHLY);
  });

  it('links a signed-in subscriber from the webhook so a closed tab does not leave the grant parked', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = subSession({ customer, metadata: { supabase_user_id: buyer.id }, extra: { client_reference_id: buyer.id } });
    expect((await deliver(completedEvent(session))).statusCode).toBe(200);
    const row = await db.query('select stripe_customer_id from public.profiles where id = $1', [buyer.id]);
    expect(row.rows).toEqual([{ stripe_customer_id: customer }]);
  });

  it('replaying an old top-up session after 11 newer ones grants nothing (v2)', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const sessions = Array.from({ length: 12 }, () => topupSession({ customer, buyer }));
    for (const x of sessions) expect((await confirmAs(buyer, x.id)).statusCode).toBe(200);
    expect((await getBalance(buyer.id)).topup).toBe(12 * V2_TOPUP_S);
    const replay = await confirmAs(buyer, sessions[0].id);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.creditsAdded).toBe(0);
    await deliver(completedEvent(sessions[0]));
    expect((await getBalance(buyer.id)).topup).toBe(12 * V2_TOPUP_S);
  });
});

// =====================================================================
// Review fix round 2
// =====================================================================
// Wraps db.query for one test. `onQuery(sql, params, run)` may delay or
// replace the call; `run` executes the real query.
async function withQueryHook(onQuery, body) {
  const real = db.query;
  db.query = (sql, params) => onQuery(String(sql), params, () => real(sql, params));
  try {
    return await body();
  } finally {
    db.query = real;
  }
}
// Holds the first call matching `pattern` until a second one arrives (or
// 200 ms pass), then releases both: both callers are past every earlier read.
function pairUp(pattern) {
  const waiting = [];
  return (sql, params, run) => {
    if (!pattern.test(sql)) return run();
    return new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= 2) waiting.splice(0).forEach((f) => f());
      else setTimeout(() => waiting.splice(0).forEach((f) => f()), 200);
    }).then(run);
  };
}

describe('review fixes round 2, billing_v2 off', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('auto'); // N2 exercises the automatic relink
  });
  afterAll(() => setRelinkMode('support'));
  beforeEach(() => {
    auth.failProfileRead = false;
  });

  it('N2: a returning customer who paid again logged out is moved to the new customer, credits carried over', async () => {
    const user = newUser();
    const old = newCustomer({ [KEY.credits]: '100' });
    await link(user.id, old);
    const fresh = newCustomer();
    const nonce = 'n2-' + randomUUID();
    const session = subSession({
      customer: fresh,
      metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) },
    });
    const res = await callRoute(claimTicket, {
      user,
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: signClaimNonce(nonce) },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.query('select stripe_customer_id from public.profiles where id = $1', [user.id]);
    expect(row.rows[0].stripe_customer_id).toBe(fresh);
    const md = S.state.customers.get(fresh).metadata;
    expect(md[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
    expect(md[KEY.relinkedFrom]).toBe(old);
    expect(S.state.customers.get(old).metadata[KEY.credits]).toBe('0');
  });

  it('N3: a database error at the checkout click fails with 503 instead of creating a second customer', async () => {
    const user = newUser('n3@example.test');
    const before = S.state.created.length;
    auth.failProfileRead = true;
    const res = await callCheckout({ user, body: { mode: 'topup', pack: 's' } });
    auth.failProfileRead = false;
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe("We couldn't start the payment. Please try again in a moment.");

    newCustomer({}, 'n3@example.test'); // adoptable by email, but its links cannot be read
    const res2 = await withQueryHook(
      (sql, params, run) => {
        if (sql.includes('from public.profiles where stripe_customer_id')) throw new Error('db down');
        return run();
      },
      () => callCheckout({ user, body: { mode: 'topup', pack: 's' } })
    );
    expect(res2.statusCode).toBe(503);
    expect(S.state.created.length).toBe(before);
  });

  it('N4: a planted claim nonce is replaced, and an unsigned nonce never claims', async () => {
    const planted = 'A'.repeat(32);
    const res = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' }, cookie: `ugc2_claim_nonce=${planted}` });
    expect(res.statusCode).toBe(200);
    const issued = verifyClaimNonce(cookieValue(res, 'ugc2_claim_nonce'));
    expect(issued).toBeTruthy();
    expect(issued).not.toBe(planted);
    expect(lastCreated().metadata.claim_ticket).toBe(hashClaimTicket(issued));

    // Even a session carrying the planted nonce's hash cannot be claimed with the raw value.
    const session = subSession({
      customer: newCustomer(),
      metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(planted) },
    });
    const denied = await callRoute(claimTicket, {
      user: newUser(),
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: planted },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('M3: the in-progress message matches the 2-minute takeover', async () => {
    const payer = newUser('m3@example.test');
    const session = subSession({ customer: newCustomer(), email: payer.email });
    await lockRow(`checkout:${session.id}`);
    const res = await callRoute(claim, { user: payer, query: { session_id: session.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/couple of minutes/);
  });
});

describe('review fixes round 2, billing_v2 on', () => {
  beforeAll(() => setBillingV2(true));
  afterAll(() => setBillingV2(false));

  it('N1: two owner-verified users racing on one unlinked customer get one grant and one link', async () => {
    const a = newUser();
    const b = newUser();
    const customer = newCustomer();
    // A paid (client_reference_id) but typed B's verified email at Stripe.
    const session = topupSession({ customer, buyer: a, email: b.email });
    // Hold A's grant/link in flight while B reads the customer's linked users.
    const [ra, rb] = await withQueryHook(pairUp(/credit_grant\(|credit_link_customer\(|credit_claim_pending\(/), () =>
      Promise.all([confirmAs(a, session.id), confirmAs(b, session.id)])
    );
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const rows = await db.query('select user_id from public.credit_ledger where ref = $1', [`checkout:${session.id}`]);
    expect(rows.rows).toHaveLength(1);
    const links = await db.query('select id from public.profiles where stripe_customer_id = $1', [customer]);
    expect(links.rows).toHaveLength(1);
    expect(String(links.rows[0].id)).toBe(String(rows.rows[0].user_id));
    expect((await getBalance(a.id)).topup + (await getBalance(b.id)).topup).toBe(V2_TOPUP_S);
  });

  it('N2: a returning customer claiming a v2 plan on a new customer is refused by the one-plan guard; the parked invoice stays parked', async () => {
    await setRelinkMode('auto');
    const user = newUser();
    const old = newCustomer();
    await link(user.id, old);
    const fresh = newCustomer();
    const invoice = paidInvoice({ customer: fresh, subId: newSub(fresh) });
    await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
    const nonce = 'n2v2-' + randomUUID();
    const session = subSession({ customer: fresh, metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) } });
    const res = await callRoute(claimTicket, {
      user,
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: signClaimNonce(nonce) },
    });
    // (Before the billing v2 gate this fixture used a classic price, which skipped the guard.)
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/^Buy the plan while signed in/);
    expect((await getBalance(user.id)).plan).toBe(0);
    expect(S.state.customers.get(fresh).metadata[KEY.relinkedFrom]).toBeUndefined();
    await setRelinkMode('support');
  });

  it('M1: a grant for a linked user also claims its parked rows, and a transient claim failure is retryable', async () => {
    const user = newUser();
    const customer = newCustomer();
    await link(user.id, customer);
    await db.query(
      `insert into public.credit_pending_grants (stripe_customer_id, currency, amount, bucket, reason, ref)
       values ($1, 'video', 50, 'topup', 'stripe_topup', $2)`,
      [customer, `checkout:parked_${randomUUID().slice(0, 8)}`]
    );
    const session = topupSession({ customer, buyer: user });
    let failed = false;
    const first = await withQueryHook(
      (sql, params, run) => {
        if (!failed && sql.includes('credit_claim_pending(')) {
          failed = true;
          throw new Error('connection reset');
        }
        return run();
      },
      () => confirmAs(user, session.id)
    );
    expect(first.statusCode).toBe(500);
    expect((await confirmAs(user, session.id)).statusCode).toBe(200);
    expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S + 50);
  });

  it('M2a: a refund that lands while the grant is in flight is still clawed back', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 750, payment_intent: session.payment_intent };
    S.state.charges.set(charge.id, charge);
    let refunded = false;
    await withQueryHook(
      async (sql, params, run) => {
        if (!refunded && sql.includes('credit_grant(')) {
          refunded = true;
          // The refund webhook runs to completion before this grant commits.
          expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } })).statusCode).toBe(200);
        }
        return run();
      },
      () => deliver(completedEvent(session))
    );
    expect(refunded).toBe(true);
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - Math.ceil(V2_TOPUP_S / 2));
  });

  it('M2c: a partial dispute then a partial refund claw back both shares', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    await deliver(completedEvent(session));
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 0, disputed: true, payment_intent: session.payment_intent };
    S.state.charges.set(charge.id, charge);
    const dispute = { id: `dp_${randomUUID().slice(0, 8)}`, object: 'dispute', charge: charge.id, amount: 500 };
    S.state.disputes.set(dispute.id, dispute);
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: dispute } });
    const third = Math.ceil(V2_TOPUP_S / 3); // 160
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - third);

    charge.amount_refunded = 500;
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    expect((await getBalance(buyer.id)).topup).toBe(V2_TOPUP_S - Math.ceil((V2_TOPUP_S * 2) / 3));
  });
});

// =====================================================================
// Review fix round 3
// =====================================================================
// Marks the session /api/checkout just created as paid on `customer`.
const ticketSession = (customer, cookieRes) => {
  const params = lastCreated();
  const paid = [...S.state.sessions.values()].find((x) => x.metadata?.claim_ticket === params.metadata.claim_ticket);
  const subId = newSub(customer);
  Object.assign(paid, {
    payment_status: 'paid',
    customer,
    subscription: structuredClone(S.state.subs.get(subId)),
    line_items: { data: [{ price: { lookup_key: monthlyKey() } }] },
  });
  return { paid, cookie: cookieValue(cookieRes, 'ugc2_claim_nonce') };
};

describe('review fixes round 3, billing_v2 off', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('auto'); // R2 and m1/m2 exercise the automatic relink rules
  });
  afterAll(() => setRelinkMode('support'));

  it('R1: a planted (validly signed) claim cookie cannot claim the victim\'s next session; the victim\'s browser can', async () => {
    // Attacker gets a signed cookie from one anonymous checkout and plants it.
    const attackerRes = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' } });
    const attackerCookie = cookieValue(attackerRes, 'ugc2_claim_nonce');
    const victimRes = await callCheckout({
      body: { plan: 'monthly', returnTo: '/ugc-2' },
      cookie: `ugc2_claim_nonce=${attackerCookie}`,
    });
    const { paid, cookie: victimCookie } = ticketSession(newCustomer(), victimRes);

    const stolen = await callRoute(claimTicket, {
      user: newUser(),
      cookies: { ugc2_claim_sid: paid.id, ugc2_claim_nonce: attackerCookie },
    });
    expect(stolen.statusCode).toBe(403);
    const mine = await callRoute(claimTicket, {
      user: newUser(),
      cookies: { ugc2_claim_sid: paid.id, ugc2_claim_nonce: victimCookie },
    });
    expect(mine.statusCode).toBe(200);
  });

  it('R1: every checkout gets a fresh ticket, the browser keeps its newest 5, and the first paid session still claims', async () => {
    let cookie = '';
    const tickets = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' }, cookie: cookie ? `ugc2_claim_nonce=${cookie}` : '' });
      tickets.push(lastCreated().metadata.claim_ticket);
      cookie = cookieValue(res, 'ugc2_claim_nonce');
    }
    expect(new Set(tickets).size).toBe(7);
    const list = verifyClaimNonces(cookie);
    expect(list).toHaveLength(5);
    expect(hashClaimTicket(list[0].nonce)).toBe(tickets[6]);

    // Pay the session from checkout #6 (two checkouts ago): its nonce is still listed.
    const target = [...S.state.sessions.values()].find((x) => x.metadata?.claim_ticket === tickets[5]);
    const customer = newCustomer();
    const subId = newSub(customer);
    Object.assign(target, {
      payment_status: 'paid',
      customer,
      subscription: structuredClone(S.state.subs.get(subId)),
      line_items: { data: [{ price: { lookup_key: monthlyKey() } }] },
    });
    const res = await callRoute(claimTicket, { user: newUser(), cookies: { ugc2_claim_sid: target.id, ugc2_claim_nonce: cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('R2: an email-only owner is never moved off an existing customer', async () => {
    const user = newUser('r2@example.test');
    const old = newCustomer({ [KEY.credits]: '100' });
    await link(user.id, old);
    const fresh = newCustomer();
    // Someone paid anonymously typing the victim's verified email.
    const session = topupSession({ customer: fresh, buyer: null, email: 'r2@example.test' });
    const res = await confirmAs(user, session.id);
    expect(res.statusCode).toBe(409);
    const row = await db.query('select stripe_customer_id from public.profiles where id = $1', [user.id]);
    expect(row.rows[0].stripe_customer_id).toBe(old);
    expect(S.state.customers.get(old).metadata[KEY.credits]).toBe('100');
  });

  it('R2: a past_due or unpaid subscription of any product on the old customer refuses the relink', async () => {
    // Ownership by client_reference_id (a replacing proof); only the old customer differs.
    const u1 = newUser();
    const old1 = newCustomer();
    await link(u1.id, old1);
    const pastDue = newSub(old1);
    S.state.subs.get(pastDue).status = 'past_due';
    expect((await confirmAs(u1, topupSession({ customer: newCustomer(), buyer: u1 }).id)).statusCode).toBe(409);

    // A past_due subscription of ANY product (here not one of this app's prices) still blocks.
    const u2 = newUser();
    const old2 = newCustomer();
    await link(u2.id, old2);
    const otherProduct = newSub(old2);
    S.state.subs.get(otherProduct).status = 'unpaid';
    S.state.subs.get(otherProduct).items.data[0].price.lookup_key = 'haelabs_monthly';
    expect((await confirmAs(u2, topupSession({ customer: newCustomer(), buyer: u2 }).id)).statusCode).toBe(409);
    const row = await db.query('select stripe_customer_id from public.profiles where id = $1', [u2.id]);
    expect(row.rows[0].stripe_customer_id).toBe(old2);
  });

  it('m1/m2: a relink that fails midway resumes on retry without losing or doubling credits, sending only changed keys', async () => {
    const user = newUser();
    const old = newCustomer({ [KEY.credits]: '100', [KEY.plan]: 'monthly' });
    await link(user.id, old);
    const fresh = newCustomer();
    const session = topupSession({ customer: fresh, buyer: user });
    S.state.failUpdatesFor.set(old, 1); // zeroing the old customer fails once
    expect((await confirmAs(user, session.id)).statusCode).toBe(500);
    expect((await confirmAs(user, session.id)).statusCode).toBe(200);
    expect(S.state.customers.get(old).metadata[KEY.credits]).toBe('0');
    expect(S.state.customers.get(fresh).metadata[KEY.credits]).toBe(String(TOPUP_S.credits + 100));
    // The old customer only ever receives the moved balances and markers (changed keys only).
    const oldWrites = S.state.updates.filter((u) => u.id === old);
    expect(oldWrites.length).toBeGreaterThan(0);
    const allowed = new Set([KEY.credits, KEY.imageCredits, KEY.relinkedTo, KEY.relinkCarry]);
    for (const u of oldWrites) for (const k of Object.keys(u.metadata)) expect(allowed.has(k)).toBe(true);
  });

  it('m5: a 500 from /confirm does not leak the internal error', async () => {
    const buyer = newUser();
    const session = topupSession({ customer: newCustomer(), buyer });
    S.state.failSessionRetrieves = 1;
    const res = await confirmAs(buyer, session.id);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).not.toMatch(/stripe unavailable/);
  });
});

describe('review fixes round 3, billing_v2 on', () => {
  beforeAll(() => setBillingV2(true));
  afterAll(() => setBillingV2(false));

  it('m3: a transient link failure for a subscription session makes Stripe retry', async () => {
    const buyer = newUser();
    const session = subSession({ customer: newCustomer(), extra: { client_reference_id: buyer.id } });
    const res = await withQueryHook(
      (sql, params, run) => {
        if (sql.includes('credit_link_customer(')) throw new Error('connection reset');
        return run();
      },
      () => deliver(completedEvent(session))
    );
    expect(res.statusCode).toBe(500);
  });

  it('m6: a refund and a dispute racing on one purchase never claw back more than it granted', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    await link(buyer.id, customer);
    const session = topupSession({ customer, buyer });
    await deliver(completedEvent(session));
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 1500, amount_refunded: 750, disputed: true, payment_intent: session.payment_intent };
    S.state.charges.set(charge.id, charge);
    const dispute = { id: `dp_${randomUUID().slice(0, 8)}`, object: 'dispute', charge: charge.id, amount: 750 };
    S.state.disputes.set(dispute.id, dispute);
    await withQueryHook(pairUp(/credit_clawback\(|credit_reverse_grant\(/), () =>
      Promise.all([
        deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } }),
        deliver({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: dispute } }),
      ])
    );
    const clawed = await db.query(
      "select coalesce(sum(amount), 0)::int as n from public.credit_ledger where user_id = $1 and op = 'clawback'",
      [buyer.id]
    );
    expect(clawed.rows[0].n).toBeLessThanOrEqual(V2_TOPUP_S);
    expect((await getBalance(buyer.id)).available).toBe(0);
  });

  it('m6: successive refunds lower a parked grant from the amount it was parked with', async () => {
    const customer = newCustomer();
    const invoice = paidInvoice({ customer, subId: newSub(customer) });
    await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 400, amount_refunded: 100, invoice: invoice.id };
    S.state.charges.set(charge.id, charge);
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    charge.amount_refunded = 200;
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    const rows = await db.query('select amount from public.credit_pending_grants where ref = $1', [`invoice:${invoice.id}`]);
    expect(rows.rows).toEqual([{ amount: V2_MONTHLY - Math.ceil(V2_MONTHLY / 2) }]);
  });
});

// =====================================================================
// Round 3 follow-up: state follows the profile on a permitted relink
// =====================================================================
describe('relink carries state, billing_v2 off', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('auto');
  });
  afterAll(() => setRelinkMode('support'));
  const numeric = (md) => Object.fromEntries(Object.entries(md).filter(([, v]) => /^\d+$/.test(v)).map(([k, v]) => [k, Number(v)]));

  it('a former legacy subscriber is relinked: credits moved once, shared keys copied, old keys untouched', async () => {
    const user = newUser();
    const old = newCustomer({
      [KEY.credits]: '100',
      [KEY.plan]: 'monthly',
      plan: 'monthly', // un-namespaced, written by readPaidEntitlement (and maybe haelabs)
      creditsRemaining: '5', // haelabs-style balance
      supabase_user_id: user.id,
    });
    await link(user.id, old);
    const cancelled = newSub(old);
    S.state.subs.get(cancelled).status = 'canceled';
    const fresh = newCustomer({ creditsRemaining: '1' }); // already present: never overwritten
    const nonce = 'carry-' + randomUUID();
    const session = subSession({ customer: fresh, metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) } });
    const cookies = { ugc2_claim_sid: session.id, ugc2_claim_nonce: signClaimNonce(nonce) };
    expect((await callRoute(claimTicket, { user, cookies })).statusCode).toBe(200);
    expect((await callRoute(claimTicket, { user, cookies })).statusCode).toBe(200);

    const row = await db.query('select stripe_customer_id from public.profiles where id = $1', [user.id]);
    expect(row.rows[0].stripe_customer_id).toBe(fresh);
    const n = S.state.customers.get(fresh).metadata;
    const o = S.state.customers.get(old).metadata;
    expect(n[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
    expect(n.plan).toBe('monthly');
    expect(n.creditsRemaining).toBe('1');
    expect(o[KEY.credits]).toBe('0');
    expect(o.plan).toBe('monthly');
    expect(o.creditsRemaining).toBe('5');
    expect(o.supabase_user_id).toBe(user.id);
  });

  it('relinking back and forth never increases any numeric value', async () => {
    const user = newUser();
    const a = newCustomer({ [KEY.credits]: '100', [KEY.imageCredits]: '9', creditsRemaining: '5', plan: 'monthly' });
    const b = newCustomer();
    await link(user.id, a);
    const admin = getSupabaseAdmin();
    const max = {};
    const track = () => {
      for (const id of [a, b]) {
        for (const [k, v] of Object.entries(numeric(S.state.customers.get(id).metadata))) {
          if (k.includes('relink')) continue;
          max[k] = Math.max(max[k] ?? 0, v);
        }
      }
    };
    track();
    const before = { ...max };
    await linkStripeCustomerToProfile(admin, user.id, b, { via: 'admin' });
    await linkStripeCustomerToProfile(admin, user.id, a, { via: 'admin' });
    await linkStripeCustomerToProfile(admin, user.id, b, { via: 'admin' });
    track();
    expect(max).toEqual(before);
    const total = (k) => [a, b].reduce((n, id) => n + parseInt(S.state.customers.get(id).metadata[k] || '0', 10), 0);
    expect(total(KEY.credits)).toBe(100);
    expect(total(KEY.imageCredits)).toBe(9);
  });

  it('refuses with 409 and changes nothing when the copy would exceed Stripe\'s 50-key limit', async () => {
    const user = newUser();
    const oldMd = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`hl_key_${i}`, 'x']));
    const newMd = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`other_${i}`, 'y']));
    const old = newCustomer(oldMd);
    await link(user.id, old);
    const fresh = newCustomer(newMd);
    const session = topupSession({ customer: fresh, buyer: user });
    const updatesBefore = S.state.updates.length;
    const res = await confirmAs(user, session.id);
    expect(res.statusCode).toBe(409);
    expect(S.state.updates.length).toBe(updatesBefore);
    expect(S.state.customers.get(old).metadata).toEqual(oldMd);
    expect(S.state.customers.get(fresh).metadata).toEqual(newMd);
    const row = await db.query('select stripe_customer_id from public.profiles where id = $1', [user.id]);
    expect(row.rows[0].stripe_customer_id).toBe(old);
  });
});

// =====================================================================
// Review fix round 4: relink_mode ('support' by default), NB1 to NB8
// =====================================================================
const BILLING_PROFILE_MESSAGE =
  'You already have a billing profile on this account. Contact support so we can merge your new purchase.';
const mdOf = (customerId) => S.state.customers.get(customerId).metadata;
const profileOf = async (userId) =>
  (await db.query('select stripe_customer_id from public.profiles where id = $1', [userId])).rows[0]?.stripe_customer_id ?? null;
const sumOf = (key, ids) => ids.reduce((n, id) => n + parseInt(mdOf(id)[key] || '0', 10), 0);

// A user whose profile already points at a live customer, plus a second
// customer they have now paid on. `expectUntouched` asserts that nothing was
// written to either Stripe customer or to the profile since.
async function returningBuyer() {
  const user = newUser();
  const old = newCustomer({ [KEY.credits]: '100', creditsRemaining: '5' });
  await link(user.id, old);
  const fresh = newCustomer();
  const before = { updates: S.state.updates.length, old: structuredClone(mdOf(old)), fresh: structuredClone(mdOf(fresh)) };
  const expectUntouched = async () => {
    expect(S.state.updates.length).toBe(before.updates);
    expect(mdOf(old)).toEqual(before.old);
    expect(mdOf(fresh)).toEqual(before.fresh);
    expect(await profileOf(user.id)).toBe(old);
  };
  return { user, old, fresh, expectUntouched };
}
const ticketCookies = (session, nonce) => ({ ugc2_claim_sid: session.id, ugc2_claim_nonce: signClaimNonce(nonce) });
function ticketSub(customer, { email = null } = {}) {
  const nonce = 'r4-' + randomUUID();
  const session = subSession({ customer, email, metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) } });
  return { session, cookies: ticketCookies(session, nonce) };
}

const ADMIN = { id: randomUUID(), email: 'owner-r4@example.test', email_confirmed_at: '2026-11-01T00:00:00Z' };
async function healAs(body) {
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN.email;
  auth.user = ADMIN;
  const res = makeRes();
  // The route logs every ownership override; keep the test output quiet
  // unless the test is watching console.warn itself.
  const quiet = vi.isMockFunction(console.warn) ? null : vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await heal({ method: 'POST', body, headers: {}, query: {}, cookies: {} }, res);
  } finally {
    quiet?.mockRestore();
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
  return res;
}
const OVERRIDE = { overrideOwnership: true, reason: 'ticket 1234: customer sent the Stripe receipt' };
const knownAccount = (user) =>
  auth.users.push({ id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at });

describe('round 4: relink_mode reader', () => {
  afterAll(() => setRelinkMode('support'));

  it("is 'support' unless pricing_config says exactly 'auto', and fails closed on a cold instance", async () => {
    await setRelinkMode('support');
    expect(await relinkModeStrict()).toBe('support');
    await setRelinkMode('auto');
    expect(await relinkModeStrict()).toBe('auto');
    await setRelinkMode('AUTO please');
    expect(await relinkModeStrict()).toBe('support');
    setPricingDb({ query: async () => { throw new Error('db down'); } });
    try {
      await expect(relinkModeStrict()).rejects.toThrow();
    } finally {
      setPricingDb(db);
    }
  });
});

describe.each([{ v2: false, flag: 'off' }, { v2: true, flag: 'on' }])(
  "round 4: relink_mode 'support' (the default), billing_v2 $flag",
  ({ v2 }) => {
    beforeAll(async () => {
      await setBillingV2(v2);
      await setRelinkMode('support');
    });
    afterAll(() => setBillingV2(false));

    it('/confirm: a buyer who already has a different customer gets 409 and nothing is written', async () => {
      const { user, fresh, expectUntouched } = await returningBuyer();
      const session = topupSession({ customer: fresh, buyer: user }); // client_reference_id proof
      const res = await confirmAs(user, session.id);
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe(BILLING_PROFILE_MESSAGE);
      await expectUntouched();
      expect(await recorded(`checkout:${session.id}`)).toBe(false);
      expect((await getBalance(user.id)).available).toBe(0);
    });

    it('/claim (verified email): 409 and nothing is written', async () => {
      const { user, fresh, expectUntouched } = await returningBuyer();
      const session = subSession({ customer: fresh, email: user.email, metadata: { pending_supabase_link: 'true' } });
      const res = await callRoute(claim, { user, query: { session_id: session.id } });
      expect(res.statusCode).toBe(409);
      // A v2 plan claim by a buyer whose account has another customer is refused first, by the one-plan guard.
      if (v2) expect(res.body.error).toMatch(/^Buy the plan while signed in/);
      else expect(res.body.error).toBe(BILLING_PROFILE_MESSAGE);
      await expectUntouched();
    });

    it('claim-ticket (ticket proof): 409 and nothing is written', async () => {
      const { user, fresh, expectUntouched } = await returningBuyer();
      const { cookies } = ticketSub(fresh);
      const res = await callRoute(claimTicket, { user, cookies });
      expect(res.statusCode).toBe(409);
      if (v2) expect(res.body.error).toMatch(/^Buy the plan while signed in/);
      else expect(res.body.error).toBe(BILLING_PROFILE_MESSAGE);
      await expectUntouched();
    });

    it('webhook buyer link: refused with the same message, the profile and the old customer stay as they were', async () => {
      const { user, old, fresh, expectUntouched } = await returningBuyer();
      await expect(assertCanLink(user.id, fresh, { via: 'server' })).rejects.toThrow(BILLING_PROFILE_MESSAGE);
      const oldBefore = structuredClone(mdOf(old));
      const session = topupSession({ customer: fresh, buyer: user });
      const res = await deliver(completedEvent(session));
      expect(res.statusCode).toBe(200);
      expect(await profileOf(user.id)).toBe(old);
      expect(mdOf(old)).toEqual(oldBefore);
      if (v2) {
        // Parked for the new customer; no Stripe customer was written at all.
        await expectUntouched();
        const parked = await db.query(
          'select claimed_by from public.credit_pending_grants where ref = $1',
          [`checkout:${session.id}`]
        );
        expect(parked.rows).toEqual([{ claimed_by: null }]);
        expect((await getBalance(user.id)).available).toBe(0);
      } else {
        // Legacy: the webhook ignores a classic price (classic credits it), so nothing is written at all.
        expect(legacyCredits(fresh)).toBe(0);
        expect(S.state.updates.filter((u) => u.id === old)).toHaveLength(0);
      }
    });

    if (v2) {
      it('webhook subscription link: refused, nothing written', async () => {
        const { user, fresh, expectUntouched } = await returningBuyer();
        const session = subSession({ customer: fresh, extra: { client_reference_id: user.id } });
        const res = await deliver(completedEvent(session));
        expect(res.statusCode).toBe(200);
        await expectUntouched();
      });

      it('a v2 plan claimed by a buyer whose account has another customer is cancelled by the one-plan guard; its grant stays parked and unclaimed', async () => {
        // (A real v2 plan claim like this is always refused and refunded by lib/planGuard.js, so the admin merge
        // is not tested delivering a grant for a plan that was cancelled and refunded.)
        const { user, fresh, expectUntouched } = await returningBuyer();
        knownAccount(user);
        const invoice = paidInvoice({ customer: fresh, subId: newSub(fresh) });
        await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
        const { cookies } = ticketSub(fresh, { email: 'paid-with-another@example.test' });
        const refused = await callRoute(claimTicket, { user, cookies });
        expect(refused.statusCode).toBe(409);
        expect(refused.body).toMatchObject({ code: 'HAS_PLAN' });
        expect(refused.body.error).toMatch(/^Buy the plan while signed in/); // the one-plan guard answers first
        expect(S.state.cancelledSubs).toContain(invoice.subscription);
        expect(S.state.subs.get(invoice.subscription).status).toBe('canceled');
        await expectUntouched();
        const pending = await db.query('select claimed_by from public.credit_pending_grants where ref = $1', [`invoice:${invoice.id}`]);
        expect(pending.rows).toEqual([{ claimed_by: null }]);
        expect((await getBalance(user.id)).available).toBe(0);
      });
    } else {
      it('the admin route performs the merge: profile moved, credits moved once', async () => {
        const { user, old, fresh } = await returningBuyer();
        knownAccount(user);
        const { session, cookies } = ticketSub(fresh, { email: 'paid-with-another@example.test' });
        expect((await callRoute(claimTicket, { user, cookies })).statusCode).toBe(409);
        const dry = await healAs({ sessionId: session.id, email: user.email });
        expect(dry.body.dryRun).toBe(true);
        expect(await profileOf(user.id)).toBe(old);

        const merged = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
        expect(merged.statusCode).toBe(200);
        expect(await profileOf(user.id)).toBe(fresh);
        expect(mdOf(old)[KEY.credits]).toBe('0');
        // The merge seeds the plan this session paid for, then moves the 100 over.
        expect(mdOf(fresh)[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
        expect(mdOf(fresh)[KEY.relinkedFrom]).toBe(old);

        // The plan paid for on the new customer shows up on the next read:
        // this period's allotment plus the credits that moved.
        S.state.subs.get(session.subscription.id).customer = fresh;
        const ent = await getEntitlement({ supabase: getSupabaseAdmin(), userId: user.id, email: user.email });
        expect(ent.tier).toBe('monthly');
        expect(ent.creditsRemaining).toBe(PLANS.monthly.cap + 100);
      });
    }

    it('a user with no customer links normally', async () => {
      const user = newUser();
      const fresh = newCustomer();
      const { cookies } = ticketSub(fresh);
      expect((await callRoute(claimTicket, { user, cookies })).statusCode).toBe(200);
      expect(await profileOf(user.id)).toBe(fresh);
    });

    it('NB1: the same email plus the ticket is a ticket proof (and still 409 in support mode)', async () => {
      const { user, fresh, expectUntouched } = await returningBuyer();
      const { session, cookies } = ticketSub(fresh, { email: user.email });
      const nonce = verifyClaimNonce(cookies.ugc2_claim_nonce);
      expect(checkSessionOwner(session, user, { claimNonces: [nonce] })).toEqual({ ok: true, via: 'ticket' });
      expect(checkSessionOwner({ ...session, client_reference_id: user.id }, user, { claimNonces: [nonce] }).via).toBe(
        'client_reference_id'
      );
      expect(checkSessionOwner(session, user, { claimNonces: [] })).toEqual({ ok: true, via: 'email' });
      const res = await callRoute(claimTicket, { user, cookies });
      expect(res.statusCode).toBe(409);
      if (v2) expect(res.body.error).toMatch(/^Buy the plan while signed in/);
      else expect(res.body.error).toBe(BILLING_PROFILE_MESSAGE);
      await expectUntouched();
    });
  }
);

describe("round 4: relink_mode 'auto', billing_v2 off", () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('auto');
  });
  afterAll(() => setRelinkMode('support'));
  const admin = () => getSupabaseAdmin();
  const settle = (p) => p.then(() => 'ok', (e) => e);

  it('NB1: the same email plus the ticket relinks (ticket outranks email)', async () => {
    const { user, old, fresh } = await returningBuyer();
    const { cookies } = ticketSub(fresh, { email: user.email });
    const res = await callRoute(claimTicket, { user, cookies });
    expect(res.statusCode).toBe(200);
    expect(await profileOf(user.id)).toBe(fresh);
    expect(mdOf(old)[KEY.credits]).toBe('0');
  });

  it('a user with no customer links normally, and the admin route merges here too', async () => {
    const newcomer = newUser();
    const first = newCustomer();
    expect((await callRoute(claimTicket, { user: newcomer, cookies: ticketSub(first).cookies })).statusCode).toBe(200);
    expect(await profileOf(newcomer.id)).toBe(first);

    const { user, old, fresh } = await returningBuyer();
    knownAccount(user);
    const { session } = ticketSub(fresh, { email: user.email });
    const merged = await healAs({ sessionId: session.id, dryRun: false });
    expect(merged.statusCode).toBe(200);
    expect(await profileOf(user.id)).toBe(fresh);
    expect(mdOf(old)[KEY.credits]).toBe('0');
    expect(mdOf(fresh)[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
  });

  it('NB2: two relinks of one user to two new customers, forced to overlap: one wins, the balance exists once', async () => {
    const user = newUser();
    const a = newCustomer({ [KEY.credits]: '100', [KEY.imageCredits]: '9' });
    const b = newCustomer();
    const c = newCustomer();
    await link(user.id, a);
    // Hold the first relink after it has read A: its first write to A waits.
    let release;
    const gate = new Promise((r) => (release = r));
    let reached;
    const atGate = new Promise((r) => (reached = r));
    let held = false;
    S.state.beforeUpdate = async (id) => {
      if (id === a && !held) {
        held = true;
        reached();
        await gate;
      }
    };
    const first = settle(linkStripeCustomerToProfile(admin(), user.id, b, { via: 'admin' }));
    await atGate;
    const cBefore = structuredClone(mdOf(c));
    const second = await settle(linkStripeCustomerToProfile(admin(), user.id, c, { via: 'admin' }));
    release();
    expect(await first).toBe('ok');
    S.state.beforeUpdate = null;

    expect(second).toBeInstanceOf(GrantInProgressError); // retryable
    expect(mdOf(c)).toEqual(cBefore); // the loser's customer is untouched
    expect(S.state.updates.filter((u) => u.id === c)).toHaveLength(0);
    expect(sumOf(KEY.credits, [a, b, c])).toBe(100);
    expect(sumOf(KEY.imageCredits, [a, b, c])).toBe(9);
    expect(mdOf(b)[KEY.credits]).toBe('100');
    expect(await profileOf(user.id)).toBe(b);
  });

  it('NB2: a relink that checked the old link before another relink finished does not act on the stale read', async () => {
    const user = newUser();
    const a = newCustomer({ [KEY.credits]: '100' });
    const b = newCustomer();
    const c = newCustomer();
    await link(user.id, a);
    // Hold the relink to C just before it takes the old-customer lock; by then
    // it has already read "the profile points at A".
    let release;
    const gate = new Promise((r) => (release = r));
    let reached;
    const atGate = new Promise((r) => (reached = r));
    let held = false;
    const cBefore = structuredClone(mdOf(c));
    const [toC] = await withQueryHook(
      (sql, params, run) => {
        if (!held && /insert into public\.stripe_events/.test(sql) && String(params?.[0]).startsWith('relink_old:')) {
          held = true;
          reached();
          return gate.then(run);
        }
        return run();
      },
      async () => {
        const stale = settle(linkStripeCustomerToProfile(admin(), user.id, c, { via: 'admin' }));
        await atGate;
        await linkStripeCustomerToProfile(admin(), user.id, b, { via: 'admin' }); // completes A -> B
        release();
        return [await stale];
      }
    );
    expect(toC).toBeInstanceOf(GrantInProgressError);
    expect(mdOf(c)).toEqual(cBefore);
    expect(sumOf(KEY.credits, [a, b, c])).toBe(100);
    expect(await profileOf(user.id)).toBe(b);
  });

  it('NB2: credit_link_customer replaces a link only when it is still the expected one', async () => {
    const user = newUser();
    const [a, b] = [`cus_cas_${randomUUID().slice(0, 8)}`, `cus_cas_${randomUUID().slice(0, 8)}`];
    await link(user.id, a);
    const call = async (customer, replace, expected) =>
      (await db.query('select public.credit_link_customer($1, $2, $3, $4) as r', [user.id, customer, replace, expected])).rows[0].r;
    expect(await call(b, true, 'cus_someone_else')).toBe('conflict');
    expect(await call(b, true, null)).toBe('conflict');
    expect(await call(b, false, a)).toBe('user_has_other');
    expect(await profileOf(user.id)).toBe(a);
    expect(await call(b, true, a)).toBe('linked');
    expect(await profileOf(user.id)).toBe(b);
  });

  it('NB4: a relink already in flight answers "try again in a couple of minutes" on /confirm and both claim routes', async () => {
    const lock = async (old, fresh) => {
      await lockRow(`relink_old:${old}`);
      await lockRow(`relink:${old}:${fresh}`);
    };
    const unlock = (old, fresh) =>
      db.query('delete from public.stripe_events where id = any($1)', [[`relink_old:${old}`, `relink:${old}:${fresh}`]]);

    const one = await returningBuyer();
    const topup = topupSession({ customer: one.fresh, buyer: one.user });
    await lock(one.old, one.fresh);
    const confirmRes = await confirmAs(one.user, topup.id);
    expect(confirmRes.statusCode).toBe(409);
    expect(confirmRes.body.retryable).toBe(true);
    expect(confirmRes.body.error).toMatch(/couple of minutes/);
    expect(await profileOf(one.user.id)).toBe(one.old);
    await unlock(one.old, one.fresh);
    expect((await confirmAs(one.user, topup.id)).statusCode).toBe(200);
    expect(await profileOf(one.user.id)).toBe(one.fresh);
    expect(legacyCredits(one.fresh)).toBe(TOPUP_S.credits + 100);

    const two = await returningBuyer();
    const ticket = ticketSub(two.fresh);
    await lock(two.old, two.fresh);
    const ticketRes = await callRoute(claimTicket, { user: two.user, cookies: ticket.cookies });
    expect(ticketRes.statusCode).toBe(409);
    expect(ticketRes.body.retryable).toBe(true);
    expect(ticketRes.body.error).toMatch(/couple of minutes/);

    const three = await returningBuyer();
    const byRef = subSession({ customer: three.fresh, extra: { client_reference_id: three.user.id } });
    await lock(three.old, three.fresh);
    const claimRes = await callRoute(claim, { user: three.user, query: { session_id: byRef.id } });
    expect(claimRes.statusCode).toBe(409);
    expect(claimRes.body.retryable).toBe(true);
    expect(claimRes.body.error).toMatch(/couple of minutes/);
  });

  it('NB8: a live subscription beyond the first 100 on the old customer still refuses the relink', async () => {
    const user = newUser();
    const old = newCustomer({ [KEY.credits]: '5' });
    await link(user.id, old);
    for (let i = 0; i < 100; i += 1) S.state.subs.get(newSub(old)).status = 'canceled';
    S.state.subs.get(newSub(old)).status = 'past_due'; // number 101
    const fresh = newCustomer();
    await expect(linkStripeCustomerToProfile(admin(), user.id, fresh, { via: 'admin' })).rejects.toThrow(/active plan/);
    expect(await profileOf(user.id)).toBe(old);
    expect(mdOf(old)[KEY.credits]).toBe('5');
  });

  it('a merge that died after zeroing the old customer keeps its carry record until that same merge is retried', async () => {
    const user = newUser();
    const a = newCustomer({ [KEY.credits]: '100' });
    const b = newCustomer();
    const c = newCustomer();
    await link(user.id, a);
    S.state.failUpdatesFor.set(b, 1); // crediting B fails after A was zeroed
    await expect(linkStripeCustomerToProfile(admin(), user.id, b, { via: 'admin' })).rejects.toThrow('stripe unavailable');
    expect(mdOf(a)[KEY.credits]).toBe('0');
    expect(mdOf(a)[KEY.relinkCarry]).toBe('100:0');
    expect(await profileOf(user.id)).toBe(a);

    // A different merge must not overwrite the record of what B is owed.
    const cBefore = structuredClone(mdOf(c));
    await expect(linkStripeCustomerToProfile(admin(), user.id, c, { via: 'admin' })).rejects.toThrow(/Contact support/);
    expect(mdOf(a)[KEY.relinkCarry]).toBe('100:0');
    expect(mdOf(a)[KEY.relinkedTo]).toBe(b);
    expect(mdOf(c)).toEqual(cBefore);

    await linkStripeCustomerToProfile(admin(), user.id, b, { via: 'admin' });
    expect(mdOf(b)[KEY.credits]).toBe('100');
    expect(await profileOf(user.id)).toBe(b);
  });
});

describe('round 4: NB3, NB6, NB7', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('support');
  });

  it('NB3: a parked grant lowered by a refund, claimed, then refunded further ends at the fair amount', async () => {
    await setBillingV2(true);
    try {
      const user = newUser();
      const customer = newCustomer();
      const invoice = paidInvoice({ customer, subId: newSub(customer) });
      await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
      const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 400, amount_refunded: 100, invoice: invoice.id };
      S.state.charges.set(charge.id, charge);
      await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } }); // 25% while parked
      await linkStripeCustomerToProfile(getSupabaseAdmin(), user.id, customer, { via: 'server' }); // claim
      expect((await getBalance(user.id)).available).toBe(V2_MONTHLY - Math.ceil(V2_MONTHLY * 0.25)); // 120
      charge.amount_refunded = 300; // 75% in total
      const res = await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
      expect(res.statusCode).toBe(200);
      expect(V2_MONTHLY).toBe(160);
      expect((await getBalance(user.id)).available).toBe(40); // 160 - ceil(160 * 0.75), not 30
      // Redelivery claws nothing more.
      await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
      expect((await getBalance(user.id)).available).toBe(40);
    } finally {
      await setBillingV2(false);
    }
  });

  it('NB6: a 500 from /api/checkout does not leak the internal error', async () => {
    S.state.failSessionCreate = 'CRON_SECRET is not set; refusing to sign or verify.';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' } });
      expect(res.statusCode).toBe(500);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error).not.toMatch(/CRON_SECRET|refusing/);
      expect(errors).toHaveBeenCalled(); // details go to the log
    } finally {
      errors.mockRestore();
    }
  });

  it('NB7a: a claim nonce stops proving ownership 24 hours after it was issued', async () => {
    const res = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' } });
    const { paid, cookie } = ticketSession(newCustomer(), res);
    const cookies = { ugc2_claim_sid: paid.id, ugc2_claim_nonce: cookie };
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(realNow + 25 * 3600 * 1000);
      expect((await callRoute(claimTicket, { user: newUser(), cookies })).statusCode).toBe(403);
      clock.mockReturnValue(realNow + 23 * 3600 * 1000);
      expect((await callRoute(claimTicket, { user: newUser(), cookies })).statusCode).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it('NB7b: claiming one paid session keeps the ticket of a second one paid in the same browser', async () => {
    const firstRes = await callCheckout({ body: { plan: 'monthly', returnTo: '/ugc-2' } });
    const first = ticketSession(newCustomer(), firstRes);
    const secondRes = await callCheckout({
      body: { plan: 'monthly', returnTo: '/ugc-2' },
      cookie: `ugc2_claim_nonce=${first.cookie}`,
    });
    const second = ticketSession(newCustomer(), secondRes);

    const claimed = await callRoute(claimTicket, {
      user: newUser(),
      cookies: { ugc2_claim_sid: first.paid.id, ugc2_claim_nonce: second.cookie },
    });
    expect(claimed.statusCode).toBe(200);
    const left = cookieValue(claimed, 'ugc2_claim_nonce');
    const entries = verifyClaimNonces(left);
    expect(entries).toHaveLength(1);
    expect(hashClaimTicket(entries[0].nonce)).toBe(second.paid.metadata.claim_ticket);

    const other = await callRoute(claimTicket, {
      user: newUser(),
      cookies: { ugc2_claim_sid: second.paid.id, ugc2_claim_nonce: left },
    });
    expect(other.statusCode).toBe(200);
    expect(cookieValue(other, 'ugc2_claim_nonce')).toBe(''); // nothing left: cleared
  });
});

// =====================================================================
// Review fix round 5: the admin merge path (B1 to B4)
// =====================================================================
describe('round 5: admin merge grants first (B1)', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('support');
  });
  afterAll(() => setBillingV2(false));

  it('B1 legacy: merge, then the customer re-opens the claim link before any dashboard load: the moved credits survive', async () => {
    const { user, old, fresh } = await returningBuyer();
    knownAccount(user);
    const { session, cookies } = ticketSub(fresh, { email: 'paid-with-another@example.test' });
    expect((await callRoute(claimTicket, { user, cookies })).statusCode).toBe(409);
    const merged = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
    expect(merged.statusCode).toBe(200);
    // The merge granted this session itself, so a later re-hit finds it done.
    expect(await recorded(`checkout:${session.id}:done`)).toBe(true);
    expect(mdOf(fresh)[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
    expect(mdOf(old)[KEY.credits]).toBe('0');

    S.state.subs.get(session.subscription.id).customer = fresh;
    const again = await callRoute(claimTicket, { user, cookies });
    expect(again.statusCode).toBe(200);
    expect(again.body.alreadyProcessed).toBe(true);
    expect(mdOf(fresh)[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
    const ent = await getEntitlement({ supabase: getSupabaseAdmin(), userId: user.id, email: user.email });
    expect(ent.creditsRemaining).toBe(PLANS.monthly.cap + 100);
  });

  it('B1 legacy: a plan seeded after a merge that ran without the grant adds the allotment to the moved credits', async () => {
    const { user, fresh } = await returningBuyer();
    const { session, cookies } = ticketSub(fresh);
    // Merge without a checkout session (nothing seeds the plan): 100 credits move.
    await linkStripeCustomerToProfile(getSupabaseAdmin(), user.id, fresh, { via: 'admin' });
    expect(mdOf(fresh)[KEY.credits]).toBe('100');
    const res = await callRoute(claimTicket, { user, cookies });
    expect(res.statusCode).toBe(200);
    expect(mdOf(fresh)[KEY.credits]).toBe(String(PLANS.monthly.cap + 100));
    S.state.subs.get(session.subscription.id).customer = fresh;
    const ent = await getEntitlement({ supabase: getSupabaseAdmin(), userId: user.id, email: user.email });
    expect(ent.creditsRemaining).toBe(PLANS.monthly.cap + 100);
  });

  it('B1 v2: the merge grants a top-up at once, and re-hitting /confirm or the webhook adds nothing', async () => {
    await setBillingV2(true);
    try {
      const { user, fresh } = await returningBuyer();
      knownAccount(user);
      const session = topupSession({ customer: fresh, buyer: user });
      expect((await confirmAs(user, session.id)).statusCode).toBe(409);
      const merged = await healAs({ sessionId: session.id, email: user.email, dryRun: false });
      expect(merged.statusCode).toBe(200);
      expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S);
      expect((await confirmAs(user, session.id)).statusCode).toBe(200);
      expect((await deliver(completedEvent(session))).statusCode).toBe(200);
      expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S);
      const rows = await db.query('select 1 from public.credit_ledger where ref = $1', [`checkout:${session.id}`]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await setBillingV2(false);
    }
  });

  it('B1 v2: a returning buyer claiming a v2 plan is refused and the plan cancelled; the parked invoice stays unclaimed', async () => {
    await setBillingV2(true);
    try {
      const { user, fresh } = await returningBuyer();
      knownAccount(user);
      const invoice = paidInvoice({ customer: fresh, subId: newSub(fresh) });
      await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
      const { cookies } = ticketSub(fresh, { email: user.email });
      const refused = await callRoute(claimTicket, { user, cookies });
      expect(refused.statusCode).toBe(409);
      expect(S.state.cancelledSubs).toContain(invoice.subscription);
      expect((await getBalance(user.id)).plan).toBe(0);
    } finally {
      await setBillingV2(false);
    }
  });
});

describe('round 5: admin route finds the account and shows the evidence (B2)', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('support');
  });
  afterEach(() => {
    auth.endlessUsers = false;
  });

  it('B2a: finds an account beyond the first 1,000 users', async () => {
    const saved = auth.users.splice(0);
    try {
      for (let i = 0; i < 1500; i += 1) auth.users.push({ id: `u-${i}`, email: `bulk-${i}@example.test` });
      const { user, fresh } = await returningBuyer();
      knownAccount(user); // position 1,501
      const { session } = ticketSub(fresh, { email: user.email });
      const dry = await healAs({ sessionId: session.id });
      expect(dry.statusCode).toBe(200);
      expect(dry.body.supabaseUserId).toBe(user.id);
    } finally {
      auth.users.splice(0, auth.users.length, ...saved);
    }
  });

  it('B2a: an account that does not exist is 404 only after every page was read; a search that hits the cap says so', async () => {
    const { fresh } = await returningBuyer();
    const { session } = ticketSub(fresh, { email: 'nobody-here@example.test' });
    const none = await healAs({ sessionId: session.id });
    expect(none.statusCode).toBe(404);

    auth.endlessUsers = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const capped = await healAs({ sessionId: session.id });
      expect(capped.statusCode).toBe(503);
      expect(capped.body.error).toMatch(/search incomplete/i);
      expect(capped.body.error).not.toMatch(/No Supabase user/);
    } finally {
      errors.mockRestore();
    }
  });

  it('B2b: the dry run shows the payment, the account and the ownership proof', async () => {
    const { user, old, fresh } = await returningBuyer();
    knownAccount(user);
    const { session } = ticketSub(fresh, { email: 'Paid-With-Another@example.test' });
    const dry = await healAs({ sessionId: session.id, email: user.email });
    expect(dry.statusCode).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.payment).toEqual({
      sessionId: session.id,
      email: 'paid-with-another@example.test',
      paymentStatus: 'paid',
      clientReferenceId: null,
      metadataSupabaseUserId: null,
      hasClaimTicket: true,
    });
    expect(dry.body.account).toEqual({ id: user.id, email: user.email, emailConfirmed: true });
    expect(dry.body.ownershipProof).toBe('none');
    expect(dry.body.needsOverride).toBe(true);
    expect(await profileOf(user.id)).toBe(old);

    const byRef = topupSession({ customer: newCustomer(), buyer: user, email: 'other@example.test' });
    expect((await healAs({ sessionId: byRef.id, email: user.email })).body.ownershipProof).toBe('client_reference_id');
    const byMeta = topupSession({ customer: newCustomer(), buyer: user, email: 'other@example.test', extra: { client_reference_id: null } });
    expect((await healAs({ sessionId: byMeta.id, email: user.email })).body.ownershipProof).toBe('metadata');
    const byEmail = ticketSub(newCustomer(), { email: user.email });
    const emailDry = await healAs({ sessionId: byEmail.session.id });
    expect(emailDry.body.ownershipProof).toBe('email');
    expect(emailDry.body.needsOverride).toBe(false);
  });

  it('B2b: an unconfirmed account email is not an email proof', async () => {
    const { user, fresh } = await returningBuyer();
    auth.users.push({ id: user.id, email: user.email, email_confirmed_at: null });
    const { session } = ticketSub(fresh, { email: user.email });
    const dry = await healAs({ sessionId: session.id });
    expect(dry.body.account.emailConfirmed).toBe(false);
    expect(dry.body.ownershipProof).toBe('none');
    expect(dry.body.needsOverride).toBe(true);
  });

  it('B2b: refuses an unpaid session, and refuses a merge without proof unless overridden with a recorded reason', async () => {
    const { user, old, fresh, expectUntouched } = await returningBuyer();
    knownAccount(user);
    const { session } = ticketSub(fresh, { email: 'paid-with-another@example.test' });

    S.state.sessions.get(session.id).payment_status = 'unpaid';
    const unpaid = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
    expect(unpaid.statusCode).toBe(400);
    expect(unpaid.body.error).toMatch(/not paid/i);
    await expectUntouched();
    S.state.sessions.get(session.id).payment_status = 'paid';

    const refused = await healAs({ sessionId: session.id, email: user.email, dryRun: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.body.needsOverride).toBe(true);
    expect(refused.body.ownershipProof).toBe('none');
    const noReason = await healAs({ sessionId: session.id, email: user.email, dryRun: false, overrideOwnership: true, reason: '  ' });
    expect(noReason.statusCode).toBe(409);
    await expectUntouched();

    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
      expect(merged.statusCode).toBe(200);
      expect(warns.mock.calls.some((c) => c.join(' ').includes(OVERRIDE.reason))).toBe(true);
    } finally {
      warns.mockRestore();
    }
    expect(await profileOf(user.id)).toBe(fresh);
    expect(mdOf(fresh).ariyalab_admin_override_reason).toBe(OVERRIDE.reason);
    expect(mdOf(old).ariyalab_admin_override_reason).toBeUndefined();
  });

  it('B2c: the admin must have a confirmed email, ADMIN_EMAILS must be set, and a 500 is generic', async () => {
    const { user, fresh } = await returningBuyer();
    knownAccount(user);
    const { session } = ticketSub(fresh, { email: user.email });
    const call = async (adminUser, env) => {
      const prev = process.env.ADMIN_EMAILS;
      if (env === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = env;
      auth.user = adminUser;
      const res = makeRes();
      try {
        await heal({ method: 'POST', body: { sessionId: session.id }, headers: {}, query: {}, cookies: {} }, res);
      } finally {
        if (prev === undefined) delete process.env.ADMIN_EMAILS;
        else process.env.ADMIN_EMAILS = prev;
      }
      return res;
    };
    expect((await call(ADMIN, ADMIN.email)).statusCode).toBe(200);
    expect((await call({ ...ADMIN, email_confirmed_at: null }, ADMIN.email)).statusCode).toBe(403);
    // No hardcoded fallback: without ADMIN_EMAILS the route is off for everyone.
    const fallback = { id: randomUUID(), email: 'ibrahim3709@gmail.com', email_confirmed_at: '2026-11-01T00:00:00Z' };
    expect((await call(fallback, undefined)).statusCode).toBe(503);
    expect((await call(fallback, '  ')).statusCode).toBe(503);

    S.state.failSessionRetrieves = 1;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failed = await call(ADMIN, ADMIN.email);
      expect(failed.statusCode).toBe(500);
      expect(failed.body.error).not.toMatch(/stripe unavailable/);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('round 5: B3 and B4, billing_v2 off', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('auto');
  });
  afterAll(() => setRelinkMode('support'));

  it('B3: /confirm that loses the grant lock does not go on to merge; it answers the retryable 409', async () => {
    const { user, fresh, expectUntouched } = await returningBuyer();
    const session = topupSession({ customer: fresh, buyer: user });
    await lockRow(`checkout:${session.id}`); // the webhook is granting right now
    const res = await confirmAs(user, session.id);
    expect(res.statusCode).toBe(409);
    expect(res.body.retryable).toBe(true);
    expect(res.body.error).toMatch(/couple of minutes/);
    await expectUntouched();

    // Without a merge to do, losing the lock is still the 200 "in progress".
    const plain = newUser();
    const customer = newCustomer();
    const own = topupSession({ customer, buyer: plain });
    await lockRow(`checkout:${own.id}`);
    const ok = await confirmAs(plain, own.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.inProgress).toBe(true);
  });

  it('B4: an unfinished earlier merge is named to the admin, and can be abandoned only when its target is gone or no longer points back', async () => {
    const user = newUser();
    knownAccount(user);
    const a = newCustomer({ [KEY.credits]: '100' });
    const b = newCustomer();
    const c = newCustomer();
    await link(user.id, a);
    S.state.failUpdatesFor.set(b, 1); // A is zeroed, crediting B fails
    await expect(linkStripeCustomerToProfile(getSupabaseAdmin(), user.id, b, { via: 'admin' })).rejects.toThrow('stripe unavailable');
    const { session } = ticketSub(c, { email: user.email });
    const body = { sessionId: session.id, dryRun: false };

    const blocked = await healAs(body);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error).toContain(a);
    expect(blocked.body.error).toContain(b);
    expect(blocked.body.unfinishedMerge).toEqual({ from: a, to: b, carry: '100:0', canAbandon: false });

    // B still exists and was simply never credited: finishing that merge is the fix, not abandoning it.
    const forcedTooEarly = await healAs({ ...body, forceAbandonEarlierMerge: true });
    expect(forcedTooEarly.statusCode).toBe(409);
    expect(mdOf(a)[KEY.relinkCarry]).toBe('100:0');
    expect(await profileOf(user.id)).toBe(a);

    // B is deleted in Stripe: the earlier merge can never finish.
    S.state.customers.get(b).deleted = true;
    const stillBlocked = await healAs(body);
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.body.unfinishedMerge.canAbandon).toBe(true);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const forced = await healAs({ ...body, forceAbandonEarlierMerge: true });
      expect(forced.statusCode).toBe(200);
    } finally {
      warns.mockRestore();
    }
    expect(await profileOf(user.id)).toBe(c);
    expect(mdOf(a)[KEY.relinkAbandoned]).toBe(`${b}:100:0`);
    expect(mdOf(a)[KEY.relinkedTo]).toBe(c);
    expect(mdOf(c)[KEY.relinkAbandoned]).toBeUndefined();
  });

  it('B4: a customer-triggered path cannot abandon an earlier merge and keeps the customer-facing message', async () => {
    const user = newUser();
    const a = newCustomer({ [KEY.credits]: '100' });
    const b = newCustomer();
    await link(user.id, a);
    S.state.failUpdatesFor.set(b, 1);
    await expect(linkStripeCustomerToProfile(getSupabaseAdmin(), user.id, b, { via: 'admin' })).rejects.toThrow('stripe unavailable');
    S.state.customers.get(b).deleted = true;
    const c = newCustomer();
    await expect(
      linkStripeCustomerToProfile(getSupabaseAdmin(), user.id, c, { via: 'ticket', forceAbandonEarlierMerge: true })
    ).rejects.toThrow('Your account is already linked to a different billing profile. Contact support so we can merge your new purchase.');
    expect(mdOf(a)[KEY.relinkCarry]).toBe('100:0');
  });
});

// Task 6: the Task 5 minors on the admin merge (pages/api/admin/heal-topups.js)
describe('task 6: heal-topups minors', () => {
  beforeAll(async () => {
    await setBillingV2(false);
    await setRelinkMode('support');
  });

  it("accepts a session whose payment_status is 'no_payment_required'", async () => {
    const { user, fresh } = await returningBuyer();
    knownAccount(user);
    const { session } = ticketSub(fresh, { email: user.email });
    S.state.sessions.get(session.id).payment_status = 'no_payment_required';
    const dry = await healAs({ sessionId: session.id });
    expect(dry.statusCode).toBe(200);
    expect(dry.body.payment.paymentStatus).toBe('no_payment_required');
    S.state.sessions.get(session.id).payment_status = 'unpaid';
    expect((await healAs({ sessionId: session.id })).statusCode).toBe(400);
  });

  it('the account search ends when Supabase reports no next page', async () => {
    const saved = auth.users.splice(0);
    try {
      for (let i = 0; i < 1000; i += 1) auth.users.push({ id: `full-${i}`, email: `full-${i}@example.test` });
      const { fresh } = await returningBuyer();
      const { session } = ticketSub(fresh, { email: 'not-there@example.test' });
      auth.listCalls = 0;
      const none = await healAs({ sessionId: session.id });
      expect(none.statusCode).toBe(404);
      expect(auth.listCalls).toBe(1); // a full first page, but nextPage null: no second read
    } finally {
      auth.users.splice(0, auth.users.length, ...saved);
    }
  });

  it('the override reason rides in the same Stripe write as the merge', async () => {
    const { user, fresh } = await returningBuyer();
    knownAccount(user);
    const { session } = ticketSub(fresh, { email: 'paid-with-another@example.test' });
    const from = S.state.updates.length;
    const merged = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
    expect(merged.statusCode).toBe(200);
    const writes = S.state.updates.slice(from).filter((u) => u.id === fresh);
    const mergeWrite = writes.find((u) => u.metadata[KEY.relinkedFrom]);
    expect(mergeWrite.metadata[KEY.adminOverrideReason]).toBe(OVERRIDE.reason);
    expect(writes.filter((u) => KEY.adminOverrideReason in u.metadata)).toHaveLength(1);
  });

  it('without a merge, a reason that cannot be written stops the link (never lost silently)', async () => {
    const user = newUser();
    knownAccount(user);
    const customer = newCustomer({}, 'someone-else@example.test');
    const session = topupSession({ customer, email: 'someone-else@example.test' });
    S.state.failUpdatesFor.set(customer, 99);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
      expect(res.statusCode).toBe(500);
    } finally {
      errors.mockRestore();
      S.state.failUpdatesFor.delete(customer);
    }
    expect(await profileOf(user.id)).toBeNull();
    expect(await recorded(`checkout:${session.id}:done`)).toBe(false); // nothing granted either
    const from = S.state.updates.length;
    const ok = await healAs({ sessionId: session.id, email: user.email, dryRun: false, ...OVERRIDE });
    expect(ok.statusCode).toBe(200);
    expect(await profileOf(user.id)).toBe(customer);
    expect(mdOf(customer)[KEY.adminOverrideReason]).toBe(OVERRIDE.reason);
    // The reason is written first, before the grant and the link.
    expect(S.state.updates.slice(from).filter((u) => u.id === customer)[0].metadata).toEqual({
      [KEY.adminOverrideReason]: OVERRIDE.reason,
    });
  });

  it('abandoned carries are kept as a list, not overwritten', async () => {
    await setRelinkMode('auto');
    try {
      const user = newUser();
      knownAccount(user);
      const a = newCustomer({ [KEY.credits]: '100', [KEY.relinkAbandoned]: 'cus_earliest:7:0' });
      const b = newCustomer();
      await link(user.id, a);
      S.state.failUpdatesFor.set(b, 1);
      await expect(linkStripeCustomerToProfile(getSupabaseAdmin(), user.id, b, { via: 'admin' })).rejects.toThrow('stripe unavailable');
      S.state.customers.get(b).deleted = true;
      const c = newCustomer();
      const { session } = ticketSub(c, { email: user.email });
      const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const forced = await healAs({ sessionId: session.id, dryRun: false, forceAbandonEarlierMerge: true });
        expect(forced.statusCode).toBe(200);
      } finally {
        warns.mockRestore();
      }
      expect(mdOf(a)[KEY.relinkAbandoned]).toBe(`cus_earliest:7:0,${b}:100:0`);
    } finally {
      await setRelinkMode('support');
    }
  });

  it("the dry run shows whether the session's charge was refunded or disputed", async () => {
    const user = newUser();
    knownAccount(user);
    const customer = newCustomer({}, user.email);
    const session = topupSession({ customer, buyer: user });
    const chargeId = `ch_${randomUUID().slice(0, 10)}`;
    S.state.charges.set(chargeId, { id: chargeId, amount: 1500, amount_refunded: 500, refunded: false, disputed: true });
    S.state.paymentIntents.set(session.payment_intent, { id: session.payment_intent, latest_charge: chargeId });
    const dry = await healAs({ sessionId: session.id });
    expect(dry.statusCode).toBe(200);
    expect(dry.body.charge).toEqual({ id: chargeId, amount: 1500, amountRefunded: 500, refunded: false, disputed: true });

    // A subscription session: the charge of its first invoice.
    const sub = subSession({ customer: newCustomer({}, user.email), email: user.email });
    const invoiceCharge = `ch_${randomUUID().slice(0, 10)}`;
    S.state.charges.set(invoiceCharge, { id: invoiceCharge, amount: 500, amount_refunded: 500, refunded: true, disputed: false });
    const inv = `in_${randomUUID().slice(0, 10)}`;
    S.state.invoices.set(inv, { id: inv, charge: invoiceCharge });
    S.state.sessions.get(sub.id).invoice = inv;
    const subDry = await healAs({ sessionId: sub.id });
    expect(subDry.body.charge).toMatchObject({ id: invoiceCharge, refunded: true, amountRefunded: 500 });

    // Nothing to look up is null; a lookup that fails is shown, and neither blocks the tool.
    const none = topupSession({ customer: newCustomer({}, user.email), buyer: user, extra: { payment_intent: null } });
    expect((await healAs({ sessionId: none.id })).body.charge).toBeNull();
    const missing = topupSession({ customer: newCustomer({}, user.email), buyer: user });
    const failed = await healAs({ sessionId: missing.id });
    expect(failed.statusCode).toBe(200);
    expect(failed.body.charge.error).toMatch(/check the payment in Stripe/);
  });
});

// Task 6 round 2 (P5): a customer moved by the legacy migration is granted in
// the ledger even when billing_v2 is switched off again.
describe('task 6 round 2: migrated customers are granted in the ledger whatever the flag', () => {
  beforeAll(() => setBillingV2(false));
  const migrate = (customerId, userId) =>
    db.query(
      `insert into public.credit_legacy_migrations (customer_id, currency, user_id, plan, topup, parked)
       values ($1, 'video', $2, 10, 0, false)`,
      [customerId, userId]
    );

  it('a top-up after the switch-off lands in the ledger, not in Stripe metadata', async () => {
    const { grantForCheckoutSession } = await import('../../lib/grants.js');
    const user = newUser();
    const customer = newCustomer({ [KEY.credits]: '500' });
    await link(user.id, customer);
    await migrate(customer, user.id);
    const session = topupSession({ customer, buyer: user });
    const out = await grantForCheckoutSession(session, { userId: user.id });
    expect(out.granted).toBe(true);
    expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S);
    expect(mdOf(customer)[KEY.credits]).toBe('500');
  });

  it('a classic (ariyalab_*) renewal invoice is never credited here, migrated or not', async () => {
    const { grantForInvoice } = await import('../../lib/grants.js');
    const user = newUser();
    const customer = newCustomer();
    await link(user.id, customer);
    await migrate(customer, user.id);
    const subId = newSub(customer);
    const out = await grantForInvoice(paidInvoice({ customer, subId, reason: 'subscription_cycle' }));
    expect(out.granted).toBe(false);
    expect(out.skipped).toBe('classic_price');
    expect((await getBalance(user.id)).plan).toBe(0);
  });

  it('a refund or dispute on a migrated customer is taken back from the ledger with the flag off', async () => {
    const { grantForCheckoutSession, clawbackForPayment } = await import('../../lib/grants.js');
    const user = newUser();
    const customer = newCustomer();
    await link(user.id, customer);
    await migrate(customer, user.id);
    // A v2 price (a classic one is never clawed back here).
    const session = topupSession({ customer, buyer: user, extra: { line_items: { data: [{ price: { lookup_key: v2TopupKey('s') } }] } } });
    await grantForCheckoutSession(session, { userId: user.id });
    expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S);

    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amount: 1500, amount_refunded: 750, payment_intent: session.payment_intent, invoice: null };
    S.state.charges.set(charge.id, charge);
    const refunded = await clawbackForPayment({ charge });
    expect(refunded.skipped).toBeUndefined();
    expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S - Math.ceil(V2_TOPUP_S / 2));

    const dispute = { id: `dp_${randomUUID().slice(0, 8)}`, charge: charge.id, amount: 750 };
    S.state.disputes.set(dispute.id, dispute);
    await clawbackForPayment({ dispute });
    expect((await getBalance(user.id)).available).toBe(0);
  });

  it('a refund on a customer that was not migrated is still skipped with the flag off', async () => {
    const { clawbackForPayment } = await import('../../lib/grants.js');
    const customer = newCustomer();
    const session = topupSession({ customer, buyer: newUser() });
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amount: 1500, amount_refunded: 1500, payment_intent: session.payment_intent, invoice: null };
    S.state.charges.set(charge.id, charge);
    expect(await clawbackForPayment({ charge })).toEqual({ skipped: 'legacy' });
  });

  it('a customer that was not migrated still takes the legacy path', async () => {
    const { grantForCheckoutSession } = await import('../../lib/grants.js');
    const user = newUser();
    const customer = newCustomer({ [KEY.credits]: '500' });
    await link(user.id, customer);
    await grantForCheckoutSession(topupSession({ customer, buyer: user }), { userId: user.id });
    expect(mdOf(customer)[KEY.credits]).toBe(String(500 + TOPUP_S.credits));
    expect((await getBalance(user.id)).topup).toBe(0);
  });
});

// =====================================================================
// Shared Stripe account: under billing_v2 only this app's own (ariya_v2_*) prices are credited, linked or sold.
// A classic (ariyalab_*) purchase belongs to www.ariyalab.online: acknowledged, nothing written.
describe('billing_v2 gate: only ariya_v2_* prices (classic ariyalab_* purchases are ignored)', () => {
  const classicTopup = (args) => topupSession({ ...args, extra: { line_items: { data: [{ price: { lookup_key: TOPUP_S.lookupKey } }] } } });
  const classicSub = (args) => subSession({ ...args, extra: { line_items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] }, ...(args.extra || {}) } });
  const classicNewSub = (customer) => {
    const subId = newSub(customer);
    S.state.subs.get(subId).items.data[0].price.lookup_key = PLANS.monthly.lookupKey;
    return subId;
  };
  const ledgerRows = async () => (await db.query('select count(*)::int as n from public.credit_ledger')).rows[0].n;
  const reversalRows = async () => (await db.query('select count(*)::int as n from public.credit_reversals')).rows[0].n;
  const pendingRows = async (customerId) =>
    (await db.query('select count(*)::int as n from public.credit_pending_grants where stripe_customer_id = $1', [customerId])).rows[0].n;

  describe('v2 on', () => {
    beforeAll(() => setBillingV2(true));
    afterAll(() => setBillingV2(false));

    it('a classic renewal invoice writes nothing (no ledger, no parked grant, no customer metadata, no Purchase event)', async () => {
      const { sendCapiEvent } = await import('../../lib/meta');
      sendCapiEvent.mockClear();
      const user = newUser();
      const customer = newCustomer({ [KEY.credits]: '500' });
      await link(user.id, customer);
      const subId = classicNewSub(customer);
      const invoice = paidInvoice({ customer, subId, reason: 'subscription_cycle' });
      const [ledger0, pending0, updates0] = [await ledgerRows(), await pendingRows(customer), S.state.updates.length];
      for (const type of ['invoice.payment_succeeded', 'invoice.paid']) {
        const event = { id: `evt_${randomUUID()}`, type, data: { object: invoice } };
        expect((await deliver(event)).statusCode).toBe(200);
        expect(await recorded(event.id)).toBe(true); // acknowledged
      }
      expect(await ledgerRows()).toBe(ledger0);
      expect(await pendingRows(customer)).toBe(pending0);
      expect(S.state.updates.length).toBe(updates0);
      expect(mdOf(customer)[KEY.credits]).toBe('500');
      expect(sendCapiEvent).not.toHaveBeenCalled();
    });

    it('a classic renewal for an UNLINKED customer is not parked either', async () => {
      const customer = newCustomer();
      const invoice = paidInvoice({ customer, subId: classicNewSub(customer), reason: 'subscription_cycle' });
      expect((await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } })).statusCode).toBe(200);
      expect(await pendingRows(customer)).toBe(0);
    });

    it('a classic top-up session writes nothing and links nothing, with or without the processed-session tag', async () => {
      const { sendCapiEvent } = await import('../../lib/meta');
      sendCapiEvent.mockClear();
      const buyer = newUser();
      const customer = newCustomer({ [KEY.credits]: '500' });
      const session = classicTopup({ customer, buyer });
      const [ledger0, updates0] = [await ledgerRows(), S.state.updates.length];
      const event = completedEvent(session);
      expect((await deliver(event)).statusCode).toBe(200);
      expect(await recorded(event.id)).toBe(true);
      expect(await recorded(`checkout:${session.id}:done`)).toBe(false);
      expect(await profileOf(buyer.id)).toBeFalsy(); // no profile link
      // The same, once classic has tagged the session as processed.
      const tagged = newCustomer({ [KEY.processedSessions]: 'whatever' });
      const session2 = classicTopup({ customer: tagged, buyer });
      expect((await deliver(completedEvent(session2))).statusCode).toBe(200);
      expect(await ledgerRows()).toBe(ledger0);
      expect(await pendingRows(customer)).toBe(0);
      expect(await pendingRows(tagged)).toBe(0);
      expect(S.state.updates.length).toBe(updates0);
      expect(mdOf(customer)[KEY.credits]).toBe('500');
      expect(sendCapiEvent).not.toHaveBeenCalled();
    });

    it('a classic subscription session is not linked to the buyer', async () => {
      const buyer = newUser();
      const customer = newCustomer();
      const session = classicSub({ customer, extra: { client_reference_id: buyer.id } });
      expect((await deliver(completedEvent(session))).statusCode).toBe(200);
      expect(await profileOf(buyer.id)).toBeFalsy();
    });

    it('a refund or dispute of a classic purchase claws back nothing and writes no tombstone', async () => {
      const { clawbackForPayment } = await import('../../lib/grants.js');
      const customer = newCustomer();
      const topup = classicTopup({ customer, buyer: newUser() });
      const c1 = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amount: 1500, amount_refunded: 1500, payment_intent: topup.payment_intent, invoice: null };
      S.state.charges.set(c1.id, c1);
      const invoice = paidInvoice({ customer, subId: classicNewSub(customer), reason: 'subscription_cycle' });
      const c2 = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amount: 400, amount_refunded: 400, invoice: invoice.id };
      S.state.charges.set(c2.id, c2);
      const rev0 = await reversalRows();
      expect(await clawbackForPayment({ charge: c1 })).toEqual({ skipped: 'classic_price' });
      expect(await clawbackForPayment({ charge: c2 })).toEqual({ skipped: 'classic_price' });
      const dispute = { id: `dp_${randomUUID().slice(0, 8)}`, charge: c1.id, amount: 1500 };
      S.state.disputes.set(dispute.id, dispute);
      expect(await clawbackForPayment({ dispute })).toEqual({ skipped: 'classic_price' });
      expect(await reversalRows()).toBe(rev0);
      // Through the webhook too: acknowledged.
      expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: c1 } })).statusCode).toBe(200);
      expect(await reversalRows()).toBe(rev0);
    });

    it('grantForCheckoutSession refuses a classic session even when called directly', async () => {
      const { grantForCheckoutSession } = await import('../../lib/grants.js');
      const buyer = newUser();
      const customer = newCustomer();
      await link(buyer.id, customer);
      const out = await grantForCheckoutSession(classicTopup({ customer, buyer }), { userId: buyer.id });
      expect(out).toMatchObject({ granted: false, skipped: 'classic_price' });
      expect((await getBalance(buyer.id)).available).toBe(0);
    });

    it('v2 prices still grant: a v2 plan invoice renews, a v2 top-up lands, a v2 refund is clawed back', async () => {
      const user = newUser();
      const customer = newCustomer();
      await link(user.id, customer);
      const invoice = paidInvoice({ customer, subId: newSub(customer), reason: 'subscription_cycle' });
      expect((await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } })).statusCode).toBe(200);
      expect((await getBalance(user.id)).plan).toBe(V2_MONTHLY);
      const session = topupSession({ customer, buyer: user });
      expect((await deliver(completedEvent(session))).statusCode).toBe(200);
      expect((await getBalance(user.id)).topup).toBe(V2_TOPUP_S);
      const charge = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amount: 1500, amount_refunded: 1500, payment_intent: session.payment_intent, invoice: null };
      S.state.charges.set(charge.id, charge);
      expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } })).statusCode).toBe(200);
      expect((await getBalance(user.id)).topup).toBe(0);
    });

    it('/confirm, /claim and /claim-ticket refuse a classic session: 409 CLASSIC_PRICE, nothing linked or granted', async () => {
      const buyer = newUser();
      const customer = newCustomer({ [KEY.credits]: '500' });
      const top = classicTopup({ customer, buyer });
      const confirmed = await confirmAs(buyer, top.id);
      expect(confirmed.statusCode).toBe(409);
      expect(confirmed.body).toMatchObject({ code: 'CLASSIC_PRICE', classicUrl: 'https://www.ariyalab.online/' });

      const claimer = newUser();
      const subCustomer = newCustomer();
      const sub = classicSub({ customer: subCustomer, email: claimer.email, metadata: { pending_supabase_link: 'true' } });
      const claimed = await callRoute(claim, { user: claimer, query: { session_id: sub.id } });
      expect(claimed.statusCode).toBe(409);
      expect(claimed.body.code).toBe('CLASSIC_PRICE');

      const nonce = 'cp-' + randomUUID();
      const ticketed = classicSub({ customer: subCustomer, metadata: { pending_supabase_link: 'true', claim_ticket: hashClaimTicket(nonce) } });
      const viaTicket = await callRoute(claimTicket, { user: claimer, cookies: ticketCookies(ticketed, nonce) });
      expect(viaTicket.statusCode).toBe(409);
      expect(viaTicket.body.code).toBe('CLASSIC_PRICE');

      expect(await profileOf(buyer.id)).toBeFalsy();
      expect(await profileOf(claimer.id)).toBeFalsy();
      expect((await getBalance(buyer.id)).available).toBe(0);
      expect(mdOf(customer)[KEY.credits]).toBe('500');
      expect(await recorded(`checkout:${top.id}:done`)).toBe(false);
    });

    it('/api/checkout refuses every legacy pack (image packs included) with a clear 400; v2 packs still sell', async () => {
      const user = newUser();
      for (const pack of ['image-s', 'image-m', 'image-l']) {
        const res = await callCheckout({ user, body: { mode: 'topup', pack } });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/ariyalab\.online/);
      }
      const before = S.state.created.length;
      const ok = await callCheckout({ user, body: { mode: 'topup', pack: 's', catalog: 'v2' } });
      expect(ok.statusCode).toBe(200);
      expect(S.state.created.length).toBe(before + 1);
    });

    it('/api/checkout: a classic subscriber who tries to buy a v2 plan is pointed to ariyalab.online (409 HAS_PLAN)', async () => {
      const user = newUser();
      const customer = newCustomer({ supabase_user_id: user.id }, user.email);
      await link(user.id, customer);
      classicNewSub(customer);
      const res = await callCheckout({ user, body: { plan: 'starter', interval: 'month' } });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'HAS_PLAN', classicUrl: 'https://www.ariyalab.online/' });
      expect(res.body.error).toMatch(/ariyalab\.online/);
    });

    it('/api/checkout: a v2 subscriber gets the plain HAS_PLAN message', async () => {
      const user = newUser();
      const customer = newCustomer({ supabase_user_id: user.id }, user.email);
      await link(user.id, customer);
      newSub(customer); // a v2 plan (flag on fixtures)
      const res = await callCheckout({ user, body: { plan: 'starter', interval: 'month' } });
      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('HAS_PLAN');
      expect(res.body.classicUrl).toBeUndefined();
    });
  });

  describe('v2 off: this endpoint still ignores classic prices (classic credits them itself)', () => {
    beforeAll(() => setBillingV2(false));

    it('a classic top-up, renewal and refund event writes nothing', async () => {
      const { sendCapiEvent } = await import('../../lib/meta');
      sendCapiEvent.mockClear();
      const buyer = newUser();
      const customer = newCustomer({ [KEY.credits]: '500' });
      await link(buyer.id, customer);
      const updates0 = S.state.updates.length;
      const rev0 = await reversalRows();
      const session = classicTopup({ customer, buyer });
      const topEvent = completedEvent(session);
      expect((await deliver(topEvent)).statusCode).toBe(200);
      expect(await recorded(topEvent.id)).toBe(true);
      expect(await recorded(`checkout:${session.id}:done`)).toBe(false);
      const invoice = paidInvoice({ customer, subId: classicNewSub(customer), reason: 'subscription_cycle' });
      for (const type of ['invoice.payment_succeeded', 'invoice.paid']) {
        expect((await deliver({ id: `evt_${randomUUID()}`, type, data: { object: invoice } })).statusCode).toBe(200);
      }
      const charge = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amount: 1500, amount_refunded: 1500, payment_intent: session.payment_intent, invoice: null };
      S.state.charges.set(charge.id, charge);
      expect((await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } })).statusCode).toBe(200);
      expect(S.state.updates.length).toBe(updates0);
      expect(mdOf(customer)[KEY.credits]).toBe('500');
      expect(await reversalRows()).toBe(rev0);
      expect((await getBalance(buyer.id)).available).toBe(0);
      expect(sendCapiEvent).not.toHaveBeenCalled();
    });
  });

  describe('planGuard pointer for a classic subscriber', () => {
    beforeAll(() => setBillingV2(true));
    afterAll(() => setBillingV2(false));

    it('a v2 plan bought by a classic subscriber is cancelled with a message pointing to ariyalab.online', async () => {
      const user = newUser();
      const customer = newCustomer({ supabase_user_id: user.id }, user.email);
      await link(user.id, customer);
      classicNewSub(customer); // the old plan
      const v2Sub = newSub(customer); // the v2 plan just bought
      const session = subSession({ customer, email: user.email, metadata: { supabase_user_id: user.id }, extra: { subscription: S.state.subs.get(v2Sub) } });
      const res = await confirmAs(user, session.id);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'HAS_PLAN', classicUrl: 'https://www.ariyalab.online/' });
      expect(res.body.error).toMatch(/Ariya Lab plan lives on https:\/\/www\.ariyalab\.online\//);
      expect(S.state.cancelledSubs).toContain(v2Sub);
    });
  });

  describe('v2 off (unchanged)', () => {
    beforeAll(() => setBillingV2(false));

    it('a classic top-up is still credited by the confirm path and a classic session is not refused', async () => {
      const buyer = newUser();
      const customer = newCustomer();
      const session = classicTopup({ customer, buyer });
      const res = await confirmAs(buyer, session.id);
      expect(res.statusCode).toBe(200);
      expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    });
  });
});
