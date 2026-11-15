import {
  callCreditFunction,
  callCreditRows,
  settleHold,
  releaseHold,
  HoldClosedError,
  InsufficientCreditsError,
  RefConflictError,
} from './credits.js';
import { getKiePrediction, normalizeKieStatus } from './kie.js';
import { getSupabaseAdmin } from './supabaseServer.js';

/*
 * Server-side record of every billing_v2 hold taken by an old tool
 * (credit_legacy_holds, 20261114000600_credit_legacy_tools.sql), so no hold
 * depends on a request finishing or a client polling:
 *
 *   reserving      recorded BEFORE the ledger hold is taken (the hold may not
 *                  exist yet: a crash in between leaves a record, never an
 *                  unrecorded hold)
 *   open           held; `provider` + `job_id` name the job once the
 *                  provider accepted it
 *   settle_retry   the job succeeded but spending the hold failed
 *   release_retry  the job failed but releasing the hold failed
 *   settled / released   done
 *
 * The reconciler (reconcileLegacyHolds, run by /api/cron/legacy-holds) ends
 * what requests could not. It only READS provider status; it never submits.
 * Every look that does not end a row counts an attempt and moves the row to
 * the back of the queue, so a row whose status read keeps failing cannot
 * starve the others; the age caps apply whether or not the read worked.
 */

export const LEGACY_TOOL_REASON = 'legacy_tool';

// After how long a hold is looked at, and when it is given up.
const RULES = {
  reservingAfterMin: 5, // a request takes a hold within seconds of recording it
  unsubmittedAfterMin: 15, // no job id: the request died before or while submitting
  kieCapMin: 24 * 60, // a kie video job still not finished (or unreadable) after a day
  kieImageCapMin: 30, // glow-up / interior-design: the request polls kie itself
  renderCapMin: 60, // pages/api/video/render.js runs inside one function call
};
// Work per cron run: stays well inside the route's 60 s maxDuration.
const RUN_BUDGET_MS = 40_000;

export const jobRef = (route, jobId) => `legacy:${route}:${jobId}`;

/**
 * Records a hold. `status` 'reserving' is the intent recorded before the
 * ledger hold is taken (lib/entitlementV2.js reserveV2). Throws when it
 * cannot be recorded.
 */
export async function recordHold({ holdId, userId, currency, amount, route, status = 'open' }) {
  await callCreditFunction('credit_legacy_hold_open', {
    p_hold: holdId, p_user: userId, p_currency: currency, p_amount: amount, p_route: route, p_status: status,
  });
}

/** The ledger hold was taken: the record moves from 'reserving' to 'open'. */
export async function markHeld(holdId) {
  await mark(holdId, 'open');
}

/** The ledger hold was never taken (insufficient credits): drop the 'reserving' record. */
export async function forgetReservation(holdId) {
  await callCreditFunction('credit_legacy_hold_forget', { p_hold: holdId });
}

/** Names the provider job a hold pays for. Never throws (the job is already running). */
export async function attachJob(holdId, { provider, jobId }) {
  try {
    await callCreditFunction('credit_legacy_hold_attach', { p_hold: holdId, p_provider: provider, p_job: String(jobId) });
    return true;
  } catch (err) {
    console.error('[legacyHolds] could not record the job of hold', holdId, provider, jobId, err.message);
    return false;
  }
}

async function mark(holdId, status, error = null) {
  await callCreditFunction('credit_legacy_hold_mark', { p_hold: holdId, p_status: status, p_error: error });
}

async function touch(holdId, error = null) {
  await callCreditFunction('credit_legacy_hold_touch', { p_hold: holdId, p_error: error ? String(error).slice(0, 500) : null });
}

