import { listStaleHolds } from '../credits.js';
import { storyDb } from './db.js';

/*
 * Stale story-hold sweeper (Task 27): the backstop for credit holds of story
 * projects that no request, job or stall recovery will end. Run by
 * /api/cron/story-holds every 10 minutes.
 *
 * For each active hold older than `olderThanMinutes` (at least 30: far past
 * STALE_CLAIM_MS, the 2-minute delete window and any job lease) that belongs
 * to a project:
 *   1. the project's own stall recoveries run first (stills, clips, audio):
 *      a start whose request died is undone the normal way (shots put back,
 *      counters un-counted, the part of the hold no job carries given back);
 *   2. story_release_orphan_hold then releases, under the account and hold
 *      locks, whatever is still left when nothing can settle or release it
 *      any more (no queued/running job, no finished job with its share
 *      unapplied, no open claim or cast round, not an old-tools or voice hold).
 *
 * Stalled cast rounds are reset by the cast's own recovery first
 * (recoverStalledCast), which gives their unused hold back.
 *
 * Cases this ends (by name): a cast path-A reset that lost its compare and
 * set (a full hold with no jobs and no row pointing at it); releaseUnowned
 * giving back too little; a request killed between its last clip enqueue and
 * the fee settle (the fee part of the hold, after the claim's recovery); the
 * brief over-hold left by releaseClaim / settleLostClaim. Never a hold whose
 * job could still settle. A repeat run is harmless.
 */

export const MIN_AGE_MINUTES = 30;
const RUN_BUDGET_MS = 40_000;

async function defaultRecover(projectId) {
  const [{ recoverStalledStills }, { recoverStalledClips }, { recoverStalledAudio }, { recoverStalledCast }] = await Promise.all([
    import('./storyboard.js'),
    import('./shots.js'),
    import('./audio.js'),
    import('./cast.js'),
  ]);
  await recoverStalledStills(projectId);
  await recoverStalledClips(projectId);
  await recoverStalledAudio(projectId);
  await recoverStalledCast(projectId);
}

export async function sweepStaleHolds({
  olderThanMinutes = MIN_AGE_MINUTES,
  limit = 1000,
  pageSize = 100,
  budgetMs = RUN_BUDGET_MS,
  recover = defaultRecover,
} = {}) {
  const minutes = Math.max(MIN_AGE_MINUTES, olderThanMinutes);
  const started = Date.now();
  const summary = { looked: 0, released: 0, credits: 0, kept: 0, failed: 0 };
  const recovered = new Set();
  // Paged in SQL (project holds only, oldest first, keyset), so holds that are
  // kept at the head of the list never starve a releasable one behind them.
  let after = null;
  const seen = new Set();
  while (summary.looked < limit && Date.now() - started <= budgetMs) {
    const page = await listStaleHolds({ olderThanMinutes: minutes, projectOnly: true, limit: Math.min(pageSize, limit - summary.looked), after });
    // A page that brings no hold not seen yet ends the run (never loop on one row).
    const fresh = page.filter((h) => !seen.has(h.id));
    if (!fresh.length) break;
    for (const h of fresh) seen.add(h.id);
    after = page.at(-1).cursor;
    for (const hold of fresh) {
      if (Date.now() - started > budgetMs) break;
      summary.looked += 1;
      try {
        if (!recovered.has(hold.project_id)) {
          recovered.add(hold.project_id);
          await recover(hold.project_id).catch((err) =>
            console.error('[holdSweeper] stall recovery failed', hold.project_id, err?.message)
          );
        }
        const credits = Number(await storyDb().rpc('story_release_orphan_hold', { p_hold: hold.id, p_min_age_minutes: minutes })) || 0;
        if (credits > 0) {
          summary.released += 1;
          summary.credits += credits;
          console.warn('[holdSweeper] released a stale story hold', hold.id, hold.project_id, credits);
        } else {
          summary.kept += 1;
        }
      } catch (err) {
        summary.failed += 1;
        console.error('[holdSweeper] could not sweep hold', hold.id, err?.message);
      }
    }
  }
  return summary;
}
