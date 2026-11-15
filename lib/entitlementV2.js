import { randomUUID } from 'node:crypto';
import { stripe, CAPS, planFromPrice } from './stripe';
import { KEY } from './metaKeys';
import {
  InsufficientCreditsError,
  getBalance,
  holdCredits,
  spendCredits,
  grantCredits,
  RefConflictError,
  callCreditFunction,
} from './credits';
import { legacyCreditsToV2 } from './cost';
import { recordHold, markHeld, forgetReservation, attachJob, endHold, LEGACY_TOOL_REASON } from './legacyHolds';

/*
 * billing_v2 adapter for the old tools (lib/entitlement.js dispatches here
 * when the entitlement says billing 'v2'). Balances come from the ledger;
 * nothing is written to Stripe.
 *
 * One paid job = one hold (project null, generated holdId), recorded in
 * credit_legacy_holds (lib/legacyHolds.js) before the job starts, spent with
 * ref `legacy:<route>:<job id>` when the job succeeds and released when it
 * fails. A request that cannot end its hold leaves the record for the
 * reconciler (/api/cron/legacy-holds). The hold lives on the per-request
 * entitlement object; a route reserves once.
 */

export const PAID_TIERS = new Set(['monthly', 'pro', 'yearly']);

/** True when this entitlement charges through the ledger (lib/credits.js). */
export function usesLedger(entitlement) {
  return entitlement?.billing === 'v2';
}

/** The user's Stripe customer from their own profile row (the session client), or null. */
export async function profileCustomerId(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[entitlement] profile lookup error', error.message);
    return null;
  }
  return data?.stripe_customer_id || null;
}

/** The active or trialing subscription of ours and its plan, read only. { sub: null } when none. */
async function readPlanReadOnly(customerId) {
  for (const status of ['active', 'trialing']) {
    const list = await stripe().subscriptions.list({
      customer: customerId,
      status,
      limit: 10,
      expand: ['data.items.data.price'],
    });
    // The customer may also subscribe to haelabs.live: only our prices count.
    for (const sub of list.data || []) {
      const plan = planFromPrice(sub.items?.data?.[0]?.price);
      if (plan) return { sub, plan };
    }
  }
  return { sub: null, plan: null };
}

export async function getEntitlementV2(supabase, userId) {
  const balance = await getBalance(userId, 'video');
  const customerId = await profileCustomerId(supabase, userId);
  let plan = null;
  let sub = null;
  if (customerId) {
    try {
      ({ plan, sub } = await readPlanReadOnly(customerId));
    } catch (err) {
      console.warn('[entitlement] Stripe lookup failed', err.message);
    }
  }
  const available = Number(balance?.available || 0);
  const videoCap = plan ? legacyCreditsToV2(CAPS[plan]) : 0;
  return {
    billing: 'v2',
    userId,
    tier: plan || 'none',
    status: sub?.status || 'none',
    creditsRemaining: available,
    videoCap,
    videosUsed: Math.max(0, videoCap - available),
    canSwap: available > 0,
    customerId,
    balance,
  };
}

export function insufficient(err) {
  err.code = 'INSUFFICIENT';
  err.remaining = Number(err.available || 0);
  return err;
}

/**
 * Holds `amount` for one job of `route`. The intent is recorded FIRST
 * ('reserving', with the pre-generated hold id), then the ledger hold is
 * taken, then the record says 'open'. A crash anywhere leaves a record the
 * reconciler can end (lib/legacyHolds.js); a record that cannot be written
 * means nothing is held and the error is thrown (the job must not start).
 */
export async function reserveV2(entitlement, amount, route, currency = 'video') {
  if (!entitlement.userId) {
    const err = new Error('No active plan.');
    err.code = 'NO_PLAN';
    throw err;
  }
  const holdId = randomUUID();
  const hold = { holdId, amount, route: route || 'tool', currency, userId: entitlement.userId };
  await recordHold({ holdId, userId: entitlement.userId, currency, amount, route: hold.route, status: 'reserving' });
  try {
    await holdCredits({ userId: entitlement.userId, currency, amount, projectId: null, holdId });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      await forgetReservation(holdId).catch((e) => console.warn('[entitlement] could not drop reservation', holdId, e.message));
      throw insufficient(err);
    }
    // Any other error: the hold may have been taken with only the answer
    // lost. The 'reserving' record stays; the reconciler decides by the
    // ledger state (release it, or drop the record when there is no hold).
    throw err;
  }
  try {
    await markHeld(holdId);
  } catch (err) {
    // The hold stands; the 'reserving' record still lets the reconciler end it.
    console.warn('[entitlement] could not mark hold as held', holdId, err.message);
  }
  entitlement.hold = hold;
  return amount;
}

/**
 * Names the provider job this request's hold pays for (`provider`: 'kie',
 * 'replicate', 'kie-image' or 'render'), so the reconciler can end the hold
 * if nobody else does. No-op on the legacy path and for admins.
 */
export async function attachReservation(entitlement, { provider, jobId }) {
  if (!usesLedger(entitlement) || !entitlement.hold) return;
  entitlement.hold.provider = provider;
  entitlement.hold.jobId = jobId;
  await attachJob(entitlement.hold.holdId, { provider, jobId });
}