// A successful job whose hold was closed some other way (for example the
// reconciler gave up on it before the client polled): charge it directly
// with the job's ref. A ref already used by the settle means it was charged;
// too few credits now means it is not collected (logged).
async function chargeClosedHold(hold, jobId) {
  // Settled earlier under any ref (for example the route's job ref, when the
  // reconciler only knows the hold id): already charged.
  if (await callCreditFunction('credit_hold_charged', { p_hold: hold.holdId })) return 'settled';
  if (!hold.userId) return 'closed';
  try {
    // A spend whose ledger row names the hold (credit_charge_closed_hold),
    // so credit_hold_charged sees it under any later ref.
    await callCreditFunction('credit_charge_closed_hold', {
      p_hold: hold.holdId,
      p_user: hold.userId,
      p_currency: hold.currency || 'video',
      p_amount: hold.amount,
      p_reason: LEGACY_TOOL_REASON,
      p_ref: jobRef(hold.route, jobId),
    });
    console.warn('[legacyHolds] charged a successful job whose hold had closed', hold.holdId, jobId);
    return 'settled';
  } catch (err) {
    if (err instanceof RefConflictError) return 'settled'; // the settle already charged it
    if (err instanceof InsufficientCreditsError) {
      console.error('[legacyHolds] could not charge a successful job (not enough credits)', hold.holdId, jobId);
      return 'closed';
    }
    throw err;
  }
}

/**
 * Ends a hold: spends it (ref legacy:<route>:<jobId>, idempotent) or releases
 * the rest (idempotent), and records the outcome. When the ledger call fails
 * the row is marked for retry by the reconciler; `throwOnRetry` decides
 * whether the caller still sees the error (the reconciler does; routes do
 * not). Pass `hold.userId` (and `hold.currency`) so a success on a hold that
 * was already closed can still be charged.
 */
export async function endHold({ hold, jobId, failed, throwOnRetry = false }) {
  try {
    if (failed) {
      await releaseHold({ holdId: hold.holdId });
    } else {
      await settleHold({
        holdId: hold.holdId,
        amount: hold.amount,
        reason: LEGACY_TOOL_REASON,
        ref: jobRef(hold.route, jobId),
      });
    }
  } catch (err) {
    if (!failed && err instanceof RefConflictError && err.detail?.existing_op === 'spend') {
      // The job's ref was already charged directly (chargeClosedHold): it is
      // paid; free what this hold still holds. Any other conflict (another
      // hold settled this ref, or a settle of another amount) is not taken as
      // paid: it goes to retry below.
      await releaseHold({ holdId: hold.holdId }).catch((e) => {
        if (!(e instanceof HoldClosedError)) throw e;
      });
      await mark(hold.holdId, 'settled', 'charged earlier under the job ref').catch(() => {});
      return 'settled';
    }
    if (err instanceof HoldClosedError) {
      const outcome = failed ? 'closed' : await chargeClosedHold(hold, jobId);
      if (outcome === 'closed') console.warn('[legacyHolds] hold already closed', hold.holdId, jobId);
      await mark(hold.holdId, failed ? 'released' : 'settled', 'closed earlier').catch(() => {});
      return outcome;
    }
    console.error('[legacyHolds] could not end hold; recorded for retry', hold.holdId, err.message);
    // If even the record cannot be written, the error reaches the caller.
    await mark(hold.holdId, failed ? 'release_retry' : 'settle_retry', String(err.message || err).slice(0, 500));
    if (throwOnRetry) throw err;
    return 'retry';
  }
  await mark(hold.holdId, failed ? 'released' : 'settled').catch((e) =>
    console.warn('[legacyHolds] could not record the outcome of hold', hold.holdId, e.message)
  );
  return failed ? 'released' : 'settled';
}

const ageMinutes = (row, now) => (now - new Date(row.created_at).getTime()) / 60_000;

async function renderOutcome(renderId) {
  const { data, error } = await getSupabaseAdmin()
    .from('video_renders')
    .select('status')
    .eq('render_id', renderId)
    .maybeSingle();
  if (error) throw error;
  return data?.status || null;
}

// Reads a provider status; a read that throws is "unknown" (and noted).
async function readOr(row, read) {
  try {
    return { value: await read(), error: null };
  } catch (err) {
    return { value: null, error: err };
  }
}

