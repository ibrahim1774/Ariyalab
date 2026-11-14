import { createHash, timingSafeEqual } from 'node:crypto';
import { stripe, planFromPrice, topupFromPrice, CAPS } from './stripe.js';
import { KEY } from './metaKeys.js';
import { getSupabaseAdmin } from './supabaseServer.js';
import { grantCredits, renewPlanCredits, clawback, RefConflictError, _mapError } from './credits.js';
import { LEGACY_TO_V2 } from './pricing.js';
import { isBillingV2Strict } from './billingFlags.js';
import { verifyClaimNonce } from './jobToken.js';

/*
 * The single place Stripe purchases turn into credits.
 *
 * Every grant is keyed on the Stripe object it pays for: `checkout:<session id>`
 * for one-off purchases, `invoice:<invoice id>` for subscription invoices.
 * `<key>:done` in stripe_events marks a purchase as finished (granted, or
 * deliberately skipped) in both modes.
 *
 * billing_v2 OFF (legacy, credits live in Stripe customer metadata, which has
 * no transactions): `<key>` is a lock row. It is inserted before the metadata
 * write; a conflict means another path holds it. `<key>:done` is written
 * after the write. A lock without `:done` older than LOCK_TAKEOVER_MS belongs
 * to a path that died, and is taken over (atomic compare-and-set on
 * received_at); a younger one raises GrantInProgressError (webhook: 500 so
 * Stripe retries). The metadata write re-reads processedSessions, so a write
 * that landed before its process died is not repeated. A failed write
 * releases the lock.
 *
 * billing_v2 ON (Postgres ledger): the grant relies on the ledger's own
 * idempotency on (reason, ref), with ref = the key, and `:done` is written
 * after it succeeded. A customer with no linked user parks the grant in
 * credit_pending_grants, claimed when the customer is linked.
 *
 * The flag is read strictly (isBillingV2Strict): when it cannot be read, the
 * call throws instead of granting on the wrong path.
 *
 * Sessions older than MAX_SESSION_AGE_S that were never finished are not
 * granted: Stripe retries webhooks for at most 3 days and /confirm runs
 * minutes after payment, so an older session id can only be a replay (for
 * example one granted before stripe_events existed and pushed out of the
 * 10-entry processedSessions list).
 *
 * Refunds and disputes (billing_v2) claw back the purchase's share. One that
 * arrives before the grant writes a credit_reversals tombstone; the grant then
 * skips (fully reversed) or claws back the reversed share right after.
 */

export const MAX_SESSION_AGE_S = 7 * 24 * 60 * 60;
export const LOCK_TAKEOVER_MS = 2 * 60 * 1000;
export const CLAIM_NONCE_COOKIE = 'ugc2_claim_nonce';

const REASON_TOPUP = 'stripe_topup';
const REASON_RENEWAL = 'plan_renewal'; // fixed by credit_renew_plan
const REASON_REFUND = 'stripe_refund';
const REASON_DISPUTE = 'stripe_dispute';
const GRANTED_INVOICE_REASONS = new Set(['subscription_create', 'subscription_cycle']);

/** Another path is granting this purchase right now. Retry later. */
export class GrantInProgressError extends Error {
  constructor(key) {
    super('grant_in_progress');
    this.name = 'GrantInProgressError';
    this.key = key;
  }
}

// ---------------------------------------------------------------- db access

let testDb = null;

/** Tests inject a PGlite-style handle ({ query }). Pass null to use the admin client. */
export function setGrantsDb(db) {
  testDb = db;
}

function unwrap({ data, error }) {
  if (error) {
    throw Object.assign(new Error(error.message || 'grants db call failed'), {
      cause: error,
      code: error.code,
      detail: error.details,
    });
  }
  return data;
}

