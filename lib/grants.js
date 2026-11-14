import { createHash, timingSafeEqual } from 'node:crypto';
import { stripe, planFromPrice, topupFromPrice, CAPS } from './stripe.js';
import { KEY } from './metaKeys.js';
import { getSupabaseAdmin } from './supabaseServer.js';
import { grantCredits, renewPlanCredits, clawback, RefConflictError } from './credits.js';
import { LEGACY_TO_V2 } from './pricing.js';
import { isBillingV2 } from './billingFlags.js';

/*
 * The single place Stripe purchases turn into credits.
 *
 * Every grant is keyed on the Stripe object it pays for: `checkout:<session id>`
 * for one-off purchases, `invoice:<invoice id>` for subscription invoices.
 *
 * billing_v2 OFF (legacy, credits live in Stripe customer metadata):
 *   the key is inserted into stripe_events FIRST. A primary-key conflict means
 *   the purchase was already granted (by the webhook, /confirm or a claim
 *   route), so nothing is written. If the legacy metadata write throws, the
 *   row is deleted again so a retry can grant. The legacy processedSessions
 *   list is still read and written as a second guard for sessions granted
 *   before stripe_events existed.
 *
 * billing_v2 ON (Postgres ledger): the grant relies on the ledger's own
 *   idempotency on (reason, ref), with ref = the key above, and the key is
 *   written to stripe_events only after the grant succeeded. When the Stripe
 *   customer is not linked to a user yet (pay first, sign up after) the grant
 *   is parked in credit_pending_grants and claimed when the customer is linked.
 *
 * Sessions older than MAX_SESSION_AGE_S are never granted: Stripe retries
 * webhooks for at most 3 days and /confirm runs minutes after payment, so an
 * older session id can only be a replay (for example one granted before
 * stripe_events existed and pushed out of the 10-entry processedSessions list).
 */

export const MAX_SESSION_AGE_S = 7 * 24 * 60 * 60;
export const CLAIM_NONCE_COOKIE = 'ugc2_claim_nonce';

const REASON_TOPUP = 'stripe_topup';
const REASON_RENEWAL = 'plan_renewal'; // fixed by credit_renew_plan
const REASON_REFUND = 'stripe_refund';
const REASON_DISPUTE = 'stripe_dispute';

// ---------------------------------------------------------------- db access

let testDb = null;

/** Tests inject a PGlite-style handle ({ query }). Pass null to use the admin client. */
export function setGrantsDb(db) {
  testDb = db;
}

function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message || 'grants db call failed'), { cause: error, code: error.code });
  return data;
}

