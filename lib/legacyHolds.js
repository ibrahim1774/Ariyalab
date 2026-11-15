import {
  callCreditFunction,
  callCreditRows,
  settleHold,
  releaseHold,
  HoldClosedError,
} from './credits.js';
import { getKiePrediction, normalizeKieStatus } from './kie.js';
import { getSupabaseAdmin } from './supabaseServer.js';

/*
 * Server-side record of every billing_v2 hold taken by an old tool
 * (credit_legacy_holds, 20261114000600_credit_legacy_tools.sql), so no hold
 * depends on a request finishing or a client polling:
 *
 *   open           the hold exists; `provider` + `job_id` name the job once the
 *                  provider accepted it
 *   settle_retry   the job succeeded but spending the hold failed
 *   release_retry  the job failed but releasing the hold failed
 *   settled / released   done
 *
 * The reconciler (reconcileLegacyHolds, run by /api/cron/legacy-holds) ends
 * what requests could not. It only READS provider status; it never submits.
 */

export const LEGACY_TOOL_REASON = 'legacy_tool';

// After how long an open hold is looked at, and when it is given up.
const RULES = {
  unsubmittedAfterMin: 15, // no job id: the request died before or while submitting
  kieCapMin: 24 * 60, // a kie video job still not finished after a day
  kieImageCapMin: 30, // glow-up / interior-design: the request polls kie itself
  renderCapMin: 60, // pages/api/video/render.js runs inside one function call
};

export const jobRef = (route, jobId) => `legacy:${route}:${jobId}`;

/** Records a new hold. Throws when it cannot be recorded (the caller releases the hold). */
export async function recordHold({ holdId, userId, currency, amount, route }) {
  await callCreditFunction('credit_legacy_hold_open', {
    p_hold: holdId, p_user: userId, p_currency: currency, p_amount: amount, p_route: route,
  });
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

/**
 * Ends a hold: spends it (ref legacy:<route>:<jobId>, idempotent) or releases
 * the rest (idempotent), and records the outcome. A hold already closed the
 * other way is left as it is. When the ledger call fails the row is marked
 * for retry by the reconciler; `throwOnRetry` decides whether the caller
 * still sees the error (the reconciler does; routes do not).
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
    if (err instanceof HoldClosedError) {
      console.warn('[legacyHolds] hold already closed', hold.holdId, jobId);
      await mark(hold.holdId, failed ? 'released' : 'settled', 'closed earlier').catch(() => {});
      return 'closed';
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

// What to do with one due row: 'settle', 'release' or null (look again later).
async function decide(row, now, deps) {
  if (row.status === 'settle_retry') return row.job_id ? 'settle' : 'release';
  if (row.status === 'release_retry') return 'release';
  const age = ageMinutes(row, now);
  if (!row.job_id) return age >= RULES.unsubmittedAfterMin ? 'release' : null;
  switch (row.provider) {
    case 'replicate':
      // The sync routes charge once the provider accepted the job.
      return 'settle';
    case 'kie': {
      const { status } = normalizeKieStatus(await deps.getKie(row.job_id));
      if (status === 'complete') return 'settle';
      if (status === 'error') return 'release';
      return age >= RULES.kieCapMin ? 'release' : null;
    }
    case 'kie-image':
      return age >= RULES.kieImageCapMin ? 'release' : null;
    case 'render': {
      const outcome = await deps.renderStatus(row.job_id);
      if (outcome === 'completed') return 'settle';
      if (outcome === 'failed') return 'release';
      return age >= RULES.renderCapMin ? 'release' : null;
    }
    default:
      return age >= RULES.kieCapMin ? 'release' : null;
  }
}

/**
 * Ends due holds (older than `olderThanMinutes`). Returns counts; one row's
 * failure never stops the others.
 */
export async function reconcileLegacyHolds({
  olderThanMinutes = 10,
  limit = 100,
  now = Date.now(),
  getKie = getKiePrediction,
  renderStatus = renderOutcome,
} = {}) {
  const rows = await callCreditRows('credit_legacy_holds_due', { p_older_than_minutes: olderThanMinutes, p_limit: limit });
  const summary = { looked: rows.length, settled: 0, released: 0, waiting: 0, failed: 0 };
  for (const row of rows) {
    try {
      const action = await decide(row, now, { getKie, renderStatus });
      if (!action) {
        summary.waiting += 1;
        continue;
      }
      const hold = { holdId: row.hold_id, amount: row.amount, route: row.route, provider: row.provider };
      const outcome = await endHold({ hold, jobId: row.job_id, failed: action === 'release', throwOnRetry: true });
      if (outcome === 'settled' || (outcome === 'closed' && action === 'settle')) summary.settled += 1;
      else summary.released += 1;
    } catch (err) {
      summary.failed += 1;
      console.error('[legacyHolds] reconcile failed for hold', row.hold_id, err.message);
    }
  }
  return summary;
}