const admin = () => getSupabaseAdmin();

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
    const { error } = await admin().from('stripe_events').insert({ id });
    if (error?.code === '23505') return false;
    unwrap({ error });
    return true;
  },

  async forget(id) {
    if (testDb) {
      await testDb.query('delete from public.stripe_events where id = $1', [id]);
      return;
    }
    unwrap(await admin().from('stripe_events').delete().eq('id', id));
  },

  async has(id) {
    if (testDb) {
      const { rows } = await testDb.query('select 1 from public.stripe_events where id = $1', [id]);
      return rows.length > 0;
    }
    const data = unwrap(await admin().from('stripe_events').select('id').eq('id', id).limit(1));
    return (data || []).length > 0;
  },

  /** Takes over a lock row older than `olderThanMs`. true when this caller now holds it. */
  async takeOver(id, olderThanMs) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    if (testDb) {
      const { rows } = await testDb.query(
        `update public.stripe_events set received_at = now()
          where id = $1 and received_at < $2::timestamptz returning id`,
        [id, cutoff]
      );
      return rows.length > 0;
    }
    const data = unwrap(
      await admin()
        .from('stripe_events')
        .update({ received_at: new Date().toISOString() })
        .eq('id', id)
        .lt('received_at', cutoff)
        .select('id')
    );
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
      await admin().from('profiles').select('id').eq('stripe_customer_id', customerId).limit(5)
    );
    return (data || []).map((r) => String(r.id));
  },

  async customerForUser(userId) {
    if (testDb) {
      const { rows } = await testDb.query('select stripe_customer_id from public.profiles where id = $1', [userId]);
      return rows[0]?.stripe_customer_id || null;
    }
    const data = unwrap(
      await admin().from('profiles').select('stripe_customer_id').eq('id', userId).maybeSingle()
    );
    return data?.stripe_customer_id || null;
  },

  async insertPending({ customerId, currency, amount, bucket, reason, ref }) {
    if (testDb) {
      await testDb.query(
        `insert into public.credit_pending_grants (stripe_customer_id, currency, amount, bucket, reason, ref)
         values ($1, $2, $3, $4, $5, $6) on conflict (reason, ref) do nothing`,
        [customerId, currency, amount, bucket, reason, ref]
      );
      return;
    }
    unwrap(
      await admin()
        .from('credit_pending_grants')
        .upsert(
          { stripe_customer_id: customerId, currency, amount, bucket, reason, ref },
          { onConflict: 'reason,ref', ignoreDuplicates: true }
        )
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
      await admin()
        .from('credit_pending_grants')
        .select('id, amount, claimed_by')
        .eq('reason', reason)
        .eq('ref', ref)
        .limit(1)
    );
    return data?.[0] || null;
  },

  async deleteUnclaimedPending(reason, ref) {
    if (testDb) {
      await testDb.query(
        'delete from public.credit_pending_grants where reason = $1 and ref = $2 and claimed_by is null',
        [reason, ref]
      );
      return;
    }
    unwrap(
      await admin().from('credit_pending_grants').delete().eq('reason', reason).eq('ref', ref).is('claimed_by', null)
    );
  },

  /** Lowers an unclaimed pending grant to `amount` (deletes it at 0). false when it is claimed or gone. */
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
    const table = () => admin().from('credit_pending_grants');
    if (amount <= 0) {
      const data = unwrap(await table().delete().eq('id', id).is('claimed_by', null).select('id'));
      return (data || []).length > 0;
    }
    // Only ever lowers: the filter leaves a smaller amount untouched.
    const data = unwrap(
      await table().update({ amount }).eq('id', id).is('claimed_by', null).gt('amount', amount).select('id')
    );
    if ((data || []).length > 0) return true;
    const check = unwrap(await table().select('id').eq('id', id).is('claimed_by', null));
    return (check || []).length > 0;
  },

  async claimPending(customerId, userId) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_claim_pending($1, $2) as n', [customerId, userId]);
      return rows[0].n;
    }
    return unwrap(await admin().rpc('credit_claim_pending', { p_customer: customerId, p_user: userId }));
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
      await admin()
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
        await admin()
          .from('credit_ledger')
          .select('ref, amount')
          .eq('user_id', userId)
          .eq('currency', currency)
          .eq('op', 'clawback')
          .in('reason', [REASON_REFUND, REASON_DISPUTE])
      ) || []
    );
  },

  async getReversal(sourceRef) {
    if (testDb) {
      const { rows } = await testDb.query(
        'select covered, total, reason, ref from public.credit_reversals where source_ref = $1',
        [sourceRef]
      );
      return rows[0] || null;
    }
    const data = unwrap(
      await admin().from('credit_reversals').select('covered, total, reason, ref').eq('source_ref', sourceRef).limit(1)
    );
    return data?.[0] || null;
  },

  /** Records money returned before the grant. `covered` only grows (one SQL statement). */
  async recordReversal({ sourceRef, covered, total, reason, ref }) {
    if (testDb) {
      await testDb.query('select public.credit_record_reversal($1, $2, $3, $4, $5)', [
        sourceRef, covered, total, reason, ref,
      ]);
      return;
    }
    unwrap(
      await admin().rpc('credit_record_reversal', {
        p_source: sourceRef, p_covered: covered, p_total: total, p_reason: reason, p_ref: ref,
      })
    );
  },

  /** Atomic one-to-one link: 'linked', 'linked_elsewhere' or 'user_has_other'. */
  async linkCustomer(userId, customerId, allowReplace = false) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_link_customer($1, $2, $3) as r', [
        userId, customerId, allowReplace,
      ]);
      return rows[0].r;
    }
    return unwrap(
      await admin().rpc('credit_link_customer', { p_user: userId, p_customer: customerId, p_allow_replace: allowReplace })
    );
  },
};