const store = {
  /** true when inserted, false when the id was already recorded. */
  async record(id) {
    if (testDb) {
      const { rows } = await testDb.query(
        'insert into public.stripe_events (id) values ($1) on conflict (id) do nothing returning id',
        [id]
      );
      return rows.length > 0;
    }
    const { error } = await getSupabaseAdmin().from('stripe_events').insert({ id });
    if (error?.code === '23505') return false;
    unwrap({ error });
    return true;
  },

  async forget(id) {
    if (testDb) {
      await testDb.query('delete from public.stripe_events where id = $1', [id]);
      return;
    }
    unwrap(await getSupabaseAdmin().from('stripe_events').delete().eq('id', id));
  },

  async has(id) {
    if (testDb) {
      const { rows } = await testDb.query('select 1 from public.stripe_events where id = $1', [id]);
      return rows.length > 0;
    }
    const data = unwrap(await getSupabaseAdmin().from('stripe_events').select('id').eq('id', id).limit(1));
    return (data || []).length > 0;
  },

  async usersForCustomer(customerId) {
    if (testDb) {
      const { rows } = await testDb.query('select id from public.profiles where stripe_customer_id = $1', [
        customerId,
      ]);
      return rows.map((r) => String(r.id));
    }
    const data = unwrap(
      await getSupabaseAdmin().from('profiles').select('id').eq('stripe_customer_id', customerId).limit(5)
    );
    return (data || []).map((r) => String(r.id));
  },

  async insertPending({ customerId, currency, amount, bucket, reason, ref }) {
    const row = { stripe_customer_id: customerId, currency, amount, bucket, reason, ref };
    if (testDb) {
      await testDb.query(
        `insert into public.credit_pending_grants (stripe_customer_id, currency, amount, bucket, reason, ref)
         values ($1, $2, $3, $4, $5, $6) on conflict (reason, ref) do nothing`,
        [customerId, currency, amount, bucket, reason, ref]
      );
      return;
    }
    unwrap(
      await getSupabaseAdmin()
        .from('credit_pending_grants')
        .upsert(row, { onConflict: 'reason,ref', ignoreDuplicates: true })
    );
  },

  async findPending(reason, ref) {
    if (testDb) {
      const { rows } = await testDb.query(
        'select id, amount, claimed_by from public.credit_pending_grants where reason = $1 and ref = $2',
        [reason, ref]
      );
      return rows[0] || null;
    }
    const data = unwrap(
      await getSupabaseAdmin()
        .from('credit_pending_grants')
        .select('id, amount, claimed_by')
        .eq('reason', reason)
        .eq('ref', ref)
        .limit(1)
    );
    return data?.[0] || null;
  },

  /** Lowers an unclaimed pending grant to `amount` (deletes it at 0). false when already claimed. */
  async lowerPending(id, amount) {
    if (testDb) {
      const { rows } =
        amount <= 0
          ? await testDb.query(
              'delete from public.credit_pending_grants where id = $1 and claimed_by is null returning id',
              [id]
            )
          : await testDb.query(
              `update public.credit_pending_grants set amount = least(amount, $2)
                where id = $1 and claimed_by is null returning id`,
              [id, amount]
            );
      return rows.length > 0;
    }
    const table = getSupabaseAdmin().from('credit_pending_grants');
    if (amount <= 0) {
      const data = unwrap(await table.delete().eq('id', id).is('claimed_by', null).select('id'));
      return (data || []).length > 0;
    }
    // Only ever lowers: the filter keeps a smaller amount untouched.
    const data = unwrap(
      await table.update({ amount }).eq('id', id).is('claimed_by', null).gt('amount', amount).select('id')
    );
    if ((data || []).length > 0) return true;
    // Nothing updated: either already at or below `amount`, or claimed.
    const check = unwrap(
      await getSupabaseAdmin().from('credit_pending_grants').select('id').eq('id', id).is('claimed_by', null)
    );
    return (check || []).length > 0;
  },

  async claimPending(customerId, userId) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_claim_pending($1, $2) as n', [customerId, userId]);
      return rows[0].n;
    }
    return unwrap(await getSupabaseAdmin().rpc('credit_claim_pending', { p_customer: customerId, p_user: userId }));
  },

  /** The ledger row a purchase produced: { user_id, currency, amount, bucket }. */
  async findGrant(ref) {
    if (testDb) {
      const { rows } = await testDb.query(
        `select user_id, currency, amount, bucket from public.credit_ledger
          where ref = $1 and reason in ($2, $3) and op in ('grant', 'renew')
          order by id limit 1`,
        [ref, REASON_TOPUP, REASON_RENEWAL]
      );
      return rows[0] ? { ...rows[0], user_id: String(rows[0].user_id) } : null;
    }
    const data = unwrap(
      await getSupabaseAdmin()
        .from('credit_ledger')
        .select('user_id, currency, amount, bucket')
        .eq('ref', ref)
        .in('reason', [REASON_TOPUP, REASON_RENEWAL])
        .in('op', ['grant', 'renew'])
        .order('id')
        .limit(1)
    );
    return data?.[0] ? { ...data[0], user_id: String(data[0].user_id) } : null;
  },

  /** Refund and dispute clawbacks for a user and currency: [{ ref, amount }]. */
  async clawbacks(userId, currency) {
    if (testDb) {
      const { rows } = await testDb.query(
        `select ref, amount from public.credit_ledger
          where user_id = $1 and currency = $2 and op = 'clawback' and reason in ($3, $4)`,
        [userId, currency, REASON_REFUND, REASON_DISPUTE]
      );
      return rows;
    }
    return (
      unwrap(
        await getSupabaseAdmin()
          .from('credit_ledger')
          .select('ref, amount')
          .eq('user_id', userId)
          .eq('currency', currency)
          .eq('op', 'clawback')
          .in('reason', [REASON_REFUND, REASON_DISPUTE])
      ) || []
    );
  },
};