/**
 * The hold this request reserved, for the job id (lib/jobToken.js signJobId)
 * of an async job that /api/status settles later. null on the legacy path and
 * for admins. Taking it hands the hold over: settleReservation and
 * refundCredits on this entitlement no longer touch it.
 */
export function takeHoldForJob(entitlement) {
  if (!usesLedger(entitlement) || !entitlement.hold) return null;
  const { holdId, amount, route } = entitlement.hold;
  entitlement.hold = null;
  return { holdId, amount, route };
}

/**
 * Sync jobs (the provider accepted the work): spend the reserved hold now,
 * before answering. A ledger failure is recorded for the reconciler (the
 * hold row says settle_retry) instead of being swallowed; only a failure to
 * record that throws. No-op on the legacy path and for admins.
 */
export async function settleReservation(entitlement, jobId) {
  if (!usesLedger(entitlement) || !entitlement.hold) return null;
  const hold = entitlement.hold;
  entitlement.hold = null;
  return endHold({ hold, jobId, failed: false });
}

/** Ends a job's hold (status route): see lib/legacyHolds.js endHold. */
export async function settleHeldJob({ hold, jobId, failed }) {
  return endHold({ hold, jobId, failed });
}

/** Releases this request's hold (a failed job). A failed release is recorded for retry. */
export async function refundV2(entitlement) {
  if (!entitlement.hold) return;
  const hold = entitlement.hold;
  entitlement.hold = null;
  await endHold({ hold, jobId: hold.jobId || null, failed: true });
}

export async function decrementV2(entitlement, amount, ref) {
  if (typeof ref !== 'string' || !ref) throw new TypeError('decrementCredits needs a ref under billing_v2');
  try {
    await spendCredits({
      userId: entitlement.userId,
      currency: 'video',
      amount: Math.max(1, amount),
      reason: LEGACY_TOOL_REASON,
      ref,
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) throw insufficient(err);
    throw err;
  }
}

/**
 * A job charged on the LEGACY path (its job id carries no hold) that fails
 * after billing_v2 was turned on: its cost (read, never written, from the
 * customer's legacy pendingJobs record) comes back as v2 top-up credits,
 * once (ref legacy-refund:<job id>). Returns the credits refunded.
 */
export async function refundLegacyJobInLedger(entitlement, predictionId) {
  if (!entitlement?.userId || !entitlement.customerId || !predictionId) return 0;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const entry = String(md[KEY.pendingJobs] || '')
    .split(',')
    .map((e) => e.split(':'))
    .find(([id]) => id === predictionId);
  const cost = entry ? parseInt(entry[1], 10) || 0 : 0;
  if (cost <= 0) return 0;
  const amount = legacyCreditsToV2(cost);
  try {
    await grantCredits({
      userId: entitlement.userId,
      currency: 'video',
      amount,
      bucket: 'topup',
      reason: 'legacy_job_refund',
      ref: `legacy-refund:${predictionId}`,
    });
  } catch (err) {
    if (!(err instanceof RefConflictError)) throw err;
    return 0;
  }
  return amount;
}

// ---------------------------------------------------------------- swap uses

/**
 * { swapId, count, stale } for this frame from the database, or null. `stale`:
 * a claim taken more than 2 minutes ago whose job id was never recorded (its
 * job did not start, or the record failed): it counts as a failed attempt.
 */
export async function getSwapUseV2(entitlement, frameId) {
  const r = await callCreditFunction('credit_swap_use', { p_user: entitlement.userId, p_frame: frameId });
  return r ? { swapId: r.swap_id || null, count: Number(r.count), stale: Boolean(r.stale) } : null;
}

/** Undoes claim `count` when its job did not start (only while no job id is recorded). */
export async function unclaimSwapUseV2(entitlement, frameId, count) {
  await callCreditFunction('credit_unclaim_swap_use', { p_user: entitlement.userId, p_frame: frameId, p_count: count });
}

/** Takes use `expected + 1` (compare-and-set). The new count, or null when taken or used up. Throws when unreadable. */
export async function claimSwapUseV2(entitlement, frameId, expected, max) {
  const r = await callCreditFunction('credit_claim_swap_use', {
    p_user: entitlement.userId, p_frame: frameId, p_expected: expected, p_max: max,
  });
  return r == null ? null : Number(r);
}

export async function recordSwapUseV2(entitlement, frameId, swapId, count) {
  await callCreditFunction('credit_record_swap', {
    p_user: entitlement.userId, p_frame: frameId, p_swap: swapId, p_count: count,
  });
}

// ---------------------------------------------------------------- migrated customers

/** Thrown on the legacy spend path for a customer whose credits were migrated. */
export class MigratedToV2Error extends Error {
  constructor() {
    super('Your credits moved to the new system. Refresh the page; if this persists, contact support.');
    this.name = 'MigratedToV2Error';
    this.code = 'MIGRATED';
  }
}

/**
 * Refuses the legacy spend path once scripts/migrate-legacy-credits.mjs moved
 * this customer (credit_legacy_migrations): turning billing_v2 off again must
 * not let one balance be spent in both systems. Fails closed.
 */
export async function assertNotMigrated(customerId) {
  if (!customerId) return;
  if (await callCreditFunction('credit_legacy_migrated', { p_customer: customerId })) throw new MigratedToV2Error();
}
