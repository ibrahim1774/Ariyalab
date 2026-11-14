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
    failCustomerUpdates: 0,
    failSessionRetrieves: 0,
  };
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const clone = (o) => (o === undefined ? o : structuredClone(o));
  const api = {
    customers: {
      retrieve: async (id) => {
        await tick();
        const c = state.customers.get(id);
        if (!c) throw new Error(`No such customer: ${id}`);
        return clone(c);
      },
      update: async (id, { metadata }) => {
        await tick();
        if (state.failCustomerUpdates > 0) {
          state.failCustomerUpdates -= 1;
          throw new Error('stripe unavailable');
        }
        const c = state.customers.get(id);
        c.metadata = { ...metadata };
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
      },
    },
    subscriptions: { retrieve: async (id) => clone(state.subs.get(id)) },
    invoices: { retrieve: async (id) => clone(state.invoices.get(id)) },
    charges: { retrieve: async (id) => clone(state.charges.get(id)) },
    webhooks: { constructEvent: (raw) => JSON.parse(raw.toString('utf8')) },
  };
  return { state, api };
});

const auth = vi.hoisted(() => ({ user: null, db: null }));

vi.mock('../../lib/stripe', async (importOriginal) => ({ ...(await importOriginal()), stripe: () => S.api }));
vi.mock('../../lib/meta', () => ({ sendCapiEvent: vi.fn(async () => {}) }));
vi.mock('../../lib/supabaseServer', () => {
  // Writes profile links into the PGlite profiles table.
  const profileClient = {
    from: () => ({
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
import webhook from '../../pages/api/stripe-webhook.js';
import confirm from '../../pages/api/checkout/confirm.js';
import claimTicket from '../../pages/api/checkout/claim-ticket.js';
import claim from '../../pages/api/checkout/claim.js';

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
  const inv = { id, customer, subscription: subId, amount_paid: PLANS.monthly.amountCents, billing_reason: reason, currency: 'usd' };
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

    for (const r of [...results, again, other]) expect(r.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
    expect(await recorded(event.id)).toBe(true);
    expect(await recorded(`checkout:${session.id}`)).toBe(true);
  });

  it('webhook and /confirm racing on one session grant once', async () => {
    const buyer = newUser();
    const customer = newCustomer();
    const session = topupSession({ customer, buyer });

    const [hook, conf] = await Promise.all([deliver(completedEvent(session)), confirmAs(buyer, session.id)]);

    expect(hook.statusCode).toBe(200);
    expect(conf.statusCode).toBe(200);
    expect(legacyCredits(customer)).toBe(TOPUP_S.credits);
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
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: nonce },
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
      cookies: { ugc2_claim_sid: session.id, ugc2_claim_nonce: nonce },
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
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: subCharge } });
    expect((await getBalance(subscriber.id)).plan).toBe(0);
  });

  it('lowers an unclaimed pending grant when its payment is refunded', async () => {
    const customer = newCustomer();
    const invoice = paidInvoice({ customer, subId: newSub(customer) });
    await deliver({ id: `evt_${randomUUID()}`, type: 'invoice.payment_succeeded', data: { object: invoice } });
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, amount: 500, amount_refunded: 250, invoice: invoice.id };
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    await deliver({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: charge } });
    const rows = await db.query('select amount from public.credit_pending_grants where ref = $1', [`invoice:${invoice.id}`]);
    expect(rows.rows).toEqual([{ amount: V2_MONTHLY - Math.ceil(V2_MONTHLY / 2) }]);
  });
});
