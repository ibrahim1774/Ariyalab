import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    failCustomerUpdates: 0,
    failSessionRetrieves: 0,
    created: [], // checkout.sessions.create params
    updates: [], // customers.update calls: { id, metadata }
    failUpdatesFor: new Map(), // customer id -> failures left
    creditWrites: new Map(), // customer id -> number of customers.update calls
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
      list: async ({ customer, status }) => ({
        data: [...state.subs.values()]
          .filter((x) => x.customer === customer && (status === 'all' || x.status === status))
          .map(clone),
      }),
    },
    invoices: { retrieve: async (id) => clone(state.invoices.get(id)) },
    charges: { retrieve: async (id) => clone(state.charges.get(id)) },
    disputes: {
      list: async ({ charge }) => ({ data: [...state.disputes.values()].filter((d) => d.charge === charge).map(clone) }),
    },
    webhooks: { constructEvent: (raw) => JSON.parse(raw.toString('utf8')) },
  };
  return { state, api };
});

const auth = vi.hoisted(() => ({ user: null, db: null, failProfileRead: false }));

vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stripe: () => S.api,
    getOrCreatePrice: async (plan) => ({ id: `price_${plan}`, lookup_key: actual.PLANS[plan].lookupKey }),
    getOrCreateTopupPrice: async (pack) => ({ id: `price_topup_${pack}`, lookup_key: actual.TOPUPS[pack].lookupKey }),
  };
});
vi.mock('../../lib/meta', () => ({ sendCapiEvent: vi.fn(async () => {}) }));
vi.mock('../../lib/supabaseServer', () => {
  // Writes profile links into the PGlite profiles table.
  const profileClient = {
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
import { setGrantsDb, hashClaimTicket } from '../../lib/grants.js';
import { signClaimNonces, verifyClaimNonces } from '../../lib/jobToken.js';
const signClaimNonce = (nonce) => signClaimNonces([nonce]);
const verifyClaimNonce = (signed) => verifyClaimNonces(signed)?.[0] ?? null;
import webhook from '../../pages/api/stripe-webhook.js';
import confirm from '../../pages/api/checkout/confirm.js';
import claimTicket from '../../pages/api/checkout/claim-ticket.js';
import claim from '../../pages/api/checkout/claim.js';
import checkout from '../../pages/api/checkout.js';
import { getEntitlement } from '../../lib/entitlement';
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
});

// ---- builders -------------------------------------------------------
const nowS = () => Math.floor(Date.now() / 1000);
const TOPUP_S = TOPUPS.s; // 2,280 legacy video credits, $15
const V2_TOPUP_S = Math.ceil((TOPUP_S.credits * 21) / 100); // 479
const V2_MONTHLY = Math.ceil((PLANS.monthly.cap * 21) / 100); // 160

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
    line_items: { data: [{ price: { lookup_key: TOPUPS[pack].lookupKey } }] },
    ...extra,
  };
  S.state.sessions.set(id, s);
  return s;
}
function subSession({ customer, metadata = {}, email = null, created = nowS(), extra = {} }) {
  seq += 1;
  const id = `cs_test_sub_${seq}_${randomUUID().replace(/-/g, '')}`;
  const subId = `sub_${id}`;
  const sub = { id: subId, status: 'active', current_period_start: nowS(), items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] } };
  S.state.subs.set(subId, sub);
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
    subscription: sub,
    amount_total: PLANS.monthly.amountCents,
    line_items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] },
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
  S.state.subs.set(subId, { id: subId, customer, status: 'active', current_period_start: nowS(), items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] } });
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
  await db.query("delete from public.pricing_config where key = 'billing_v2'");
  if (on) await db.query("insert into public.pricing_config (key, value) values ('billing_v2', 'true'::jsonb)");
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

    const results = await Promise.all([deliver(event), deliver(event)]);
    const again = await deliver(event);
    // A second, different event for the same session (Stripe resend) is also a no-op.
    const other = await deliver(completedEvent(session));

    // A delivery racing the one that holds the grant lock gets 500 (in
    // progress) so Stripe retries it; it never grants.
    for (const r of results) expect([200, 500]).toContain(r.statusCode);
    expect(results.map((r) => r.statusCode)).toContain(200);
    for (const r of [again, other]) expect(r.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    // Two racing grants can lose an update and still end at 2,280: count the writes.
    expect(creditWrites(customer)).toBe(1);
    expect(await recorded(event.id)).toBe(true);
    expect(await recorded(`checkout:${session.id}`)).toBe(true);
  });

  it('webhook and /confirm racing on one session grant once', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });

    const event = completedEvent(session);
    const [hook, conf] = await Promise.all([deliver(event), confirmAs(buyer, session.id)]);

    // Whichever path loses the lock: /confirm answers 200 (in progress), the
    // webhook 500 so Stripe redelivers. The redelivery is a no-op.
    expect([200, 500]).toContain(hook.statusCode);
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
    const failed = await deliver(event);
    expect(failed.statusCode).toBe(500);
    expect(await recorded(event.id)).toBe(false);
    expect(await recorded(`checkout:${session.id}`)).toBe(false);
    expect(legacyCredits(customer)).toBe(0);

    const retried = await deliver(event);
    expect(retried.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
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

    expect((await deliver(completedEvent(session))).statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    expect(await recorded(`checkout:${session.id}:done`)).toBe(true);
    expect((await confirmAs(buyer, session.id)).body.creditsAdded).toBe(0);
    expect(creditWrites(customer)).toBe(1);
  });

  it('I1: a live grant lock makes the webhook retry and /confirm answer in progress', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });
    await lockRow(`checkout:${session.id}`);
    const event = completedEvent(session);

    const hook = await deliver(event);
    expect(hook.statusCode).toBe(500);
    expect(await recorded(event.id)).toBe(false);
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
        line_items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] },
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

    S.state.customers.get(existing).deleted = true;
    expect((await confirmAs(buyer, session.id)).statusCode).toBe(200);
    expect(legacyCredits(other)).toBe(TOPUP_S.credits);
  });

  it('a deleted Stripe customer is a recorded skip, not a permanent 500', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    S.state.customers.get(customer).deleted = true;
    const session = topupSession({ customer, buyer });
    const res = await deliver(completedEvent(session));
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
    const session = topupSession({ customer, buyer });
    setPricingDb({ query: async () => { throw new Error('db down'); } });
    let res;
    try {
      res = await deliver(completedEvent(session));
    } finally {
      setPricingDb(db);
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
  beforeAll(() => setBillingV2(false));
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
    expect(res.body.error).toBe('Please try again.');

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

  it('N2: a parked first invoice lands after a returning customer claims on a new customer', async () => {
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
    expect(res.statusCode).toBe(200);
    expect((await getBalance(user.id)).plan).toBe(V2_MONTHLY);
    expect(S.state.customers.get(fresh).metadata[KEY.relinkedFrom]).toBe(old);
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
    line_items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] },
  });
  return { paid, cookie: cookieValue(cookieRes, 'ugc2_claim_nonce') };
};