const isDeadlock = (err) => err?.code === '40P01' || /deadlock/i.test(String(err?.message || ''));

/**
 * Moves every unclaimed pending grant for this customer to the user. Returns
 * how many. A pending row whose (reason, ref) the user's ledger already holds
 * under another operation (the purchase landed on another path) would make
 * the claim fail forever: it is a duplicate, so it is deleted and the claim
 * retried.
 */
export async function claimPendingGrants(customerId, userId) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.claimPending(customerId, userId);
    } catch (raw) {
      const err = _mapError(raw);
      if (attempt >= 5) throw err;
      if (err instanceof RefConflictError && err.detail?.reason && err.detail?.ref) {
        console.warn('[grants] dropping duplicate pending grant', err.detail.reason, err.detail.ref);
        await store.deleteUnclaimedPending(err.detail.reason, err.detail.ref);
        continue;
      }
      if (!isDeadlock(raw)) throw err;
    }
  }
}

/** Records a Stripe event / object id. false when it was already recorded. */
export const recordStripeEvent = (id) => store.record(id);
export const isStripeEventRecorded = (id) => store.has(id);

/**
 * Links the customer to the user's profile atomically (customer -> user stays
 * one-to-one even when two users link at the same moment). Returns
 * 'linked', 'linked_elsewhere' or 'user_has_other' (the profile points at a
 * different customer and `allowReplace` is false). Callers decide the
 * Stripe-side relink rule first (lib/entitlement.js assertCanLink).
 */
export const linkCustomerAtomically = (userId, customerId, { allowReplace = false } = {}) =>
  store.linkCustomer(userId, customerId, allowReplace);

/** The raw claim nonce from the signed `ugc2_claim_nonce` cookie, or null. */
export function claimNonceFromCookie(value) {
  return value ? verifyClaimNonce(value) : null;
}

/** User ids whose profile is linked to this Stripe customer (service role read). */
export async function usersForCustomer(customerId) {
  return store.usersForCustomer(customerId);
}

/** The Stripe customer a user's profile is linked to (service role read), or null. */
export async function customerForUser(userId) {
  return store.customerForUser(userId);
}