const isDeadlock = (err) => err?.code === '40P01' || /deadlock/i.test(String(err?.message || ''));

/** Moves every unclaimed pending grant for this customer to the user. Returns how many. */
export async function claimPendingGrants(customerId, userId) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.claimPending(customerId, userId);
    } catch (err) {
      if (!isDeadlock(err) || attempt >= 3) throw err;
    }
  }
}

/** Records a Stripe event / object id. false when it was already recorded. */
export const recordStripeEvent = (id) => store.record(id);
export const forgetStripeEvent = (id) => store.forget(id);
export const isStripeEventRecorded = (id) => store.has(id);

/** User ids whose profile is linked to this Stripe customer (service role read). */
export async function usersForCustomer(customerId) {
  return store.usersForCustomer(customerId);
}

/** The one user linked to this customer, or null. Throws when several are. */
async function linkedUser(customerId) {
  const users = await store.usersForCustomer(customerId);
  if (users.length > 1) throw new Error(`Stripe customer ${customerId} is linked to several users`);
  return users[0] || null;
}

// ---------------------------------------------------------------- helpers

const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);

export function sessionTag(sessionId) {
  return String(sessionId).replace(/^cs_(test_|live_)/, '').slice(-32);
}

function processedTags(md) {
  return (md[KEY.processedSessions] || '').split(',').filter(Boolean);
}

async function customerMetadata(customerId) {
  const customer = await stripe().customers.retrieve(customerId);
  return customer && !customer.deleted ? customer.metadata || {} : {};
}

/** Legacy credits to v2 credits, rounded up (100 -> 21). */
export function legacyToV2(credits) {
  return Math.ceil(Number((credits * LEGACY_TO_V2).toFixed(6)));
}

/** What a legacy top-up pack grants under billing_v2. */
export function v2TopupGrant(topup) {
  const currency = topup.kind === 'image' ? 'image' : 'video';
  return { currency, amount: currency === 'video' ? legacyToV2(topup.credits) : topup.credits };
}

/** What a legacy plan's invoice grants under billing_v2. */
export function v2PlanAllotment(plan) {
  return legacyToV2(CAPS[plan]);
}

async function withLineItems(session) {
  if (session.line_items?.data) return session;
  return stripe().checkout.sessions.retrieve(session.id, {
    expand: ['line_items.data.price', 'subscription', 'customer'],
  });
}

/** Plan name for a subscription invoice, or null (not ours / no subscription). */
export async function planForInvoice(invoice, { subscription } = {}) {
  const subId = idOf(invoice.subscription);
  if (!subId) return null;
  const sub =
    subscription ||
    (await stripe().subscriptions.retrieve(subId, { expand: ['items.data.price'] }));
  return planFromPrice(sub?.items?.data?.[0]?.price);
}

// ---------------------------------------------------------------- ownership

export function hashClaimTicket(nonce) {
  return createHash('sha256').update(String(nonce)).digest('hex');
}

