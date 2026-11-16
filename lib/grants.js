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
          where ref = $1 and reason in ($2, $3, $4) and op in ('grant', 'renew')
          order by id limit 1`,
        [ref, REASON_TOPUP, REASON_RENEWAL, REASON_UPGRADE]
      );
      return rows[0] ? { ...rows[0], user_id: String(rows[0].user_id) } : null;
    }
    const data = unwrap(
      await admin()
        .from('credit_ledger')
        .select('user_id, currency, amount, bucket')
        .eq('ref', ref)
        .in('reason', [REASON_TOPUP, REASON_RENEWAL, REASON_UPGRADE])
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
  async recordYearly({ sub, customerId, plan, credits, invoiceId = null }) {
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
      await testDb.query('select public.credit_yearly_record($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8)', [
        row.sub_id, row.customer_id, row.plan, row.credits, row.period_start, row.period_end, row.status, invoiceId,
      ]);
      return;
    }
    unwrap(
      await admin().rpc('credit_yearly_record', {
        p_sub: row.sub_id, p_customer: row.customer_id, p_plan: row.plan, p_credits: row.credits,
        p_period_start: row.period_start, p_period_end: row.period_end, p_status: row.status, p_invoice: invoiceId,
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
        `select sub_id, customer_id, plan, credits, period_start, period_end, period_invoice_id from public.credit_yearly_subs
          where status in ('active', 'trialing') and period_end > now()
          order by last_run_at nulls first, sub_id limit $1`,
        [limit]
      );
      return rows.map((r) => ({ ...r, period_start: new Date(r.period_start), period_end: new Date(r.period_end) }));
    }
    const data = unwrap(
      await admin()
        .from('credit_yearly_subs')
        .select('sub_id, customer_id, plan, credits, period_start, period_end, period_invoice_id')
        .in('status', ['active', 'trialing'])
        .gt('period_end', new Date().toISOString())
        .order('last_run_at', { ascending: true, nullsFirst: true })
        .order('sub_id')
        .limit(limit)
    );
    return (data || []).map((r) => ({ ...r, period_start: new Date(r.period_start), period_end: new Date(r.period_end) }));
  },

  /** subscription.updated: status, and credits only ever lowered (a raise comes only from a paid upgrade). */
  async syncYearly(subId, status, credits = null) {
    if (testDb) {
      await testDb.query('select public.credit_yearly_sync($1, $2, $3)', [subId, status, credits]);
      return;
    }
    unwrap(await admin().rpc('credit_yearly_sync', { p_sub: subId, p_status: status, p_credits: credits }));
  },

  /** A paid upgrade of a yearly plan: the cron grants the later months at the new level. */
  async raiseYearlyCredits(subId, plan, credits) {
    if (testDb) {
      await testDb.query('select public.credit_yearly_raise($1, $2, $3)', [subId, plan, credits]);
      return;
    }
    unwrap(await admin().rpc('credit_yearly_raise', { p_sub: subId, p_plan: plan, p_credits: credits }));
  },

  async getYearly(subId) {
    if (testDb) {
      const { rows } = await testDb.query('select * from public.credit_yearly_subs where sub_id = $1', [subId]);
      return rows[0] || null;
    }
    const data = unwrap(await admin().from('credit_yearly_subs').select('*').eq('sub_id', subId).limit(1));
    return data?.[0] || null;
  },

  /** A yearly period (credit_yearly_periods), recorded once when it starts. */
  async recordPeriod({ subId, end, start, customerId, invoiceId, month0Ref }) {
    const args = [subId, isoOf(end), isoOf(start), customerId, invoiceId, month0Ref];
    if (testDb) {
      await testDb.query('select public.credit_yearly_period_record($1, $2::timestamptz, $3::timestamptz, $4, $5, $6)', args);
      return;
    }
    unwrap(
      await admin().rpc('credit_yearly_period_record', {
        p_sub: subId, p_end: args[1], p_start: args[2], p_customer: customerId, p_invoice: invoiceId, p_month0_ref: month0Ref,
      })
    );
  },

  async endPeriod(subId, end, at) {
    if (testDb) {
      await testDb.query('select public.credit_yearly_period_end($1, $2::timestamptz, $3::timestamptz)', [subId, isoOf(end), isoOf(at)]);
      return;
    }
    unwrap(await admin().rpc('credit_yearly_period_end', { p_sub: subId, p_end: isoOf(end), p_at: isoOf(at) }));
  },

  async getPeriod(subId, end) {
    if (testDb) {
      const { rows } = await testDb.query(
        'select * from public.credit_yearly_periods where sub_id = $1 and period_end = $2::timestamptz',
        [subId, isoOf(end)]
      );
      return rows[0] || null;
    }
    const data = unwrap(
      await admin().from('credit_yearly_periods').select('*').eq('sub_id', subId).eq('period_end', isoOf(end)).limit(1)
    );
    return data?.[0] || null;
  },

  /** Yearly periods an invoice started. */
  async periodsStartedBy(invoiceId) {
    if (testDb) {
      const { rows } = await testDb.query('select * from public.credit_yearly_periods where invoice_id = $1', [invoiceId]);
      return rows;
    }
    return unwrap(await admin().from('credit_yearly_periods').select('*').eq('invoice_id', invoiceId).limit(10)) || [];
  },

  /** One priced invoice line (credit_plan_lines); a repeat is a no-op. */
  async recordLine({ key, invoiceId, subId, kind, periodEnd, amount, credits }) {
    const end = periodEnd == null ? null : isoOf(periodEnd);
    if (testDb) {
      await testDb.query('select public.credit_plan_line_record($1, $2, $3, $4, $5::timestamptz, $6, $7)', [
        key, invoiceId, subId, kind, end, amount, credits,
      ]);
      return;
    }
    unwrap(
      await admin().rpc('credit_plan_line_record', {
        p_key: key, p_invoice: invoiceId, p_sub: subId, p_kind: kind, p_period_end: end, p_amount: amount, p_credits: credits,
      })
    );
  },

  async invoiceLines(invoiceId) {
    if (testDb) {
      const { rows } = await testDb.query('select * from public.credit_plan_lines where invoice_id = $1', [invoiceId]);
      return rows;
    }
    return unwrap(await admin().from('credit_plan_lines').select('*').eq('invoice_id', invoiceId).limit(100)) || [];
  },

  /** The year lines of one yearly period: [{ invoice_id, credits }]. */
  async periodLines(subId, end) {
    if (testDb) {
      const { rows } = await testDb.query(
        `select invoice_id, credits from public.credit_plan_lines
          where sub_id = $1 and kind = 'year' and period_end = $2::timestamptz`,
        [subId, isoOf(end)]
      );
      return rows;
    }
    return unwrap(
      await admin()
        .from('credit_plan_lines')
        .select('invoice_id, credits')
        .eq('sub_id', subId)
        .eq('kind', 'year')
        .eq('period_end', isoOf(end))
        .limit(1000)
    ) || [];
  },

  /** credit_period_state: { granted, present, claws, ups }. */
  async periodState(userId, customerId, refs, prefix) {
    let r;
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_period_state($1, $2, $3::text[], $4) as r', [
        userId, customerId, refs, prefix,
      ]);
      r = rows[0].r;
    } else {
      r = unwrap(await admin().rpc('credit_period_state', { p_user: userId, p_customer: customerId, p_refs: refs, p_prefix: prefix }));
    }
    return { granted: Number(r.granted) || 0, present: r.present || [], claws: Number(r.claws) || 0, ups: Number(r.ups) || 0 };
  },

  /** credit_period_apply: { status: 'applied' | 'stale' | 'present', granted }. */
  async periodApply({ userId, customerId, refs, prefix, expect, kind, amount, reason, ref = null, cap = null }) {
    try {
      if (testDb) {
        const { rows } = await testDb.query(
          'select public.credit_period_apply($1, $2, $3::text[], $4, $5, $6, $7, $8, $9, $10) as r',
          [userId, customerId, refs, prefix, expect, kind, amount, reason, ref, cap]
        );
        return rows[0].r;
      }
      return unwrap(
        await admin().rpc('credit_period_apply', {
          p_user: userId, p_customer: customerId, p_refs: refs, p_prefix: prefix, p_expect: expect,
          p_kind: kind, p_amount: amount, p_reason: reason, p_ref: ref, p_cap: cap,
        })
      );
    } catch (err) {
      throw _mapError(err);
    }
  },

  /** credit_plan_clawback: a plan change's clawback; what it cannot take (spent) becomes plan_debt. */
  async planClawback({ userId, amount, reason, ref }) {
    try {
      if (testDb) {
        const { rows } = await testDb.query('select public.credit_plan_clawback($1, $2, $3, $4) as r', [userId, amount, reason, ref]);
        return rows[0].r;
      }
      return unwrap(await admin().rpc('credit_plan_clawback', { p_user: userId, p_amount: amount, p_reason: reason, p_ref: ref }));
    } catch (err) {
      throw _mapError(err);
    }
  },

  /** credit_collect_plan_debt: right after a plan grant, takes what the user owes from it (once per grant ref). */
  async collectDebt(userId, ref) {
    if (testDb) {
      const { rows } = await testDb.query('select public.credit_collect_plan_debt($1, $2) as n', [userId, ref]);
      return rows[0].n;
    }
    return unwrap(await admin().rpc('credit_collect_plan_debt', { p_user: userId, p_ref: ref }));
  },

  /** A customer's unclaimed plan grants, newest first. */
  async parkedPlanGrants(customerId) {
    if (testDb) {
      const { rows } = await testDb.query(
        `select reason, ref, amount, original_amount from public.credit_pending_grants
          where stripe_customer_id = $1 and claimed_by is null and bucket = 'plan'
            and reason in ($2, $3) order by id desc`,
        [customerId, REASON_RENEWAL, REASON_UPGRADE]
      );
      return rows;
    }
    return unwrap(
      await admin()
        .from('credit_pending_grants')
        .select('reason, ref, amount, original_amount')
        .eq('stripe_customer_id', customerId)
        .is('claimed_by', null)
        .eq('bucket', 'plan')
        .in('reason', [REASON_RENEWAL, REASON_UPGRADE])
        .order('id', { ascending: false })
        .limit(100)
    ) || [];
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
 * Credits a paid subscription invoice (billing_v2). Pass the invoice as
 * retrieved through the SDK (its fields follow the SDK's pinned API version,
 * not the webhook endpoint's). First, cycle and plan-change
 * (subscription_update) invoices are read line by line; legacy mode does
 * nothing here (plan credits roll over lazily in lib/entitlement.js).
 *
 * A period line (not a proration) is the plan's allotment: a monthly or
 * legacy price is renewed at once (renewPlanCredits, ref `invoice:<id>`, the
 * plan the invoice itself paid for); a yearly v2 price starts a yearly period
 * worth 12 months, released month by month (month 0 now).
 *
 * Plan changes are credited by MONEY: each proration line is worth its
 * amount at the rate of its own price (credits for one period / the price's
 * amount), floored for a charge and ceiled for a credit (unused time given
 * back). Monthly lines are netted per invoice and granted
 * (`upgrade:<invoice>`) or clawed back (`downgrade:<invoice>`) at once.
 * Yearly lines add to (or take from) the entitlement of the yearly period
 * they name; that period gives at most its entitlement and anything given
 * above it is clawed back at once (settlePeriod). Grants go before clawbacks
 * within one invoice, so a switch nets out even when the balance is low.
 * It does not matter how the invoice is paid (card or customer balance), or
 * whether it is paid at all (a negative total): money given back to the
 * balance was clawed when it was given, and the balance then pays like money.
 */
export async function grantForInvoice(invoice, { subscription } = {}) {
  const out = { granted: false, already: false, pending: false, skipped: null };
  if (!invoice?.subscription) return { ...out, skipped: 'no_subscription' };
  if (invoice.status !== 'paid') return { ...out, skipped: 'unpaid' };
  if (!PLAN_INVOICE_REASONS.has(invoice.billing_reason)) return { ...out, skipped: 'not_a_period' };
  const update = invoice.billing_reason === 'subscription_update';

  const sub = await subscriptionOf(invoice, subscription);
  const lines = await planLinesOf(invoice);
  let periodLines = lines.filter((l) => !l.proration);
  const prorations = lines.filter((l) => l.proration);
  if (!update && !periodLines.length) {
    // An invoice with no line of ours (an older shape): it pays a period of the subscription's price.
    const price = await invoicePrice(invoice, sub);
    const terms = price && planFromPrice(price) ? lineTerms(price) : null;
    if (terms) periodLines = [{ key: `${invoice.id}:period`, price, terms, proration: false, amount: Number(invoice.amount_paid) || 0, start: null, end: null }];
  }
  const all = [...periodLines, ...prorations];
  if (!all.length) return { ...out, skipped: update ? 'no_upgrade_line' : 'not_ours' };
  const plan = planFromPrice(all[0].price);
  const customerId = idOf(invoice.customer);
  if (!all.some((l) => isV2Price(l.price)) && !(await ledgerFor(customerId))) return { ...out, plan, skipped: 'legacy' };
  if (!update && sub?.status === 'trialing') return { ...out, plan, skipped: 'trialing' };
  if (!customerId) return { ...out, plan, skipped: 'no_customer' };

  const key = `invoice:${invoice.id}`;
  if (await store.has(`${key}:done`)) return { ...out, plan, already: true };
  const reversal = await store.getReversal(key);
  if (reversal && reversal.covered >= reversal.total) {
    // Refunded or disputed in full before it was credited: none of it counts.
    if (periodLines.some((l) => l.terms.kind === 'year')) await store.setYearlyStatus(sub.id, 'refunded');
    await store.record(`${key}:done`);
    return { ...out, plan, skipped: 'reversed' };
  }

  const result = { ...out, plan, amount: 0, currency: 'video' };
  const periods = new Map(); // period end (s) -> { delta, credit: true when a line gives time back, leftAt }
  const touch = (end, credits, l) => {
    const p = periods.get(end) || { delta: 0, charge: false, credit: false, leftAt: null };
    p.delta += credits;
    if (credits >= 0 || !l?.proration) p.charge = true;
    else {
      p.credit = true;
      const at = l.start || toSeconds(invoice.status_transitions?.paid_at || invoice.created || Date.now() / 1000);
      p.leftAt = p.leftAt == null ? at : Math.min(p.leftAt, at);
    }
    periods.set(end, p);
  };
  const yearRow = await store.getYearly(sub.id);

  // Period lines.
  let renewed = false;
  for (const l of periodLines) {
    if (l.terms.kind === 'month') {
      if (renewed) continue;
      renewed = true;
      const allotment = l.terms.monthly;
      const r = await grantOrPark({
        customerId, currency: 'video', amount: allotment, bucket: 'plan', reason: REASON_RENEWAL, ref: key,
        grant: async (uid) => {
          // A pending grant for this invoice (parked before the link) is claimed
          // instead, so the invoice never lands twice under two operations.
          if (await store.findPending(REASON_RENEWAL, key)) return claimPendingGrants(customerId, uid);
          return renewPlanCredits({ userId: uid, allotment, ref: key });
        },
      });
      Object.assign(result, r);
      if (r.userId) await store.collectDebt(r.userId, key);
      result.amount += allotment;
      continue;
    }
    const start = l.start || sub.current_period_start;
    const end = l.end || sub.current_period_end;
    await startPeriod({
      sub, customerId, plan: l.terms.info.plan, credits: l.terms.monthly, start, end, invoiceId: invoice.id,
      month0Ref: update ? yearlyStartRef(sub.id, new Date(start * 1000)) : key,
    });
    await store.recordLine({ key: l.key, invoiceId: invoice.id, subId: sub.id, kind: 'year', periodEnd: end, amount: l.amount, credits: l.terms.periodCredits });
    touch(end, l.terms.periodCredits, l);
  }

  // Proration lines, priced by money.
  let net = 0;
  let level = null; // the yearly price a same-period change moves to
  for (const l of prorations) {
    const credits = moneyCredits(l.terms, l.amount);
    if (l.terms.kind === 'month') {
      await store.recordLine({ key: l.key, invoiceId: invoice.id, subId: sub.id, kind: 'month', periodEnd: null, amount: l.amount, credits });
      net += credits;
      continue;
    }
    let end = l.end;
    if (!end) end = l.amount >= 0 ? sub.current_period_end : (yearRow ? toSeconds(yearRow.period_end) : null);
    if (!end) {
      console.warn('[grants] yearly proration line with no period to count toward', invoice.id, l.key);
      continue;
    }
    let period = await store.getPeriod(sub.id, end);
    if (!period && l.amount >= 0) {
      // A yearly period this charge starts (a switch billed as a proration line).
      const start = sub.current_period_end === end ? sub.current_period_start : toSeconds(addMonthsUtc(new Date(end * 1000), -12));
      await startPeriod({
        sub, customerId, plan: l.terms.info.plan, credits: l.terms.monthly, start, end, invoiceId: invoice.id,
        month0Ref: yearlyStartRef(sub.id, new Date(start * 1000)),
      });
      period = await store.getPeriod(sub.id, end);
    }
    if (!period) continue; // time given back on a yearly period this app never credited
    await store.recordLine({ key: l.key, invoiceId: invoice.id, subId: sub.id, kind: 'year', periodEnd: end, amount: l.amount, credits });
    touch(end, credits, l);
    if (l.amount > 0) level = { end, plan: l.terms.info.plan, credits: l.terms.monthly };
  }
  // A paid change of yearly price within the running period: the cron's monthly level follows it (raised or lowered;
  // what the period may give is bounded by its money either way).
  if (level && yearRow && toSeconds(yearRow.period_end) === level.end && yearRow.credits !== level.credits) {
    if (level.credits > yearRow.credits) await store.raiseYearlyCredits(sub.id, level.plan, level.credits);
    else await store.syncYearly(sub.id, yearRow.status, level.credits);
  }

  // Grants first, then clawbacks.
  const upgradeRef = `upgrade:${invoice.id}`;
  if (net > 0) {
    const r = await grantOrPark({
      customerId, currency: 'video', amount: net, bucket: 'plan', reason: REASON_UPGRADE, ref: upgradeRef,
      grant: async (uid) => {
        if (await store.findPending(REASON_UPGRADE, upgradeRef)) return claimPendingGrants(customerId, uid);
        return grantCredits({ userId: uid, currency: 'video', amount: net, bucket: 'plan', reason: REASON_UPGRADE, ref: upgradeRef });
      },
    });
    Object.assign(result, r);
    if (r.userId) await store.collectDebt(r.userId, upgradeRef);
    result.amount += net;
  }
  for (const [end, p] of periods) {
    if (p.delta < 0) continue;
    const r = await settlePeriod(sub.id, end, { firstOnly: true, invoiceId: invoice.id });
    result.amount += r.granted;
    if (r.pending) result.pending = true;
    else if (r.granted > 0) result.granted = true;
  }
  if (net < 0) {
    await takeBack({ customerId, amount: -net, reason: REASON_PLAN_CHANGE, ref: `downgrade:${invoice.id}` });
    result.amount += net;
  }
  for (const [end, p] of periods) {
    if (p.delta >= 0) continue;
    // Time given back with nothing new charged on that period: the subscription left it.
    if (p.credit && !p.charge) await leavePeriod(sub.id, end, p.leftAt);
    result.amount -= (await settlePeriod(sub.id, end, { firstOnly: true })).clawed;
  }

  // A refund or dispute that came first (partial): its share comes off now. Yearly periods read it themselves.
  if (renewed) await applyReversal({ ref: key, reason: REASON_RENEWAL, invoiceId: invoice.id });
  if (net > 0) {
    const rev = await store.getReversal(key);
    if (rev) {
      await reverseSource({
        source: { ref: upgradeRef, reason: REASON_UPGRADE }, covered: rev.covered, total: rev.total,
        reason: rev.reason, ref: `${upgradeRef}:${rev.reason}:${rev.covered}`,
      });
    }
  }
  await store.record(`${key}:done`);
  return result;
}

// ---------------------------------------------------------------- yearly v2

const REASON_UPGRADE = 'plan_upgrade';
const REASON_PLAN_CHANGE = 'plan_change';
const PLAN_INVOICE_REASONS = new Set(['subscription_create', 'subscription_cycle', 'subscription_update']);

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
 * Month 0 of a yearly period that did not start with its own first or cycle
 * invoice (a switch from monthly): keyed by the period start DATE and
 * distinct from the cron's yearly:<sub>:<YYYY-MM> refs, so yearly -> monthly
 * -> yearly in one calendar month never collides.
 */
export function yearlyStartRef(subId, start) {
  return `yearly:${subId}:${new Date(start).toISOString().slice(0, 10)}:m0`;
}

const toSeconds = (v) => (v instanceof Date ? Math.floor(v.getTime() / 1000) : typeof v === 'string' ? Math.floor(Date.parse(v) / 1000) : Math.floor(Number(v)));
const isoOf = (s) => new Date(toSeconds(s) * 1000).toISOString();

/** Refs of a yearly period's catch-up grants and clawbacks: period:<sub>:<period end s>:up|claw:<n>. */
const periodPrefix = (subId, end) => `period:${subId}:${toSeconds(end)}`;
/** The catch-up an invoice paid for: period:<sub>:<period end s>:up:<invoice>. */
const catchUpRef = (subId, end, invoiceId) => `${periodPrefix(subId, end)}:up:${invoiceId}`;

/** Records a yearly period that starts now (and makes it the subscription's current one for the cron). */
async function startPeriod({ sub, customerId, plan, credits, start, end, invoiceId, month0Ref }) {
  await store.recordYearly({
    sub: { id: sub.id, status: sub.status, current_period_start: start, current_period_end: end },
    customerId, plan, credits, invoiceId,
  });
  await store.recordPeriod({ subId: sub.id, end, start, customerId, invoiceId, month0Ref });
}

/** The subscription left a yearly period at `at` (no month starting later belongs to it). */
async function leavePeriod(subId, end, at) {
  await store.endPeriod(subId, end, at);
  const row = await store.getYearly(subId);
  if (row && toSeconds(row.period_end) === toSeconds(end)) await store.syncYearly(subId, 'switched');
}

/**
 * What a yearly period may give: the credits of its lines, less the refunded
 * or disputed share of each invoice's part (ceil), never below 0.
 */
async function entitledFor(subId, end) {
  const byInvoice = new Map();
  for (const l of await store.periodLines(subId, end)) {
    byInvoice.set(l.invoice_id, (byInvoice.get(l.invoice_id) || 0) + Number(l.credits));
  }
  let entitled = 0;
  for (const [invoiceId, n] of byInvoice) {
    entitled += n;
    if (!(n > 0)) continue;
    const rev = await store.getReversal(`invoice:${invoiceId}`);
    if (rev && rev.total > 0) entitled -= Math.min(n, Math.ceil((n * Math.min(rev.covered, rev.total)) / rev.total));
  }
  return Math.max(0, entitled);
}

/**
 * Brings a yearly period in line with its money, under a per-period lock in
 * SQL (credit_period_apply: applied only when the period still stands at the
 * total read here, otherwise re-read and retried):
 *   - given more than its entitlement (time given back, a refund, a dispute):
 *     the excess is clawed back now (ref period:<sub>:<end>:claw:<n>);
 *   - running (the subscription's current yearly period): each month that has
 *     started and is not granted yet gets the plan's monthly level, or less
 *     when the money left is short (spread over the months left), and every
 *     month is reserved the monthly level; what those months can never
 *     release (a paid upgrade's current month) is granted at once
 *     (period:<sub>:<end>:up:<n>). By the last month all of it is out.
 * `firstOnly` (an invoice): month 0 only; later months are the cron's.
 */
async function settlePeriod(subId, periodEnd, { now = new Date(), firstOnly = false, reason = REASON_PLAN_CHANGE, invoiceId = null } = {}) {
  const out = { granted: 0, clawed: 0, months: 0, pending: 0 };
  const p = await store.getPeriod(subId, periodEnd);
  if (!p) return out;
  const start = new Date(p.period_start);
  const end = new Date(p.period_end);
  const stop = p.ended_at ? new Date(p.ended_at) : end;
  const months = [];
  for (let k = 0; k < 12; k += 1) {
    const s = addMonthsUtc(start, k);
    if (s >= end || (k > 0 && s >= stop)) break;
    months.push({ k, start: s, ref: k === 0 ? p.month0_ref : yearlyRef(subId, s) });
  }
  const refs = months.map((m) => m.ref);
  const prefix = periodPrefix(subId, end);
  const customerId = p.customer_id;
  const linked = await linkedUser(customerId);
  const userId = linked.userId || null;
  if (userId) await claimPendingGrants(customerId, userId);
  const row = await store.getYearly(subId);
  const current = row && toSeconds(row.period_end) === toSeconds(end);
  const running = !p.ended_at && current && ['active', 'trialing', 'past_due'].includes(row.status);
  const level = current ? Number(row.credits) : 0;

  const apply = async (st, kind, amount, ref = null) => {
    if (userId) {
      return store.periodApply({
        userId, customerId, refs, prefix, expect: st.granted, kind, amount, reason, ref, cap: level || amount,
      });
    }
    // No linked user yet: parked like any purchase (claimed at link time).
    if (kind === 'claw') {
      await lowerParked(customerId, amount, { refs, prefix });
      return { status: 'applied' };
    }
    const r = kind === 'month' ? REASON_RENEWAL : REASON_UPGRADE;
    if (await store.findPending(r, ref || '')) return { status: 'present' };
    await store.insertPending({ customerId, currency: 'video', amount, bucket: 'plan', reason: r, ref: ref || `${prefix}:up:${st.ups + 1}` });
    out.pending += 1;
    return { status: 'applied' };
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const entitled = await entitledFor(subId, end);
    const st = await store.periodState(userId, customerId, refs, prefix);
    let given = st.granted;
    if (given > entitled) {
      const r = await apply(st, 'claw', given - entitled);
      if (r.status === 'stale') continue;
      out.clawed += given - entitled;
      return out;
    }
    if (!running || !(level > 0)) return out;
    const present = new Set(st.present);
    let stale = false;
    for (const m of months) {
      if (present.has(m.ref)) continue;
      if (m.start > now || (firstOnly && m.k > 0)) break;
      const after = months.length - 1 - m.k;
      const room = entitled - given;
      const amount = Math.min(room, Math.max(room - level * after, Math.min(level, Math.floor(room / (after + 1)))));
      if (!(amount > 0)) continue;
      const r = await apply({ ...st, granted: given }, 'month', amount, m.ref);
      if (r.status === 'stale') {
        stale = true;
        break;
      }
      present.add(m.ref);
      if (r.status === 'applied') {
        given += amount;
        out.granted += amount;
        out.months += 1;
      }
    }
    if (stale) continue;
    const reserved = level * months.filter((m) => !present.has(m.ref)).length;
    const catchUp = entitled - given - reserved;
    if (catchUp > 0) {
      // Keyed by the invoice that paid for it, so a refund of that invoice takes its share back at once.
      const r = await apply({ ...st, granted: given }, 'up', catchUp, invoiceId ? catchUpRef(subId, end, invoiceId) : null);
      if (r.status === 'stale') continue;
      if (r.status === 'applied') out.granted += catchUp;
    }
    return out;
  }
  throw new Error(`period_settle_contended:${prefix}`);
}

/**
 * The yearly cron (pages/api/cron/grant-yearly.js): for each running yearly
 * v2 subscription, grants each month that is due under ref
 * yearly:<subId>:<YYYY-MM> (idempotent: a repeat is a no-op), or parks it for
 * a customer with no linked user. A month is the plan's monthly level, never
 * more than the period's money still allows (settlePeriod). Bounded by
 * `limit` and `budgetMs`.
 *
 * Several months due at once (the cron was down, or the customer linked
 * late) are granted one after the other; the rollover rule keeps at most one
 * month's level of earlier plan credits: documented in docs/go-live.md.
 */
export async function grantYearlyMonths({ now = new Date(), limit = 200, budgetMs = 45_000 } = {}) {
  const started = Date.now();
  const summary = { subscriptions: 0, granted: 0, already: 0, pending: 0, failed: 0 };
  for (const row of await store.yearlyDue(limit)) {
    if (Date.now() - started > budgetMs) break;
    summary.subscriptions += 1;
    try {
      const r = await settlePeriod(row.sub_id, row.period_end, { now });
      summary.granted += r.months - r.pending;
      summary.pending += r.pending;
      await store.touchYearly(row.sub_id);
    } catch (err) {
      summary.failed += 1;
      console.error('[grants] yearly grant failed', row.sub_id, err.message);
    }
  }
  return summary;
}

/**
 * customer.subscription.updated / .deleted: keeps credit_yearly_subs in step
 * (status; credits only LOWERED, on a downgrade). Never grants and never
 * raises credits: that comes only from a paid invoice (grantForInvoice).
 * Never writes for a price that is not this app's.
 */
export async function syncSubscription(eventSub, previous = {}, { deleted = false } = {}) {
  const sub = await stripe().subscriptions.retrieve(eventSub.id, { expand: ['items.data.price'] });
  const price = sub?.items?.data?.[0]?.price;
  const info = planInfoFromPrice(price);
  const out = { yearly: null, upgrade: null };
  if (!info) return { ...out, skipped: 'not_ours' };
  if (deleted || !['active', 'trialing', 'past_due'].includes(sub.status)) {
    await store.syncYearly(sub.id, deleted ? 'canceled' : sub.status);
    return out;
  }
  if (info.version === 'v2' && info.interval === 'year') {
    await store.syncYearly(sub.id, sub.status, info.credits);
    out.yearly = sub.status;
  } else {
    await store.syncYearly(sub.id, 'switched');
  }
  return out;
}

// Invoice lines, read for both the pinned API shape (2024-06-20: line.proration, line.price as an object) and the
// newer one (line.parent.*_details.proration, line.pricing.price_details.price as an id).
const lineIsProration = (l) =>
  l?.proration === true ||
  l?.parent?.subscription_item_details?.proration === true ||
  l?.parent?.invoice_item_details?.proration === true;
async function linePrice(l) {
  if (l?.price && typeof l.price === 'object') return l.price;
  const id = typeof l?.price === 'string' ? l.price : l?.pricing?.price_details?.price;
  if (!id) return null;
  return stripe().prices.retrieve(typeof id === 'string' ? id : id.id);
}

/** The price an invoice pays for: its own non-proration line of this app's, else the subscription's price. */
async function invoicePrice(invoice, sub) {
  for (const line of invoice?.lines?.data || []) {
    if (lineIsProration(line)) continue;
    const p = await linePrice(line);
    if (p && planFromPrice(p)) return p;
  }
  return sub?.items?.data?.[0]?.price || null;
}

/**
 * How a plan price is credited: kind 'year' (a yearly v2 price: its period is
 * 12 months of credits, released monthly) or 'month' (a monthly v2 or legacy
 * price: one period's allotment at once); `periodCredits / cents` is its rate.
 */
function lineTerms(price) {
  const info = planInfoFromPrice(price);
  if (!info) return null;
  const monthly = v2AllotmentForPrice(price);
  const cents = Number(info.amountCents);
  if (!(monthly > 0) || !(cents > 0)) return null;
  const yearly = info.version === 'v2' && info.interval === 'year';
  return { kind: yearly ? 'year' : 'month', info, monthly, periodCredits: yearly ? monthly * 12 : monthly, cents };
}

/** A proration amount in credits at its price's rate: floor for a charge, -ceil for a credit. */
function moneyCredits(terms, amount) {
  return amount >= 0
    ? Math.floor((amount * terms.periodCredits) / terms.cents)
    : -Math.ceil((-amount * terms.periodCredits) / terms.cents);
}

/** The invoice's lines of this app's plan prices, with their terms. A line in another currency than its price is skipped. */
async function planLinesOf(invoice) {
  const out = [];
  const data = invoice?.lines?.data || [];
  for (let i = 0; i < data.length; i += 1) {
    const l = data[i];
    const price = await linePrice(l);
    if (!price || !planFromPrice(price)) continue;
    const terms = lineTerms(price);
    const amount = Number(l.amount);
    if (!terms || !Number.isFinite(amount)) continue;
    if (l.currency && price.currency && String(l.currency).toLowerCase() !== String(price.currency).toLowerCase()) {
      console.warn('[grants] plan line in another currency than its price, not credited', invoice.id, l.id || i);
      continue;
    }
    out.push({
      key: `${invoice.id}:${l.id || i}`, price, terms, proration: lineIsProration(l), amount: Math.round(amount),
      start: Number(l.period?.start) || null, end: Number(l.period?.end) || null,
    });
  }
  return out;
}

/**
 * A plan change's clawback, now, from the customer's linked user: what cannot be taken (already spent) is owed
 * (plan_debt) and taken from the next plan grants, since the money for that time went back to the customer's balance.
 * With no linked user, what is parked for them is lowered.
 */
async function takeBack({ customerId, amount, reason, ref }) {
  const linked = await linkedUser(customerId);
  if (linked.userId) {
    await claimPendingGrants(customerId, linked.userId);
    return store.planClawback({ userId: linked.userId, amount, reason, ref });
  }
  return lowerParked(customerId, amount);
}

/** Lowers the customer's unclaimed plan grants (newest first) by `amount`; with refs/prefix, only those. */
async function lowerParked(customerId, amount, { refs = null, prefix = null } = {}) {
  let left = amount;
  for (const row of await store.parkedPlanGrants(customerId)) {
    if (!(left > 0)) break;
    if (refs && !refs.includes(row.ref) && !(prefix && row.ref.startsWith(`${prefix}:`))) continue;
    const original = Number(row.original_amount || row.amount);
    const take = Math.min(left, Number(row.amount));
    if (!(take > 0)) continue;
    await store.lowerPending({ reason: row.reason, sourceRef: row.ref, covered: original - (Number(row.amount) - take), total: original });
    left -= take;
  }
  return { lowered: amount - left };
}

/**
 * A refund or dispute of an invoice credited line by line: `covered / total`
 * of each positive part comes off. The monthly renewal and the net monthly
 * change grant are reversed in proportion (cumulative per source); each yearly
 * period the invoice counted toward loses that share of the invoice's part of
 * its entitlement, and whatever it gave above that is clawed back at once
 * (settlePeriod reads the state, so a retry finishes an interrupted run). A
 * full refund or dispute of the invoice that started a yearly period stops it.
 */
async function reverseInvoice({ invoiceId, covered, total, reason, suffix }) {
  const sourceRef = `invoice:${invoiceId}`;
  await store.recordReversal({ sourceRef, covered, total, reason, ref: `${sourceRef}:${suffix}` });
  let amount = 0;
  const started = await store.periodsStartedBy(invoiceId);
  if (!started.some((p) => p.month0_ref === sourceRef)) {
    const r = await reverseSource({ source: { ref: sourceRef, reason: REASON_RENEWAL }, covered, total, reason, ref: `${sourceRef}:${suffix}` });
    amount += Number(r.amount) || 0;
  }
  const up = `upgrade:${invoiceId}`;
  const r = await reverseSource({ source: { ref: up, reason: REASON_UPGRADE }, covered, total, reason, ref: `${up}:${suffix}` });
  amount += Number(r.amount) || 0;
  const touched = new Map();
  for (const l of await store.invoiceLines(invoiceId)) {
    if (l.kind === 'year') touched.set(`${l.sub_id}|${toSeconds(l.period_end)}`, { subId: l.sub_id, end: toSeconds(l.period_end) });
  }
  for (const { subId, end } of touched.values()) {
    // The month's step this invoice paid for (its catch-up) loses its share at once, like a monthly upgrade; then the
    // period gives back whatever it holds above its lowered money.
    const upRef = catchUpRef(subId, end, invoiceId);
    const c = await reverseSource({ source: { ref: upRef, reason: REASON_UPGRADE }, covered, total, reason, ref: `${upRef}:${suffix}` });
    amount += Number(c.amount) || 0;
    amount += (await settlePeriod(subId, end, { reason })).clawed;
  }
  if (covered >= total) {
    for (const p of started) {
      const row = await store.getYearly(p.sub_id);
      if (row && toSeconds(row.period_end) === toSeconds(p.period_end)) await store.setYearlyStatus(p.sub_id, 'refunded');
    }
  }
  return { amount, ref: `${sourceRef}:${suffix}` };
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
  return v2AllotmentForPrice(await invoicePrice(invoice, sub));
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
  const suffix = dispute ? `dispute:${dispute.id}` : `refund:${covered}`;
  let total = ch.amount;
  if (source.invoiceId) {
    // The share is of what the invoice cost: a part paid from the customer balance does not show on the charge.
    const invoice = await stripe().invoices.retrieve(source.invoiceId);
    total = Math.max(ch.amount, Math.round(Number(invoice?.total)) || 0);
    // An invoice credited line by line (a yearly period, a plan change): one reconcile for all it paid for.
    const credited = (await store.invoiceLines(source.invoiceId)).length > 0
      || (await store.periodsStartedBy(source.invoiceId)).length > 0;
    if (credited) return reverseInvoice({ invoiceId: source.invoiceId, covered, total, reason, suffix });
  }
  const ref = `${source.ref}:${suffix}`;
  const args = { source, covered, total, reason, ref };

  const result = await reverseSource(args);
  if (!result.noGrant) return result;

  // Nothing granted yet. Only this app's purchases get a tombstone.
  if (!(await originalGrantAmount(source))) return { skipped: 'not_ours' };
  await store.recordReversal({ sourceRef: source.ref, covered, total, reason, ref });
  // The grant may have landed while we wrote the tombstone.
  const after = await reverseSource(args);
  return after.noGrant ? { tombstone: true, ref } : after;
}