// What to do with one due row: { action: 'settle' | 'release' | 'forget' | null, jobId, note }.
async function decide(row, now, deps) {
  const age = ageMinutes(row, now);
  if (row.status === 'settle_retry') {
    // The job succeeded; with no job id recorded, the hold itself names it.
    return { action: 'settle', jobId: row.job_id || row.hold_id };
  }
  if (row.status === 'release_retry') return { action: 'release', jobId: row.job_id };
  if (row.status === 'reserving' && !row.job_id) {
    if (age < RULES.reservingAfterMin) return { action: null };
    const state = await callCreditFunction('credit_legacy_hold_ledger_state', { p_hold: row.hold_id });
    if (state === 'none') return { action: 'forget' };
    if (state === 'closed') return { action: 'release' }; // nothing left to release; just records it
    return { action: 'release' };
  }
  if (!row.job_id) return { action: age >= RULES.unsubmittedAfterMin ? 'release' : null };
  switch (row.provider) {
    case 'replicate':
      // The sync routes charge once the provider accepted the job.
      return { action: 'settle', jobId: row.job_id };
    case 'kie': {
      // Past the cap there is nothing to wait for: no read (a hanging read
      // cannot stall the run).
      if (age >= RULES.kieCapMin) return { action: 'release', jobId: row.job_id };
      const { value, error } = await readOr(row, () => deps.getKie(row.job_id));
      if (!error) {
        const { status } = normalizeKieStatus(value);
        if (status === 'complete') return { action: 'settle', jobId: row.job_id };
        if (status === 'error') return { action: 'release', jobId: row.job_id };
      }
      return { action: null, jobId: row.job_id, note: error?.message };
    }
    case 'kie-image':
      return { action: age >= RULES.kieImageCapMin ? 'release' : null, jobId: row.job_id };
    case 'render': {
      const { value, error } = await readOr(row, () => deps.renderStatus(row.job_id));
      if (value === 'completed') return { action: 'settle', jobId: row.job_id };
      if (value === 'failed') return { action: 'release', jobId: row.job_id };
      return { action: age >= RULES.renderCapMin ? 'release' : null, jobId: row.job_id, note: error?.message };
    }
    default:
      return { action: age >= RULES.kieCapMin ? 'release' : null, jobId: row.job_id };
  }
}

/**
 * Ends due holds (older than `olderThanMinutes`), least recently looked at
 * first. Returns counts; one row's failure never stops the others, and the
 * run stops taking new rows after RUN_BUDGET_MS.
 */
export async function reconcileLegacyHolds({
  olderThanMinutes = 10,
  limit = 100,
  now = Date.now(),
  getKie = getKiePrediction,
  renderStatus = renderOutcome,
  budgetMs = RUN_BUDGET_MS,
} = {}) {
  const started = Date.now();
  const rows = await callCreditRows('credit_legacy_holds_due', { p_older_than_minutes: olderThanMinutes, p_limit: limit });
  const summary = { looked: 0, settled: 0, released: 0, forgotten: 0, waiting: 0, failed: 0 };
  for (const row of rows) {
    if (Date.now() - started > budgetMs) break;
    summary.looked += 1;
    try {
      const { action, jobId, note } = await decide(row, now, { getKie, renderStatus });
      if (!action) {
        summary.waiting += 1;
        await touch(row.hold_id, note);
        continue;
      }
      if (action === 'forget') {
        await forgetReservation(row.hold_id);
        summary.forgotten += 1;
        continue;
      }
      const hold = { holdId: row.hold_id, amount: row.amount, route: row.route, userId: String(row.user_id), currency: row.currency };
      const outcome = await endHold({ hold, jobId, failed: action === 'release', throwOnRetry: true });
      if (action === 'settle' && outcome === 'settled') summary.settled += 1;
      else summary.released += 1;
    } catch (err) {
      summary.failed += 1;
      console.error('[legacyHolds] reconcile failed for hold', row.hold_id, err.message);
      await touch(row.hold_id, err.message).catch(() => {});
    }
  }
  return summary;
}