function sameHex(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * May `user` bind this checkout session? True when the session was created
 * for them (client_reference_id, or metadata.supabase_user_id that
 * /api/checkout writes server-side for signed-in buyers), when its email
 * equals their verified email, or when it carries the claim ticket this app
 * issued to the caller's browser at checkout. Returns { ok, via }.
 */
export function checkSessionOwner(session, user, { claimNonce } = {}) {
  if (!session || !user?.id) return { ok: false };
  if (session.client_reference_id && session.client_reference_id === user.id) {
    return { ok: true, via: 'client_reference_id' };
  }
  if (session.metadata?.supabase_user_id && session.metadata.supabase_user_id === user.id) {
    return { ok: true, via: 'metadata' };
  }
  const verified = Boolean(user.email_confirmed_at || user.confirmed_at);
  const userEmail = String(user.email || '').trim().toLowerCase();
  if (verified && userEmail) {
    const emails = [
      session.customer_details?.email,
      typeof session.customer === 'object' ? session.customer?.email : null,
      session.customer_email,
    ]
      .filter(Boolean)
      .map((e) => String(e).trim().toLowerCase());
    if (emails.includes(userEmail)) return { ok: true, via: 'email' };
  }
  const ticket = session.metadata?.claim_ticket;
  if (claimNonce && ticket && sameHex(hashClaimTicket(claimNonce), ticket)) {
    return { ok: true, via: 'ticket' };
  }
  return { ok: false };
}

// ---------------------------------------------------------------- legacy writes

async function legacyGrantTopup({ customerId, topup, tag, userId }) {
  const md = await customerMetadata(customerId);
  const processed = processedTags(md);
  if (processed.includes(tag)) return false;
  const nextMd = {
    ...md,
    [KEY.processedSessions]: [tag, ...processed].slice(0, 10).join(','),
  };
  if (userId) nextMd.supabase_user_id = userId;
  if (topup.kind === 'image') {
    const current = parseInt(md[KEY.imageCredits] || '0', 10) || 0;
    nextMd[KEY.imageCredits] = String(current + topup.credits);
    if (!md[KEY.imagePeriodStart]) nextMd[KEY.imagePeriodStart] = String(Date.now());
  } else {
    const current = parseInt(md[KEY.credits] || '0', 10) || 0;
    nextMd[KEY.credits] = String(current + topup.credits);
  }
  await stripe().customers.update(customerId, { metadata: nextMd });
  return true;
}

async function legacyGrantPlan({ customerId, plan, session, tag, userId, clearPendingLink }) {
  const md = await customerMetadata(customerId);
  const processed = processedTags(md);
  if (processed.includes(tag)) return false;
  const sub = typeof session.subscription === 'object' ? session.subscription : null;
  const periodStartMs = ((sub && sub.current_period_start) || Math.floor(Date.now() / 1000)) * 1000;
  const existingCredits = parseInt(md[KEY.credits] || '0', 10) || 0;
  // Trialing subs keep only the trial pool until current_period_start jumps
  // on conversion; the entitlement reader grants the cap then.
  const isTrialing = sub && sub.status === 'trialing';
  const seededCredits = isTrialing ? existingCredits : Math.max(existingCredits, CAPS[plan]);
  const nextMd = {
    ...md,
    [KEY.plan]: plan,
    [KEY.periodStart]: String(periodStartMs),
    [KEY.credits]: String(seededCredits),
    supabase_user_id: userId,
    [KEY.videosUsedThisPeriod]: '',
    [KEY.trialUsed]: '',
    [KEY.processedSessions]: [tag, ...processed].slice(0, 10).join(','),
  };
  if (clearPendingLink) nextMd.pending_supabase_link = '';
  await stripe().customers.update(customerId, { metadata: nextMd });
  return true;
}

// ---------------------------------------------------------------- grants

/**
 * Grants what a paid checkout session bought. Safe to call from the webhook,
 * /confirm and the claim routes at the same time: one of them grants.
 *
 * `userId` is the caller that /confirm or a claim route has already checked
 * with checkSessionOwner and linked; the webhook passes none. Legacy plan
 * seeding needs it, so without it a legacy subscription session is skipped
 * (and not recorded). Under billing_v2 subscriptions are granted per invoice
 * by grantForInvoice, so this only grants top-ups.
 *
 * Returns { granted, already, pending, skipped, kind, plan, topup, amount, currency }.
 */
export async function grantForCheckoutSession(session, { userId, clearPendingLink = false } = {}) {
  const full = await withLineItems(session);
  const price = full.line_items?.data?.[0]?.price;
  const plan = planFromPrice(price);
  const topup = plan ? null : topupFromPrice(price);
  const kind = plan ? 'subscription' : topup ? 'topup' : null;
  const out = { granted: false, already: false, pending: false, skipped: null, kind, plan, topup };

  if (!kind) return { ...out, skipped: 'not_ours' };
  if (full.payment_status !== 'paid' && full.payment_status !== 'no_payment_required') {
    return { ...out, skipped: 'unpaid' };
  }
  const customerId = idOf(full.customer);
  if (!customerId) return { ...out, skipped: 'no_customer' };
  if (full.created && Date.now() / 1000 - full.created > MAX_SESSION_AGE_S) {
    return { ...out, skipped: 'too_old' };
  }

  const key = `checkout:${full.id}`;
  const tag = sessionTag(full.id);

  if (!(await isBillingV2())) {
    if (kind === 'subscription' && !userId) return { ...out, skipped: 'needs_user' };
    if (!(await store.record(key))) return { ...out, already: true };
    try {
      const wrote =
        kind === 'topup'
          ? await legacyGrantTopup({ customerId, topup, tag, userId })
          : await legacyGrantPlan({ customerId, plan, session: full, tag, userId, clearPendingLink });
      if (!wrote) return { ...out, already: true };
      return {
        ...out,
        granted: true,
        amount: kind === 'topup' ? topup.credits : CAPS[plan],
        currency: topup?.kind === 'image' ? 'image' : 'video',
      };
    } catch (err) {
      await store.forget(key).catch((e) => console.error('[grants] could not release', key, e.message));
      throw err;
    }
  }

  // billing_v2
  if (kind === 'subscription') return { ...out, skipped: 'granted_per_invoice' };
  if (await store.has(key)) return { ...out, already: true };
  // Granted under the legacy path before the flip: no ledger row exists.
  if (processedTags(await customerMetadata(customerId)).includes(tag)) {
    await store.record(key);
    return { ...out, already: true };
  }

  const { currency, amount } = v2TopupGrant(topup);
  const result = await grantOrPark({
    customerId,
    currency,
    amount,
    bucket: 'topup',
    reason: REASON_TOPUP,
    ref: key,
    grant: (uid) =>
      grantCredits({ userId: uid, currency, amount, bucket: 'topup', reason: REASON_TOPUP, ref: key }),
  });
  await store.record(key);
  return { ...out, ...result, amount, currency };
}

/**
 * Grants a paid subscription invoice. Legacy mode does nothing here (plan
 * credits roll over lazily in lib/entitlement.js). billing_v2 calls
 * renewPlanCredits with ref `invoice:<id>`, or parks a pending grant.
 */
export async function grantForInvoice(invoice, { subscription } = {}) {
  const out = { granted: false, already: false, pending: false, skipped: null };
  if (!invoice?.subscription) return { ...out, skipped: 'no_subscription' };
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return { ...out, skipped: 'unpaid' };
  if (!(await isBillingV2())) return { ...out, skipped: 'legacy' };

  const plan = await planForInvoice(invoice, { subscription });
  if (!plan) return { ...out, skipped: 'not_ours' };
  const customerId = idOf(invoice.customer);
  if (!customerId) return { ...out, skipped: 'no_customer' };

  const key = `invoice:${invoice.id}`;
  if (await store.has(key)) return { ...out, plan, already: true };
  const allotment = v2PlanAllotment(plan);
  const result = await grantOrPark({
    customerId,
    currency: 'video',
    amount: allotment,
    bucket: 'plan',
    reason: REASON_RENEWAL,
    ref: key,
    grant: async (uid) => {
      // A pending grant for this invoice (parked before the link) is claimed
      // instead, so the invoice never lands twice under two operations.
      if (await store.findPending(REASON_RENEWAL, key)) return claimPendingGrants(customerId, uid);
      return renewPlanCredits({ userId: uid, allotment, ref: key });
    },
  });
  await store.record(key);
  return { ...out, ...result, plan, amount: allotment, currency: 'video' };
}

async function grantOrPark({ customerId, currency, amount, bucket, reason, ref, grant }) {
  const userId = await linkedUser(customerId);
  if (userId) {
    try {
      await grant(userId);
    } catch (err) {
      // The same (reason, ref) already exists under another operation (for
      // example a claimed pending grant): it was granted.
      if (err instanceof RefConflictError) return { already: true, userId };
      throw err;
    }
    return { granted: true, userId };
  }
  await store.insertPending({ customerId, currency, amount, bucket, reason, ref });
  // The customer may have been linked while we parked it.
  const nowLinked = await linkedUser(customerId);
  if (nowLinked) {
    await claimPendingGrants(customerId, nowLinked);
    return { granted: true, userId: nowLinked };
  }
  return { pending: true };
}

// ---------------------------------------------------------------- refunds

async function sourceRefForCharge(charge) {
  const invoiceId = idOf(charge.invoice);
  if (invoiceId) return { ref: `invoice:${invoiceId}`, reason: REASON_RENEWAL, invoiceId };
  const pi = idOf(charge.payment_intent);
  if (!pi) return null;
  const list = await stripe().checkout.sessions.list({ payment_intent: pi, limit: 1 });
  const session = list?.data?.[0];
  return session ? { ref: `checkout:${session.id}`, reason: REASON_TOPUP, sessionId: session.id } : null;
}

/** What a purchase granted under billing_v2, recomputed from Stripe (for unclaimed pending grants). */
async function originalGrantAmount(source) {
  if (source.sessionId) {
    const s = await withLineItems({ id: source.sessionId });
    const topup = topupFromPrice(s.line_items?.data?.[0]?.price);
    return topup ? v2TopupGrant(topup).amount : 0;
  }
  const invoice = await stripe().invoices.retrieve(source.invoiceId);
  const plan = await planForInvoice(invoice);
  return plan ? v2PlanAllotment(plan) : 0;
}

/**
 * Claws back what a refunded or disputed purchase granted (billing_v2 only).
 * Pass `{ charge }` for charge.refunded or `{ dispute }` for
 * charge.dispute.created. The amount is proportional to the money returned,
 * rounded up, and cumulative per purchase: refunds and disputes on the same
 * purchase never claw back more than it granted in total.
 */
export async function clawbackForPayment({ charge, dispute }, _retried = false) {
  if (!(await isBillingV2())) return { skipped: 'legacy' };
  const ch = charge || (await stripe().charges.retrieve(idOf(dispute.charge)));
  if (!ch?.amount) return { skipped: 'no_amount' };
  const source = await sourceRefForCharge(ch);
  if (!source) return { skipped: 'no_source' };

  const covered = dispute
    ? Math.min(ch.amount, (ch.amount_refunded || 0) + (dispute.amount || 0))
    : Math.min(ch.amount, ch.amount_refunded || 0);
  const reason = dispute ? REASON_DISPUTE : REASON_REFUND;
  const ref = dispute ? `${source.ref}:dispute:${dispute.id}` : `${source.ref}:refund:${covered}`;
  const targetFor = (granted) => Math.min(granted, Math.ceil((granted * covered) / ch.amount));

  const grant = await store.findGrant(source.ref);
  if (grant) {
    const rows = await store.clawbacks(grant.user_id, grant.currency);
    if (rows.some((r) => r.ref === ref)) return { already: true, ref };
    const prefix = `${source.ref}:`;
    const done = rows.filter((r) => r.ref.startsWith(prefix)).reduce((n, r) => n + r.amount, 0);
    const amount = targetFor(grant.amount) - done;
    if (amount <= 0) return { amount: 0, ref };
    // Take from the bucket the purchase filled first.
    const firstBucket = grant.bucket === 'topup' ? 'topup' : 'plan';
    const r = await clawback({ userId: grant.user_id, currency: grant.currency, amount, reason, ref, firstBucket });
    return { amount, ref, userId: grant.user_id, ...r };
  }

  const pending = await store.findPending(source.reason, source.ref);
  if (pending && !pending.claimed_by) {
    const original = await originalGrantAmount(source);
    const remaining = Math.max(0, original - targetFor(original));
    if (await store.lowerPending(pending.id, remaining)) return { pendingLoweredTo: remaining, ref };
    // Claimed in the meantime: the ledger row exists now.
    if (!_retried) return clawbackForPayment({ charge: ch, dispute }, true);
  }
  console.warn('[grants] no grant found for refunded/disputed payment', source.ref);
  return { skipped: 'no_grant', ref };
}