describe('review fixes round 3, billing_v2 off', () => {
  beforeAll(() => setBillingV2(false));

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
    expect(hashClaimTicket(list[0])).toBe(tickets[6]);

    // Pay the session from checkout #6 (two checkouts ago): its nonce is still listed.
    const target = [...S.state.sessions.values()].find((x) => x.metadata?.claim_ticket === tickets[5]);
    const customer = newCustomer();
    const subId = newSub(customer);
    Object.assign(target, {
      payment_status: 'paid',
      customer,
      subscription: structuredClone(S.state.subs.get(subId)),
      line_items: { data: [{ price: { lookup_key: PLANS.monthly.lookupKey } }] },
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

  it('R2: a past_due plan or foreign metadata on the old customer refuses the relink', async () => {
    // Ownership by client_reference_id (a replacing proof); only the old customer differs.
    const u1 = newUser();
    const old1 = newCustomer();
    await link(u1.id, old1);
    const pastDue = newSub(old1);
    S.state.subs.get(pastDue).status = 'past_due';
    expect((await confirmAs(u1, topupSession({ customer: newCustomer(), buyer: u1 }).id)).statusCode).toBe(409);

    const u2 = newUser();
    const old2 = newCustomer({ creditsRemaining: '7' }); // haelabs-style key
    await link(u2.id, old2);
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
    const relinkWrites = S.state.updates.filter((u) => (u.id === old || u.id === fresh) && Object.keys(u.metadata).some((k) => k.includes('relink')));
    expect(relinkWrites.length).toBeGreaterThan(0);
    for (const u of relinkWrites) expect(u.metadata[KEY.plan]).toBeUndefined();
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