/** { userId } for the one linked user, { userId: null } when none, { multi: true } when several. */
async function linkedUser(customerId) {
  const users = await store.usersForCustomer(customerId);
  if (users.length > 1) {
    // A data problem retries cannot heal: never throw (Stripe would retry
    // until it disables the endpoint). Park instead and shout.
    console.error('[grants] Stripe customer linked to several users; parking grant', customerId, users);
    return { multi: true, userId: null };
  }
  return { userId: users[0] || null };
}

// ---------------------------------------------------------------- helpers

const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);

export function sessionTag(sessionId) {
  return String(sessionId).replace(/^cs_(test_|live_)/, '').slice(-32);
}

function processedTags(md) {
  return (md[KEY.processedSessions] || '').split(',').filter(Boolean);
}

const isMissing = (err) => err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing';

/** Customer metadata, or null when the customer is deleted in Stripe. */
async function customerMetadata(customerId) {
  let customer;
  try {
    customer = await stripe().customers.retrieve(customerId);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (!customer || customer.deleted) return null;
  return customer.metadata || {};
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

/** What a checkout session bought: { plan, topup } (both null when it is not this app's price). */
export function purchaseOf(session) {
  const price = session?.line_items?.data?.[0]?.price;
  const plan = planFromPrice(price);
  return { plan, topup: plan ? null : topupFromPrice(price) };
}

async function subscriptionOf(invoice, subscription) {
  const subId = idOf(invoice.subscription);
  if (!subId) return null;
  return subscription || stripe().subscriptions.retrieve(subId, { expand: ['items.data.price'] });
}

/** Plan name for a subscription invoice, or null (not ours / no subscription). */
export async function planForInvoice(invoice, { subscription } = {}) {
  const sub = await subscriptionOf(invoice, subscription);
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

/** Returns 'wrote', 'already' (tag in processedSessions) or 'customer_deleted'. */
async function updateLegacyMetadata(customerId, build) {
  const md = await customerMetadata(customerId);
  if (md === null) return 'customer_deleted';
  const next = build(md);
  if (!next) return 'already';
  try {
    await stripe().customers.update(customerId, { metadata: next });
  } catch (err) {
    if (isMissing(err)) return 'customer_deleted';
    throw err;
  }
  return 'wrote';
}

function legacyTopupMetadata({ topup, tag, userId }) {
  return (md) => {
    const processed = processedTags(md);
    if (processed.includes(tag)) return null;
    const nextMd = { ...md, [KEY.processedSessions]: [tag, ...processed].slice(0, 10).join(',') };
    if (userId) nextMd.supabase_user_id = userId;
    if (topup.kind === 'image') {
      const current = parseInt(md[KEY.imageCredits] || '0', 10) || 0;
      nextMd[KEY.imageCredits] = String(current + topup.credits);
      if (!md[KEY.imagePeriodStart]) nextMd[KEY.imagePeriodStart] = String(Date.now());
    } else {
      const current = parseInt(md[KEY.credits] || '0', 10) || 0;
      nextMd[KEY.credits] = String(current + topup.credits);
    }
    return nextMd;
  };
}

function legacyPlanMetadata({ plan, session, tag, userId, clearPendingLink }) {
  return (md) => {
    const processed = processedTags(md);
    if (processed.includes(tag)) return null;
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
    return nextMd;
  };
}

/** Runs a legacy metadata write at most once per key (lock row + `:done`). */
async function legacyOnce(key, write) {
  const done = `${key}:done`;
  if (await store.has(done)) return 'already';
  if (!(await store.record(key))) {
    if (await store.has(done)) return 'already';
    if (!(await store.takeOver(key, LOCK_TAKEOVER_MS))) throw new GrantInProgressError(key);
    console.warn('[grants] took over a stale grant lock', key);
  }
  try {
    const result = await write();
    await store.record(done);
    return result;
  } catch (err) {
    await store.forget(key).catch((e) => console.error('[grants] could not release', key, e.message));
    throw err;
  }
}

// ---------------------------------------------------------------- grants

/**
 * Grants what a paid checkout session bought. Safe to call from the webhook,
 * /confirm and the claim routes at the same time: one of them grants; the
 * others return `already` or throw GrantInProgressError.
 *
 * `userId` is the caller that /confirm or a claim route has already checked
 * with checkSessionOwner and assertCanLink; the webhook passes the buyer id
 * the server stored on the session (or none). Under billing_v2 a customer
 * with no linked user is granted to `userId` directly, else parked. Legacy
 * plan seeding needs `userId`, so without it a legacy subscription session is
 * skipped (and not recorded). Under billing_v2 subscriptions are granted per
 * invoice by grantForInvoice, so this only grants top-ups.
 *
 * Returns { granted, already, pending, skipped, kind, plan, topup, amount, currency }.
 */
export async function grantForCheckoutSession(session, { userId, clearPendingLink = false } = {}) {
  const full = await withLineItems(session);
  const { plan, topup } = purchaseOf(full);
  const kind = plan ? 'subscription' : topup ? 'topup' : null;
  const out = { granted: false, already: false, pending: false, skipped: null, kind, plan, topup };

  if (!kind) return { ...out, skipped: 'not_ours' };
  if (full.payment_status !== 'paid' && full.payment_status !== 'no_payment_required') {
    return { ...out, skipped: 'unpaid' };
  }
  const customerId = idOf(full.customer);
  if (!customerId) return { ...out, skipped: 'no_customer' };

  const key = `checkout:${full.id}`;
  const v2 = await isBillingV2Strict();
  if (kind === 'subscription' && v2) return { ...out, skipped: 'granted_per_invoice' };
  if (kind === 'subscription' && !userId) return { ...out, skipped: 'needs_user' };
  if (await store.has(`${key}:done`)) return { ...out, already: true };
  if (full.created && Date.now() / 1000 - full.created > MAX_SESSION_AGE_S) {
    return { ...out, skipped: 'too_old' };
  }
  const tag = sessionTag(full.id);

  if (!v2) {
    const build =
      kind === 'topup'
        ? legacyTopupMetadata({ topup, tag, userId })
        : legacyPlanMetadata({ plan, session: full, tag, userId, clearPendingLink });
    const result = await legacyOnce(key, () => updateLegacyMetadata(customerId, build));
    if (result === 'already') return { ...out, already: true };
    if (result === 'customer_deleted') return { ...out, skipped: 'customer_deleted' };
    return {
      ...out,
      granted: true,
      amount: kind === 'topup' ? topup.credits : CAPS[plan],
      currency: topup?.kind === 'image' ? 'image' : 'video',
    };
  }

  // billing_v2 top-up. Granted on the legacy path before the flip: no ledger row.
  const md = await customerMetadata(customerId);
  if (md && processedTags(md).includes(tag)) {
    await store.record(`${key}:done`);
    return { ...out, already: true };
  }
  const reversal = await store.getReversal(key);
  if (reversal && reversal.covered >= reversal.total) {
    await store.record(`${key}:done`);
    return { ...out, skipped: 'reversed' };
  }

  const { currency, amount } = v2TopupGrant(topup);
  const result = await grantOrPark({
    customerId,
    userHint: userId,
    currency,
    amount,
    bucket: 'topup',
    reason: REASON_TOPUP,
    ref: key,
    grant: (uid) =>
      grantCredits({ userId: uid, currency, amount, bucket: 'topup', reason: REASON_TOPUP, ref: key }),
  });
  await applyReversal({ ref: key, reason: REASON_TOPUP, sessionId: full.id }, amount);
  await store.record(`${key}:done`);
  return { ...out, ...result, amount, currency };
}

/**
 * Grants a paid subscription invoice (billing_v2): renewPlanCredits with ref
 * `invoice:<id>`, or a parked pending grant. Pass the invoice as retrieved
 * through the SDK (its fields follow the SDK's pinned API version, not the
 * webhook endpoint's). Only first and cycle invoices grant; trialing,
 * proration and manual invoices do not. Legacy mode does nothing here (plan
 * credits roll over lazily in lib/entitlement.js).
 */
export async function grantForInvoice(invoice, { subscription } = {}) {
  const out = { granted: false, already: false, pending: false, skipped: null };
  if (!invoice?.subscription) return { ...out, skipped: 'no_subscription' };
  if (invoice.status !== 'paid') return { ...out, skipped: 'unpaid' };
  if (!GRANTED_INVOICE_REASONS.has(invoice.billing_reason)) return { ...out, skipped: 'not_a_period' };

  const sub = await subscriptionOf(invoice, subscription);
  const plan = planFromPrice(sub?.items?.data?.[0]?.price);
  if (!plan) return { ...out, skipped: 'not_ours' };
  if (!(await isBillingV2Strict())) return { ...out, plan, skipped: 'legacy' };
  if (sub.status === 'trialing') return { ...out, plan, skipped: 'trialing' };
  const customerId = idOf(invoice.customer);
  if (!customerId) return { ...out, plan, skipped: 'no_customer' };

  const key = `invoice:${invoice.id}`;
  if (await store.has(`${key}:done`)) return { ...out, plan, already: true };
  const reversal = await store.getReversal(key);
  if (reversal && reversal.covered >= reversal.total) {
    await store.record(`${key}:done`);
    return { ...out, plan, skipped: 'reversed' };
  }
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
  await applyReversal({ ref: key, reason: REASON_RENEWAL, invoiceId: invoice.id }, allotment);
  await store.record(`${key}:done`);
  return { ...out, ...result, plan, amount: allotment, currency: 'video' };
}

// A refund or dispute may have written its tombstone while the grant was in
// flight: re-read it after the grant and claw back the reversed share (by
// the tombstone's ref, so it is applied once).
async function applyReversal(source, original) {
  const reversal = await store.getReversal(source.ref);
  if (reversal) await reverseSource({ source, ...reversal, original });
}

/**
 * Grants to the customer's linked user, or parks the grant.
 *
 * For a customer with no linked user the grant is never given straight to a
 * caller: it is parked in credit_pending_grants (globally unique on
 * (reason, ref)), then `userHint` (an owner-checked caller, or the buyer id
 * the server stored on the session) is linked atomically and the customer's
 * pending grants are claimed for whoever the customer is now linked to. Two
 * owner-verified callers racing on one unlinked customer therefore produce
 * one pending row, one link and one claim. Whenever a linked user exists,
 * the customer's other pending rows are claimed too.
 */
async function grantOrPark({ customerId, userHint, currency, amount, bucket, reason, ref, grant }) {
  const linked = await linkedUser(customerId);
  if (linked.userId) {
    try {
      await grant(linked.userId);
    } catch (err) {
      // The same (reason, ref) already exists under another operation (for
      // example a claimed pending grant): it was granted. A parked duplicate
      // would block every later claim, so drop it.
      if (!(err instanceof RefConflictError)) throw err;
      await store.deleteUnclaimedPending(reason, ref);
      await claimPendingGrants(customerId, linked.userId);
      return { already: true, userId: linked.userId };
    }
    await claimPendingGrants(customerId, linked.userId);
    return { granted: true, userId: linked.userId };
  }
  await store.insertPending({ customerId, currency, amount, bucket, reason, ref });
  if (linked.multi) return { pending: true };
  if (userHint) await store.linkCustomer(userHint, customerId);
  // Linked now (by the hint, or by someone else in the meantime)?
  const now = await linkedUser(customerId);
  if (now.userId) {
    await claimPendingGrants(customerId, now.userId);
    const mine = await store.findPending(reason, ref);
    return mine?.claimed_by && String(mine.claimed_by) === now.userId
      ? { granted: true, userId: now.userId }
      : { already: true, userId: now.userId };
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

/** What a purchase grants under billing_v2, recomputed from Stripe. 0 when it is not this app's. */
async function originalGrantAmount(source) {
  if (source.sessionId) {
    const s = await withLineItems({ id: source.sessionId });
    const { topup } = purchaseOf(s);
    return topup ? v2TopupGrant(topup).amount : 0;
  }
  const invoice = await stripe().invoices.retrieve(source.invoiceId);
  const plan = await planForInvoice(invoice);
  return plan ? v2PlanAllotment(plan) : 0;
}

/**
 * Claws back `covered / total` of what the purchase granted, cumulative per
 * purchase (earlier refund and dispute clawbacks count). Returns
 * { noGrant: true } when nothing was granted or parked yet.
 */
async function reverseSource({ source, covered, total, reason, ref, original }, retried = false) {
  const targetFor = (granted) => Math.min(granted, Math.ceil((granted * covered) / total));
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
    const full = original ?? (await originalGrantAmount(source));
    const remaining = Math.max(0, full - targetFor(full));
    if (await store.lowerPending(pending.id, remaining)) return { pendingLoweredTo: remaining, ref };
    // Claimed in the meantime: the ledger row exists now.
    if (!retried) return reverseSource({ source, covered, total, reason, ref, original }, true);
  }
  return { noGrant: true, ref };
}

async function disputedAmount(charge, dispute) {
  const seen = new Map();
  if (dispute?.id) seen.set(dispute.id, dispute.amount || 0);
  if (charge.disputed || dispute) {
    const list = await stripe().disputes.list({ charge: charge.id, limit: 100 });
    for (const d of list?.data || []) seen.set(d.id, d.amount || 0);
  }
  return [...seen.values()].reduce((n, a) => n + a, 0);
}

/**
 * Claws back what a refunded or disputed purchase granted (billing_v2 only).
 * Pass `{ charge }` for charge.refunded or `{ dispute }` for
 * charge.dispute.created. The charge is re-read through the SDK. The amount
 * is proportional to the money returned, rounded up, and cumulative per
 * purchase. A refund or dispute that arrives before the grant writes a
 * credit_reversals tombstone, which the grant applies.
 */
export async function clawbackForPayment({ charge, dispute }) {
  if (!(await isBillingV2Strict())) return { skipped: 'legacy' };
  const chargeId = charge ? idOf(charge) : idOf(dispute.charge);
  if (!chargeId) return { skipped: 'no_charge' };
  const ch = await stripe().charges.retrieve(chargeId);
  if (!ch?.amount) return { skipped: 'no_amount' };
  const source = await sourceRefForCharge(ch);
  if (!source) return { skipped: 'no_source' };

  // Money returned so far: refunds plus every dispute on the charge, so a
  // partial dispute followed by a partial refund (or the reverse) counts both.
  const covered = Math.min(ch.amount, (ch.amount_refunded || 0) + (await disputedAmount(ch, dispute)));
  if (covered <= 0) return { skipped: 'nothing_returned' };
  const reason = dispute ? REASON_DISPUTE : REASON_REFUND;
  const ref = dispute ? `${source.ref}:dispute:${dispute.id}` : `${source.ref}:refund:${covered}`;
  const args = { source, covered, total: ch.amount, reason, ref };

  const result = await reverseSource(args);
  if (!result.noGrant) return result;

  // Nothing granted yet. Only this app's purchases get a tombstone.
  if (!(await originalGrantAmount(source))) return { skipped: 'not_ours' };
  await store.recordReversal({ sourceRef: source.ref, covered, total: ch.amount, reason, ref });
  // The grant may have landed while we wrote the tombstone.
  const after = await reverseSource(args);
  return after.noGrant ? { tombstone: true, ref } : after;
}
