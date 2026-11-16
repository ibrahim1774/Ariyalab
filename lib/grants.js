import { createHash, timingSafeEqual } from 'node:crypto';
import { stripe, planFromPrice, topupFromPrice, planInfoFromPrice, parseV2LookupKey, CAPS } from './stripe.js';
import { KEY } from './metaKeys.js';
import { getSupabaseAdmin } from './supabaseServer.js';
import { grantCredits, renewPlanCredits, RefConflictError, _mapError } from './credits.js';
import { LEGACY_TO_V2 } from './pricing.js';
import { isBillingV2Strict } from './billingFlags.js';
import { signClaimNonces, verifyClaimNonces } from './jobToken.js';

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
        `insert into public.credit_pending_grants (stripe_customer_id, currency, amount, original_amount, bucket, reason, ref)
         values ($1, $2, $3, $3, $4, $5, $6) on conflict (reason, ref) do nothing`,
        [customerId, currency, amount, bucket, reason, ref]
      );
      return;
    }
    unwrap(
      await admin()
        .from('credit_pending_grants')
        .upsert(
          { stripe_customer_id: customerId, currency, amount, original_amount: amount, bucket, reason, ref },
          { onConflict: 'reason,ref', ignoreDuplicates: true }
        )
    );
  },

  async findPending(reason, ref) {
    if (testDb) {
      const { rows } = await testDb.query(
        'select id, amount, original_amount, claimed_by from public.credit_pending_grants where reason = $1 and ref = $2',
        [reason, ref]
      );
      return rows[0] || null;
    }
    const data = unwrap(
      await admin()
        .from('credit_pending_grants')
        .select('id, amount, original_amount, claimed_by')
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

  /** credit_lower_pending: 'lowered' | 'claimed' | 'missing'. */
  async lowerPending({ reason, sourceRef, covered, total }) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_lower_pending($1, $2, $3, $4) as r', [
        reason, sourceRef, covered, total,
      ]);
      return rows[0].r;
    }
    return unwrap(
      await admin().rpc('credit_lower_pending', {
        p_reason: reason, p_source: sourceRef, p_covered: covered, p_total: total,
      })
    );
  },

  /** credit_reverse_grant: credits clawed back now. */
  async reverseGrant({ sourceRef, userId, currency, granted, covered, total, reason, ref, firstBucket, already = 0 }) {
    const args = [sourceRef, userId, currency, granted, covered, total, reason, ref, firstBucket, already];
    try {
      if (testDb) {
        const { rows } = await testDb.query(
          'select public.credit_reverse_grant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as n',
          args
        );
        return rows[0].n;
      }
      return unwrap(
        await admin().rpc('credit_reverse_grant', {
          p_source: sourceRef, p_user: userId, p_currency: currency, p_granted: granted,
          p_covered: covered, p_total: total, p_reason: reason, p_ref: ref, p_first_bucket: firstBucket,
          p_already: already,
        })
      );
    } catch (err) {
      throw _mapError(err);
    }
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

  /** Upserts the record of a yearly v2 subscription (credit_yearly_subs); the period moves only forward. */
  async recordYearly({ sub, customerId, plan, credits }) {
    const row = {
      sub_id: sub.id,
      customer_id: customerId,
      plan,
      credits,
      period_start: new Date((sub.current_period_start || 0) * 1000).toISOString(),
      period_end: new Date((sub.current_period_end || 0) * 1000).toISOString(),
      status: sub.status || 'active',
    };
    if (testDb) {
      await testDb.query('select public.credit_yearly_record($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7)', [
        row.sub_id, row.customer_id, row.plan, row.credits, row.period_start, row.period_end, row.status,
      ]);
      return;
    }
    unwrap(
      await admin().rpc('credit_yearly_record', {
        p_sub: row.sub_id, p_customer: row.customer_id, p_plan: row.plan, p_credits: row.credits,
        p_period_start: row.period_start, p_period_end: row.period_end, p_status: row.status,
      })
    );
  },

  async setYearlyStatus(subId, status) {
    if (testDb) {
      await testDb.query('update public.credit_yearly_subs set status = $2, updated_at = now() where sub_id = $1', [subId, status]);
      return;
    }
    unwrap(await admin().from('credit_yearly_subs').update({ status, updated_at: new Date().toISOString() }).eq('sub_id', subId));
  },

  /** Active yearly subscriptions whose period is still running, least recently granted first. */
  async yearlyDue(limit) {
    if (testDb) {
      const { rows } = await testDb.query(
        `select sub_id, customer_id, plan, credits, period_start, period_end from public.credit_yearly_subs
          where status in ('active', 'trialing') and period_end > now()
          order by last_run_at nulls first, sub_id limit $1`,
        [limit]
      );
      return rows.map((r) => ({ ...r, period_start: new Date(r.period_start), period_end: new Date(r.period_end) }));
    }
    const data = unwrap(
      await admin()
        .from('credit_yearly_subs')
        .select('sub_id, customer_id, plan, credits, period_start, period_end')
        .in('status', ['active', 'trialing'])
        .gt('period_end', new Date().toISOString())
        .order('last_run_at', { ascending: true, nullsFirst: true })
        .order('sub_id')
        .limit(limit)
    );
    return (data || []).map((r) => ({ ...r, period_start: new Date(r.period_start), period_end: new Date(r.period_end) }));
  },

  async touchYearly(subId) {
    if (testDb) {
      await testDb.query('update public.credit_yearly_subs set last_run_at = now() where sub_id = $1', [subId]);
      return;
    }
    unwrap(await admin().from('credit_yearly_subs').update({ last_run_at: new Date().toISOString() }).eq('sub_id', subId));
  },

  /** True when scripts/migrate-legacy-credits.mjs moved this customer (credit_legacy_migrations). */
  async isMigrated(customerId) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_legacy_migrated($1) as r', [customerId]);
      return rows[0].r === true;
    }
    return unwrap(await admin().rpc('credit_legacy_migrated', { p_customer: customerId })) === true;
  },

  /** Atomic one-to-one link: 'linked', 'linked_elsewhere', 'user_has_other' or 'conflict'. */
  async linkCustomer(userId, customerId, allowReplace = false, expectedOld = null) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_link_customer($1, $2, $3, $4) as r', [
        userId, customerId, allowReplace, expectedOld,
      ]);
      return rows[0].r;
    }
    return unwrap(
      await admin().rpc('credit_link_customer', {
        p_user: userId, p_customer: customerId, p_allow_replace: allowReplace, p_expected_old: expectedOld,
      })
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
 * 'linked', 'linked_elsewhere', 'user_has_other' (the profile points at a
 * different customer and `allowReplace` is false) or 'conflict' (a
 * replacement was allowed, but the profile no longer points at
 * `expectedOld`: the link changed since the caller looked). Callers decide
 * the Stripe-side relink rule first (lib/entitlement.js assertCanLink).
 */
export const linkCustomerAtomically = (userId, customerId, { allowReplace = false, expectedOld = null } = {}) =>
  store.linkCustomer(userId, customerId, allowReplace, expectedOld);

/**
 * This browser's unexpired claim nonces from the signed `ugc2_claim_nonce`
 * cookie ([] when absent, forged or all older than 24 hours).
 */
export function claimNoncesFromCookie(value) {
  return ((value && verifyClaimNonces(value)) || []).map((entry) => entry.nonce);
}

/**
 * The claim cookie value to send back once `session` was claimed: the same
 * list without the nonce that matches the session's ticket, so another paid
 * session from this browser keeps its ticket. null when nothing is left
 * (clear the cookie).
 */
export function claimCookieWithoutSession(value, session) {
  const ticket = session?.metadata?.claim_ticket;
  const left = ((value && verifyClaimNonces(value)) || []).filter(
    (entry) => !ticket || !sameHex(hashClaimTicket(entry.nonce), ticket)
  );
  return left.length ? signClaimNonces(left) : null;
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

/** What a top-up pack grants under billing_v2: a v2 pack its own credits, a legacy pack converted. */
export function v2TopupGrant(topup) {
  if (topup.v2) return { currency: 'video', amount: topup.credits };
  const currency = topup.kind === 'image' ? 'image' : 'video';
  return { currency, amount: currency === 'video' ? legacyToV2(topup.credits) : topup.credits };
}

/** What a legacy plan's invoice grants under billing_v2. */
export function v2PlanAllotment(plan) {
  return legacyToV2(CAPS[plan]);
}

/**
 * What one period of a subscription price grants under billing_v2: a v2
 * price the credits named in its lookup key (a yearly v2 price: one month's
 * worth, the rest come from the yearly cron), a legacy price its cap
 * converted (ceil(cap x 21 / 100)). 0 when the price is not this app's.
 */
export function v2AllotmentForPrice(price) {
  const info = planInfoFromPrice(price);
  if (!info) return 0;
  return info.version === 'v2' ? info.credits : v2PlanAllotment(info.plan);
}

/** True when a price is a billing v2 price (always granted in the ledger, whatever the flag says). */
export const isV2Price = (price) => Boolean(parseV2LookupKey(price?.lookup_key));

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
 * issued to the caller's browser at checkout (any nonce in the browser's
 * signed list). Returns { ok, via } with the STRONGEST proof that holds, in
 * this order: 'client_reference_id', 'metadata', 'ticket', 'email'. Only the
 * non-email proofs may move a profile off an existing customer, and only
 * when relink_mode allows it (lib/entitlement.js assertCanLink).
 */
export function checkSessionOwner(session, user, { claimNonces } = {}) {
  if (!session || !user?.id) return { ok: false };
  if (session.client_reference_id && session.client_reference_id === user.id) {
    return { ok: true, via: 'client_reference_id' };
  }
  if (session.metadata?.supabase_user_id && session.metadata.supabase_user_id === user.id) {
    return { ok: true, via: 'metadata' };
  }
  const ticket = session.metadata?.claim_ticket;
  if (ticket && (claimNonces || []).some((n) => sameHex(hashClaimTicket(n), ticket))) {
    return { ok: true, via: 'ticket' };
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
    // A customer that received another customer's credits in a merge and was
    // never seeded since (no period on it): the balance is moved credits, so
    // the allotment is added to it instead of swallowing it.
    const holdsMovedCredits = Boolean(md[KEY.relinkedFrom]) && !md[KEY.periodStart];
    const seededCredits = isTrialing
      ? existingCredits
      : holdsMovedCredits
        ? existingCredits + CAPS[plan]
        : Math.max(existingCredits, CAPS[plan]);
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

/**
 * Runs `write` at most once per key (lock row + `:done`, stale-lock takeover
 * after LOCK_TAKEOVER_MS, GrantInProgressError while another run holds it).
 * `write` must be safe to resume after a crash. Used for legacy grants and
 * for relinks (lib/entitlement.js).
 */
export async function runOnce(key, write) {
  return legacyOnce(key, write);
}

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

/**
 * Runs `fn` while holding the lock row `key`, and releases it afterwards
 * (a mutex, unlike runOnce there is no `:done`). Another holder raises
 * GrantInProgressError; a lock older than LOCK_TAKEOVER_MS belongs to a path
 * that died and is taken over, so `fn` must be safe to resume. Used to
 * serialize relinks per old customer and per user (lib/entitlement.js).
 */
export async function withLock(key, fn) {
  if (!(await store.record(key))) {
    if (!(await store.takeOver(key, LOCK_TAKEOVER_MS))) throw new GrantInProgressError(key);
    console.warn('[grants] took over a stale lock', key);
  }
  try {
    return await fn();
  } finally {
    await store.forget(key).catch((e) => console.error('[grants] could not release', key, e.message));
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
 * the server stored on the session (or none). Under billing_v2 a grant for
 * a customer with no linked user is parked, `userId` is linked when their
 * profile has no other customer, and the parked grant is claimed for the
 * linked user (grantOrPark). Legacy
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
  // A v2 price is granted in the ledger even if billing_v2 was switched off
  // after the session was created: it must never land in legacy metadata.
  const v2 = isV2Price(full.line_items?.data?.[0]?.price) || (await ledgerFor(customerId));
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
  await applyReversal({ ref: key, reason: REASON_TOPUP, sessionId: full.id });
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
  const price = sub?.items?.data?.[0]?.price;
  const plan = planFromPrice(price);
  if (!plan) return { ...out, skipped: 'not_ours' };
  const customerId = idOf(invoice.customer);
  if (!isV2Price(price) && !(await ledgerFor(customerId))) return { ...out, plan, skipped: 'legacy' };
  if (sub.status === 'trialing') return { ...out, plan, skipped: 'trialing' };
  if (!customerId) return { ...out, plan, skipped: 'no_customer' };

  const key = `invoice:${invoice.id}`;
  if (await store.has(`${key}:done`)) return { ...out, plan, already: true };
  const reversal = await store.getReversal(key);
  if (reversal && reversal.covered >= reversal.total) {
    await store.record(`${key}:done`);
    return { ...out, plan, skipped: 'reversed' };
  }
  const allotment = v2AllotmentForPrice(price);
  if (!(allotment > 0)) return { ...out, plan, skipped: 'not_ours' };
  // A yearly v2 plan: this invoice grants the first month; the yearly cron
  // grants the others (lib/yearlyGrants.js). Recorded before the grant so a
  // crash in between still leaves the subscription known to the cron.
  const info = planInfoFromPrice(price);
  if (info.version === 'v2' && info.interval === 'year') {
    await store.recordYearly({ sub, customerId, plan, credits: info.credits });
  }
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
  await applyReversal({ ref: key, reason: REASON_RENEWAL, invoiceId: invoice.id });
  await store.record(`${key}:done`);
  return { ...out, ...result, plan, amount: allotment, currency: 'video' };
}

// ---------------------------------------------------------------- yearly v2

const REASON_UPGRADE = 'plan_upgrade';

/** `date` plus `months` calendar months (UTC), the day clamped to the month's last day. */
export function addMonthsUtc(date, months) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

/** The ledger ref of month `start` of a yearly subscription: yearly:<subId>:<YYYY-MM>. */
export function yearlyRef(subId, start) {
  const d = new Date(start);
  return `yearly:${subId}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The months of a yearly period that are due by `now` and granted by the
 * cron: months 1..11, counted from the period start (the subscription's
 * anchor, not calendar months). Month 0 is the invoice's own grant.
 */
export function dueYearlyMonths({ periodStart, periodEnd, now = new Date() }) {
  const out = [];
  for (let k = 1; k < 12; k += 1) {
    const start = addMonthsUtc(periodStart, k);
    if (start > now || start >= periodEnd) break;
    out.push(start);
  }
  return out;
}

/**
 * The yearly cron (pages/api/cron/grant-yearly.js): for each running yearly
 * v2 subscription, grants each month that is due with renewPlanCredits under
 * ref yearly:<subId>:<YYYY-MM> (idempotent: a repeat is a no-op), or parks it
 * for a customer with no linked user. Bounded by `limit` and `budgetMs`.
 */
export async function grantYearlyMonths({ now = new Date(), limit = 200, budgetMs = 45_000 } = {}) {
  const started = Date.now();
  const summary = { subscriptions: 0, granted: 0, already: 0, pending: 0, failed: 0 };
  for (const row of await store.yearlyDue(limit)) {
    if (Date.now() - started > budgetMs) break;
    summary.subscriptions += 1;
    try {
      for (const start of dueYearlyMonths({ periodStart: row.period_start, periodEnd: row.period_end, now })) {
        const ref = yearlyRef(row.sub_id, start);
        const result = await grantOrPark({
          customerId: row.customer_id,
          currency: 'video',
          amount: row.credits,
          bucket: 'plan',
          reason: REASON_RENEWAL,
          ref,
          grant: async (uid) => {
            if (await store.findPending(REASON_RENEWAL, ref)) return claimPendingGrants(row.customer_id, uid);
            return renewPlanCredits({ userId: uid, allotment: row.credits, ref });
          },
        });
        if (result.pending) summary.pending += 1;
        else if (result.granted) summary.granted += 1;
        else summary.already += 1;
      }
      await store.touchYearly(row.sub_id);
    } catch (err) {
      summary.failed += 1;
      console.error('[grants] yearly grant failed', row.sub_id, err.message);
    }
  }
  return summary;
}

/**
 * customer.subscription.updated / .deleted (billing v2 only; never writes for
 * a price that is not this app's). Keeps credit_yearly_subs in step (status,
 * period, plan) and grants a mid-period upgrade: the difference between the
 * new and the old plan's monthly allotment, once for the current period, in
 * the plan bucket, ref upgrade:<subId>:<periodStart>. A downgrade grants
 * nothing; the lower allotment starts at the next renewal. `previous` is the
 * event's data.previous_attributes (the old price is read from it).
 */
export async function syncSubscription(eventSub, previous = {}, { deleted = false } = {}) {
  const sub = await stripe().subscriptions.retrieve(eventSub.id, { expand: ['items.data.price'] });
  const price = sub?.items?.data?.[0]?.price;
  const info = planInfoFromPrice(price);
  const out = { yearly: null, upgrade: null };
  if (!info) return { ...out, skipped: 'not_ours' };
  const customerId = idOf(sub.customer);
  if (info.version === 'v2' && info.interval === 'year') {
    await store.recordYearly({ sub, customerId, plan: info.plan, credits: info.credits });
    out.yearly = sub.status;
  }
  if (deleted || !['active', 'trialing'].includes(sub.status)) {
    await store.setYearlyStatus(sub.id, deleted ? 'canceled' : sub.status);
    return out;
  }
  if (!(info.version === 'v2' && info.interval === 'year')) await store.setYearlyStatus(sub.id, 'switched');

  const oldPrice = previous?.items?.data?.[0]?.price;
  if (!oldPrice || oldPrice.id === price.id || oldPrice.lookup_key === price.lookup_key) return out;
  if (sub.status !== 'active') return out;
  if (!isV2Price(price) && !(await ledgerFor(customerId))) return { ...out, skipped: 'legacy' };
  const before = v2AllotmentForPrice(oldPrice);
  const after = v2AllotmentForPrice(price);
  if (!(before > 0) || !(after > before)) return { ...out, upgrade: 'none' };
  const amount = after - before;
  const ref = `upgrade:${sub.id}:${sub.current_period_start}`;
  const result = await grantOrPark({
    customerId,
    currency: 'video',
    amount,
    bucket: 'plan',
    reason: REASON_UPGRADE,
    ref,
    grant: async (uid) => {
      if (await store.findPending(REASON_UPGRADE, ref)) return claimPendingGrants(customerId, uid);
      return grantCredits({ userId: uid, currency: 'video', amount, bucket: 'plan', reason: REASON_UPGRADE, ref });
    },
  });
  return { ...out, upgrade: { amount, ref, ...result } };
}

/** A refunded or disputed yearly invoice stops the cron's later months for that subscription. */
async function stopYearlyForInvoice(invoiceId) {
  const invoice = await stripe().invoices.retrieve(invoiceId);
  const subId = idOf(invoice?.subscription);
  if (subId) await store.setYearlyStatus(subId, 'refunded');
}

// A refund or dispute may have written its tombstone while the grant was in
// flight: re-read it after the grant and claw back the reversed share (by
// the tombstone's ref, so it is applied once).
async function applyReversal(source) {
  const reversal = await store.getReversal(source.ref);
  if (reversal) await reverseSource({ source, ...reversal });
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

/**
 * For scripts/migrate-legacy-credits.mjs: parks a grant for a Stripe customer
 * with no single linked user (claimed when the customer is linked, like any
 * parked purchase), and reads one back. Idempotent on (reason, ref).
 */
export const parkPendingGrant = ({ customerId, currency, amount, bucket, reason, ref }) =>
  store.insertPending({ customerId, currency, amount, bucket, reason, ref });
export const findPendingGrant = (reason, ref) => store.findPending(reason, ref);

/**
 * Whether a purchase by this customer is granted in the ledger: billing_v2
 * is on, or the legacy migration already moved the customer (their legacy
 * metadata is no longer spendable, so switching billing_v2 off again must not
 * strand a new purchase there).
 */
async function ledgerFor(customerId) {
  if (await isBillingV2Strict()) return true;
  return Boolean(customerId) && (await store.isMigrated(customerId));
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
  const sub = await subscriptionOf(invoice);
  return v2AllotmentForPrice(sub?.items?.data?.[0]?.price);
}

/**
 * Claws back `covered / total` of what the purchase granted, cumulative per
 * purchase (earlier refund and dispute clawbacks count). Returns
 * { noGrant: true } when nothing was granted or parked yet.
 */
async function reverseSource({ source, covered, total, reason, ref }, retried = false) {
  const grant = await store.findGrant(source.ref);
  if (grant) {
    // A grant that was parked first may have been lowered by an earlier
    // refund before it was claimed: the ledger row then holds less than the
    // purchase originally granted. The share is always computed from the
    // original amount, and what was already taken off while parked
    // (original - claimed) counts as reversed.
    const parked = await store.findPending(source.reason, source.ref);
    const wasParked = parked?.claimed_by && String(parked.claimed_by) === grant.user_id;
    const granted = wasParked ? Math.max(grant.amount, parked.original_amount || 0) : grant.amount;
    // Computed and applied under a per-source lock in one SQL call, so two
    // refund/dispute actors with different refs cannot both claw from the
    // same "already clawed" total. Takes from the bucket the purchase filled.
    const amount = await store.reverseGrant({
      sourceRef: source.ref,
      userId: grant.user_id,
      currency: grant.currency,
      granted,
      already: granted - grant.amount,
      covered,
      total,
      reason,
      ref,
      firstBucket: grant.bucket === 'topup' ? 'topup' : 'plan',
    });
    return { amount, ref, userId: grant.user_id };
  }
  // Parked: lowered from the amount it was parked with, under the same lock.
  const lowered = await store.lowerPending({ reason: source.reason, sourceRef: source.ref, covered, total });
  if (lowered === 'lowered') return { pendingLowered: true, ref };
  // Claimed in the meantime: the ledger row exists now.
  if (lowered === 'claimed' && !retried) return reverseSource({ source, covered, total, reason, ref }, true);
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
 * Claws back what a refunded or disputed purchase granted (billing_v2, or a
 * customer moved by the legacy migration whatever the flag).
 * Pass `{ charge }` for charge.refunded or `{ dispute }` for
 * charge.dispute.created. The charge is re-read through the SDK. The amount
 * is proportional to the money returned, rounded up, and cumulative per
 * purchase. A refund or dispute that arrives before the grant writes a
 * credit_reversals tombstone, which the grant applies.
 */
export async function clawbackForPayment({ charge, dispute }) {
  const flagOn = await isBillingV2Strict();
  const chargeId = charge ? idOf(charge) : idOf(dispute.charge);
  if (!flagOn && !chargeId) return { skipped: 'legacy' };
  if (!chargeId) return { skipped: 'no_charge' };
  const ch = await stripe().charges.retrieve(chargeId);
  // With billing_v2 off, only a customer moved by the legacy migration (whose
  // purchases are granted in the ledger, ledgerFor) is clawed back here.
  if (!flagOn && !(await ledgerFor(idOf(ch?.customer)))) return { skipped: 'legacy' };
  if (!ch?.amount) return { skipped: 'no_amount' };
  const source = await sourceRefForCharge(ch);
  if (!source) return { skipped: 'no_source' };

  // Money returned so far: refunds plus every dispute on the charge, so a
  // partial dispute followed by a partial refund (or the reverse) counts both.
  const covered = Math.min(ch.amount, (ch.amount_refunded || 0) + (await disputedAmount(ch, dispute)));
  if (covered <= 0) return { skipped: 'nothing_returned' };
  const reason = dispute ? REASON_DISPUTE : REASON_REFUND;
  if (source.invoiceId) await stopYearlyForInvoice(source.invoiceId);
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
