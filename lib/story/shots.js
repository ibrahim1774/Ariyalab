import { randomUUID } from 'node:crypto';
import {
  getBalance, HoldClosedError, holdCredits, holdRemaining, InsufficientCreditsError, projectCharged, RefConflictError, releaseHold, settleHold,
} from '../credits.js';
import { PROVIDER_CONFIG, QUALITY_MAP } from '../providers/config.js';
import { creditsForShot, generatedSeconds, getPricing, QUALITY_LABELS } from '../pricing.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, QuoteChangedError, StoryError, ValidationError } from './errors.js';
import { getProject, STEPS, assertNotExpired } from './projects.js';
import { assertAllowed } from './limits.js';
import { registerAction } from './actions.js';
import { enqueue } from './runner.js';
import { shotsView } from './storyboard.js';
import { styleFragment } from './prompts/styles.js';

/*
 * Generate (spec 7.3 step 10): every storyboard shot becomes a video clip
 * (job kind 'clip', handler in lib/story/clipJobs.js), priced and confirmed
 * first, under one hold. Review (step 11): a ready clip can be made again.
 *
 * story_shots fields this step owns: clip_url / clip_key, clip_round,
 * clip_prev, and status 'queued' (a clip job is waiting or running; the view
 * shows 'generating' while it runs), 'ready', or 'failed' / 'blocked' when the
 * clip job ended that way (shared with stills: clip decisions read the latest
 * clip job, never status alone).
 *
 * Money (lib/pricing.js is the only source of numbers), in clipAttemptCost and
 * rerollCost:
 *   - a clip costs creditsForShot(quality, seconds) (at least the quality's
 *     minimum seconds);
 *   - a retry of a shot whose latest clip attempt failed (current round, not
 *     blocked) costs what that attempt cost: a failed paid attempt was
 *     released, so it is held again; a failed free attempt is retried free, at
 *     most FREE_RETRIES times, then at the clip price. A retry never charges
 *     twice and a paid attempt is never free;
 *   - Make it again on a ready clip is free while the project's free re-rolls
 *     (ceil(shots with a clip delivered by a paid attempt x
 *     pricing.freeRerollShare)) are not used up and the clip is at the shot's
 *     quality and seconds, then costs the clip price;
 *   - the project fee is added when it was not charged yet (settled from the
 *     same hold, ref `project-fee:<projectId>`, the cast's own ref).
 *   The quote is what is held: startGeneration needs confirmTotal ===
 *   quote.total (else 409 quote_changed), a re-roll may send expected_credits.
 *
 * Starting clips: claim the shots (story_clip_claim, under the project row
 * lock; records the claim, the hold id and what to put back), hold once,
 * queue one job per shot carrying its share, then clear the claim. Any error
 * after the claim removes the jobs it queued (if they are still queued),
 * gives back the part of the hold no live job carries and puts the shots
 * back. A claim older than STALE_CLAIM_MS was left by a request that died:
 * recoverStalledClips does the same for it (every entry point runs it first).
 * Quote and generate are refused (409 needs_rebuild) while any shot needs a
 * storyboard rebuild (its scene changed); a stale clip alone is quoted again.
 */

export const FREE_RETRIES = 3;
export const STALE_CLAIM_MS = 30_000;

let deps = { enqueue, holdCredits };
/** Tests replace the queue and the hold call. Call with no argument to restore the real ones. */
export function _setShotsDeps(patch = {}) {
  deps = { enqueue: patch.enqueue || enqueue, holdCredits: patch.holdCredits || holdCredits };
}

const BUSY = ['still_pending', 'queued', 'generating'];
const RETRYABLE = ['failed'];

// ---------------------------------------------------------------- data

const shotRows = (projectId) => storyDb().select('story_shots', { project_id: projectId }, { order: 'ord' });

/** Clip jobs by shot id, oldest first. */
async function clipJobsByShot(projectId) {
  const rows = await storyDb().select('story_jobs', { project_id: projectId, kind: 'clip' }, { order: ['-created_at', '-id'], limit: 5000 });
  const map = new Map();
  for (const job of rows.reverse()) {
    if (!job.shot_id) continue;
    if (!map.has(job.shot_id)) map.set(job.shot_id, []);
    map.get(job.shot_id).push(job);
  }
  return map;
}

/** The shot's latest clip attempt (highest round), or null. */
const latestClip = (jobs = []) => jobs.reduce((a, j) => (!a || Number(j.payload?.round ?? -1) >= Number(a.payload?.round ?? -1) ? j : a), null);

const isGenerated = (shot) => (shot.source || 'generated') === 'generated';

// ---------------------------------------------------------------- money

/** The full price of one clip of this shot now. */
export const clipPrice = (shot, pricing) => creditsForShot(pricing, shot.quality, shot.seconds);

/**
 * What one clip attempt of this shot costs from the generate step. The one
 * place the retry rule lives (see the header). jobs: the shot's clip jobs.
 * -> { credits, kind: 'first' | 'retry' }
 */
export function clipAttemptCost({ shot, jobs = [], pricing }) {
  const last = latestClip(jobs);
  if (last && RETRYABLE.includes(last.status) && Number(last.payload?.round) === shot.clip_round && sameAttempt(last, shot, pricing)) {
    let credits = Number(last.payload?.credits ?? last.cost_credits ?? 0) || 0;
    if (credits === 0 && jobs.filter((j) => j.payload?.kind === 'retry' && !(Number(j.payload?.credits) > 0)).length >= FREE_RETRIES) {
      credits = clipPrice(shot, pricing);
    }
    return { credits, kind: 'retry' };
  }
  return { credits: clipPrice(shot, pricing), kind: 'first' };
}

/**
 * A failed attempt is retried at its own price only while the shot is still
 * what it was made from: the same quality and generated seconds, and for a
 * free attempt also the same description and still. Anything else is a fresh
 * attempt at the shot's price now.
 */
function sameAttempt(job, shot, pricing) {
  const p = job.payload || {};
  if (p.quality !== shot.quality || Number(p.seconds) !== generatedSeconds(pricing, shot.quality, shot.seconds)) return false;
  if (Number(p.credits) > 0) return true;
  return p.description === shot.description && (p.stillKey ?? null) === (shot.still_key ?? null);
}

/** The clip on the row was delivered by a paid attempt (a done clip job that carried credits). */
const hasPaidClip = (shot, jobs = []) => Boolean(shot.clip_url) && jobs.some((j) => j.status === 'done' && Number(j.cost_credits) > 0);

/** Free re-rolls this project has: ceil(shots with a delivered, paid clip x freeRerollShare). jobs: clip jobs by shot id. */
export const includedRerolls = (shots, jobs, pricing) =>
  Math.max(0, Math.ceil(shots.filter((s) => isGenerated(s) && hasPaidClip(s, jobs.get(s.id))).length * (Number(pricing.freeRerollShare) || 0) - 1e-9));

/**
 * What Make it again on a ready clip costs now. After a remake that failed
 * (latest clip job failed in the current round) it is a retry at what that
 * attempt cost (clipAttemptCost) and uses no free re-roll.
 * -> { credits, kind: 'reroll_free' | 'reroll' | 'retry' }
 */
export function rerollCost({ project, shots, shot, pricing, jobs = [], allJobs = new Map() }) {
  const retry = clipAttemptCost({ shot, jobs, pricing });
  if (retry.kind === 'retry') return retry;
  // Free only for the clip as it was delivered: same quality and seconds.
  const delivered = [...jobs].reverse().find((j) => j.status === 'done');
  const same = delivered && delivered.payload?.quality === shot.quality
    && Number(delivered.payload?.seconds) === generatedSeconds(pricing, shot.quality, shot.seconds);
  const free = same && (project.rerolls_used || 0) < includedRerolls(shots, allJobs, pricing);
  return free ? { credits: 0, kind: 'reroll_free' } : { credits: clipPrice(shot, pricing), kind: 'reroll' };
}

/**
 * Whether a shot can be generated from the generate step: a generated shot
 * with no clip or a stale one. Busy shots are not. A current clip is remade
 * from Review (rerollShot), also after a remake failed.
 */
function wantsClip(shot) {
  if (!isGenerated(shot) || BUSY.includes(shot.status)) return false;
  return !shot.clip_url || Boolean(shot.stale);
}

/**
 * The default set (and the screen's clip_credits): wantsClip, minus a shot
 * whose latest attempt was blocked and that has not changed since (same
 * description and still): it would only be blocked again.
 */
function wantsClipByDefault(shot, jobs) {
  if (!wantsClip(shot)) return false;
  const last = latestClip(jobs);
  if (!last || last.status !== 'blocked' || Number(last.payload?.round) !== shot.clip_round) return true;
  return !(last.payload?.description === shot.description && (last.payload?.stillKey ?? null) === (shot.still_key ?? null));
}

/** Can Make it again run on this shot now: a ready, current clip that is not being remade. */
const canReroll = (shot) => isGenerated(shot) && shot.status === 'ready' && Boolean(shot.clip_url) && !shot.stale;

// ---------------------------------------------------------------- views

/**
 * The shots as the screen reads them: the storyboard view (retry_credits,
 * still_credits, needs_rebuild) plus
 *   clip_credits    what Generate costs for this shot now (null when it has nothing to generate)
 *   clip_price      the full price of one clip of this shot
 *   reroll_credits  what Make it again costs now (null when it cannot be made again)
 * and status 'generating' while its clip job is running.
 */
export async function clipView(projectId, project) {
  const [base, jobs, pricing] = await Promise.all([shotsView(projectId), clipJobsByShot(projectId), getPricing()]);
  return base.map((shot) => {
    const mine = jobs.get(shot.id) || [];
    const last = latestClip(mine);
    const running = shot.status === 'queued' && last?.status === 'running' && Number(last.payload?.round) === shot.clip_round;
    return {
      ...shot,
      status: running ? 'generating' : shot.status,
      clip_credits: wantsClipByDefault(shot, mine) ? clipAttemptCost({ shot, jobs: mine, pricing }).credits : null,
      clip_price: isGenerated(shot) ? clipPrice(shot, pricing) : null,
      reroll_credits: canReroll(shot) ? rerollCost({ project, shots: base, shot, pricing, jobs: mine, allJobs: jobs }).credits : null,
    };
  });
}

/** The free re-roll allowance: { included, used, left }. */
export async function rerollAllowance(project, shots) {
  const [pricing, jobs] = await Promise.all([getPricing(), clipJobsByShot(project.id)]);
  const included = includedRerolls(shots, jobs, pricing);
  const used = project.rerolls_used || 0;
  return { included, used, left: Math.max(0, included - used) };
}

// ---------------------------------------------------------------- claims

const CLAIM_CLEAR = { gen_claim_id: null, gen_hold_id: null, gen_claimed_at: null, gen_shots: null, gen_rerolls: 0 };

/**
 * Gives back what a start that will not finish left: the part of its hold no
 * live job carries, the shots without a job (put back to their state before
 * the claim; clip_round stays moved on, so a late job never lands), and free
 * re-rolls it counted when none of its jobs is left. The jobs are read before
 * the hold's remainder, so a job finishing in between makes this give back
 * less, never a live job's share. The caller has already taken the claim off
 * the project row. -> shots put back
 */
async function releaseClaim({ projectId, claimId, holdId, shots = [], rerolls = 0 }) {
  const all = await storyDb().select('story_jobs', { project_id: projectId, kind: 'clip' }, { order: ['-created_at', '-id'], limit: 1000 });
  const jobs = all.filter((j) => j.payload?.claimId === claimId);
  // The jobs this recovery counts keep their shares; a job of the claim queued after this read is not counted
  // (its share is given back below), and the request that queues it takes its share off (startClips).
  for (const job of jobs) {
    if (job.payload?.accounted) continue;
    await storyDb().update('story_jobs', { id: job.id }, { payload: { ...job.payload, accounted: true } });
  }
  if (holdId) {
    try {
      const live = jobs.filter((j) => j.hold_id === holdId && j.cost_credits > 0 && !j.applied_at).reduce((n, j) => n + j.cost_credits, 0);
      if (!jobs.length) {
        await releaseHold({ holdId });
      } else {
        const hold = await holdRemaining(holdId);
        const amount = (hold?.status === 'active' ? hold.remaining : 0) - live;
        if (amount > 0) await releaseHold({ holdId, amount, ref: `clips:${claimId}:unqueued` });
      }
    } catch (err) {
      if (!(err instanceof HoldClosedError) && !(err instanceof RefConflictError) && !/hold_not_found/.test(err?.message || '')) {
        console.error('[story] could not give back the unused part of a clip hold; left for the stale-hold sweeper', projectId, holdId, err?.message);
      }
    }
  }
  const withJob = new Set(jobs.map((j) => j.shot_id));
  let back = 0;
  for (const item of shots) {
    if (withJob.has(item.id)) continue;
    back += await putShotBack(projectId, item.id, item.round + 1);
  }
  if (rerolls > 0 && !jobs.length) {
    const [p] = await storyDb().select('story_projects', { id: projectId });
    if (p) await storyDb().update('story_projects', { id: projectId, rerolls_used: p.rerolls_used }, { rerolls_used: Math.max(0, p.rerolls_used - rerolls) });
  }
  return back;
}

/**
 * Puts a shot that is 'queued' for this clip round back to its state before
 * the claim (clip_prev). clip_round stays where it is, so a late job never
 * lands. -> 1 when it was put back, else 0
 */
async function putShotBack(projectId, shotId, round) {
  if (!shotId || !Number.isInteger(round)) return 0;
  const [row] = await storyDb().select('story_shots', { id: shotId, project_id: projectId, clip_round: round, status: 'queued' });
  if (!row) return 0;
  const prev = row.clip_prev || {};
  const done = await storyDb().update(
    'story_shots',
    { id: shotId, clip_round: round, status: 'queued' },
    { status: prev.status || 'still_ready', error: prev.error ?? null, clip_prev: null }
  );
  return done.length;
}

/**
 * Puts back a clip start left by a request that died (claim older than
 * STALE_CLAIM_MS): takes the claim off the project row (compare and set, so
 * only one caller does it), then releaseClaim. -> shots put back
 */
export async function recoverStalledClips(projectId) {
  const [p] = await storyDb().select('story_projects', { id: projectId });
  if (!p?.gen_claim_id || !p.gen_claimed_at || Date.now() - Date.parse(p.gen_claimed_at) <= STALE_CLAIM_MS) return 0;
  const [taken] = await storyDb().update('story_projects', { id: projectId, gen_claim_id: p.gen_claim_id }, CLAIM_CLEAR);
  if (!taken) return 0;
  return releaseClaim({ projectId, claimId: p.gen_claim_id, holdId: p.gen_hold_id, shots: p.gen_shots || [], rerolls: p.gen_rerolls || 0 });
}

function clipPrompt({ style, description, line, mode, elements = [] }) {
  const parts = [style, description];
  if (elements.length) parts.push(`Characters: ${elements.map((e) => `@${e.name}`).join(', ')}.`);
  if (mode === 'talking' && line) parts.push(`The character says: "${line}"`);
  parts.push('Natural, gentle motion that continues the picture. No text, captions or logos on screen.');
  return parts.filter(Boolean).join(' ');
}

/**
 * Kling character elements for a shot: each cast member in the shot with at
 * least minElementImages pictures (the pick and the cast sheet), at most
 * maxElements. Economy (Seedance) has no elements.
 */
function shotElements(shot, castById) {
  if (QUALITY_MAP[shot.quality]?.family !== 'kling') return [];
  const lim = PROVIDER_CONFIG.kling;
  const out = [];
  for (const id of shot.cast_ids || []) {
    const c = castById.get(id);
    if (!c) continue;
    const imageUrls = [...new Set([c.image_url, c.sheet?.url].filter(Boolean))].slice(0, lim.maxElementImages);
    if (imageUrls.length < lim.minElementImages) continue;
    // The element name is what the prompt refers to (@name): letters and digits only, unique in the shot.
    // The display name stays in the description. Not checked against the real kie API yet.
    let name = String(c.name || '').replace(/[^A-Za-z0-9]+/g, '') || `Character${out.length + 1}`;
    while (out.some((e) => e.name === name)) name = `${name}${out.length + 1}`;
    out.push({ name, description: [c.name, c.description].filter(Boolean).join(': '), imageUrls });
    if (out.length === lim.maxElements) break;
  }
  return out;
}

/**
 * Thrown inside startClips when a stall recovery took this request's claim.
 * afterCommit: it comes after the hold (and maybe queued jobs), so a caller
 * that undoes its own bookkeeping on a refusal (the chat's confirm card) must
 * not treat it as one.
 */
class ClaimLost extends ConflictError {
  constructor() {
    super('These shots just changed. Reload and try again.', { code: 'shots_busy' });
    this.afterCommit = true;
  }
}

/**
 * Claims the shots, holds total once, queues one clip job per item and clears
 * the claim. items: [{ shot, credits, kind }]. fee: project fee settled from
 * the same hold. rerolls: { used, add } for a free re-roll. Any failure after
 * the claim undoes it (see releaseClaim) and rethrows; a claim lost to another
 * request is 409 shots_busy.
 */
async function startClips({ project, items, fee = 0, rerolls = null }) {
  const pricing = await getPricing();
  const total = fee + items.reduce((n, it) => n + it.credits, 0);
  const claimId = randomUUID();
  const holdId = total > 0 ? randomUUID() : null;
  const claimShots = items.map((it) => ({ id: it.shot.id, round: it.shot.clip_round, status: it.shot.status }));
  let claimed;
  try {
    claimed = await storyDb().rpc('story_clip_claim', {
      p_project: project.id, p_claim: claimId, p_hold: holdId, p_shots: claimShots,
      p_rerolls_used: rerolls ? rerolls.used : null, p_rerolls_add: rerolls ? rerolls.add : 0, p_now: new Date().toISOString(),
    });
  } catch (err) {
    if (!/shots_changed/.test(err?.message || '')) throw err;
    claimed = [];
  }
  if (!claimed?.length) {
    throw new ConflictError('These shots are already being made, or just changed. Wait a moment and reload.', { code: 'shots_busy' });
  }

  const style = styleFragment(project);
  const castRows = await storyDb().select('story_cast', { project_id: project.id });
  const castById = new Map(castRows.map((c) => [c.id, c]));
  const stillMine = async () => {
    const [mine] = await storyDb().select('story_projects', { id: project.id, gen_claim_id: claimId });
    if (!mine) throw new ClaimLost();
  };
  const made = [];
  try {
    if (holdId) await deps.holdCredits({ userId: project.user_id, currency: 'video', amount: total, projectId: project.id, holdId });
    for (const it of items) {
      const { shot } = it;
      const elements = shotElements(shot, castById);
      await stillMine();
      made.push(await deps.enqueue({
        projectId: project.id,
        shotId: shot.id,
        kind: 'clip',
        payload: {
          shotId: shot.id,
          round: shot.clip_round + 1,
          claimId,
          kind: it.kind,
          credits: it.credits,
          prompt: clipPrompt({ style, description: shot.description, line: shot.line, mode: project.mode, elements }),
          ...(elements.length ? { elements } : {}),
          description: shot.description,
          stillKey: shot.still_key ?? null,
          imageUrl: shot.still_url,
          seconds: generatedSeconds(pricing, shot.quality, shot.seconds),
          quality: shot.quality,
          aspect: project.aspect,
        },
        holdId: it.credits > 0 ? holdId : null,
        costCredits: it.credits > 0 ? it.credits : null,
      }));
    }
    await stillMine();
    // The fee last, so a start that fails costs nothing.
    if (fee > 0) await chargeFee({ project, holdId, fee, claimId });
    const [cleared] = await storyDb().update('story_projects', { id: project.id, gen_claim_id: claimId }, CLAIM_CLEAR);
    if (!cleared) throw new ClaimLost();
  } catch (err) {
    if (err instanceof ClaimLost) {
      console.error('[story] a clip claim was recovered while its request was still queuing', project.id, claimId);
      await settleLostClaim({ made, holdId }).catch((e) => console.error('[story] could not settle a lost clip claim', project.id, claimId, holdId, e?.message));
      throw err;
    }
    // Only the caller that takes the claim off the row undoes it (a stall recovery may have done it already).
    const [taken] = await storyDb().update('story_projects', { id: project.id, gen_claim_id: claimId }, CLAIM_CLEAR)
      .catch((e) => {
        console.error('[story] could not clear a failed clip claim', project.id, claimId, e?.message);
        return [];
      });
    if (taken) {
      if (made.length) {
        await storyDb().remove('story_jobs', { id: made.map((j) => j.id), status: 'queued' })
          .catch((e) => console.error('[story] could not take back queued clip jobs', project.id, e?.message));
      }
      await releaseClaim({ projectId: project.id, claimId, holdId, shots: claimShots, rerolls: rerolls?.add || 0 })
        .catch((e) => console.error('[story] could not undo a clip start', project.id, claimId, holdId, e?.message));
    } else {
      // A stall recovery took the claim first (for example while the hold call was slow): settle what it could not see.
      await settleLostClaim({ made, holdId }).catch((e) => console.error('[story] could not settle a lost clip claim', project.id, claimId, holdId, e?.message));
      if (err && typeof err === 'object') err.afterCommit = true;
    }
    throw err;
  }
  return { total, queued: items.map((it) => it.shot.id) };
}

/**
 * A stall recovery took this request's claim (it gave back the part of the
 * hold that no job it saw carries, and marked those jobs `accounted`). This
 * request's jobs the recovery did not see: queued ones are taken out, any the
 * runner already took run free (their share was given back, so hold_id and
 * cost are cleared and they never settle or release). With no job the
 * recovery counted, whatever is left of the hold is given back (a hold that
 * landed after the recovery ran).
 */
async function settleLostClaim({ made, holdId }) {
  let counted = 0;
  for (const job of made) {
    const [row] = await storyDb().select('story_jobs', { id: job.id });
    if (!row) continue;
    if (row.payload?.accounted) {
      counted += 1;
      continue;
    }
    const removed = await storyDb().remove('story_jobs', { id: row.id, status: 'queued' });
    if (removed.length) {
      // Its shot waits for no job now (recovery may have counted the job and so left the shot queued): put it back.
      await putShotBack(row.project_id, row.shot_id, Number(row.payload?.round));
    } else {
      await storyDb().update('story_jobs', { id: row.id }, { hold_id: null, cost_credits: null });
    }
  }
  if (holdId && counted === 0) {
    try {
      await releaseHold({ holdId });
    } catch (err) {
      if (!(err instanceof HoldClosedError) && !/hold_not_found/.test(err?.message || '')) throw err;
    }
  }
}

/**
 * The project fee from the generation's hold, with the ref the cast uses, so
 * it is charged once whichever comes first. If the cast charged it meanwhile
 * (the ref is taken by its spend) the fee part of the hold is given back.
 */
async function chargeFee({ project, holdId, fee, claimId }) {
  try {
    await settleHold({ holdId, amount: fee, reason: 'story_project_fee', ref: `project-fee:${project.id}` });
  } catch (err) {
    if (!(err instanceof RefConflictError)) throw err;
    await releaseHold({ holdId, amount: fee, ref: `clips:${claimId}:fee` });
  }
  await storyDb().update('story_projects', { id: project.id }, { fee_charged: true });
}

// ---------------------------------------------------------------- services

function cleanShotIds(shotIds) {
  if (shotIds === undefined || shotIds === null) return null;
  if (!Array.isArray(shotIds) || shotIds.length > 100 || shotIds.some((id) => typeof id !== 'string')) {
    throw new ValidationError('Say which shots.', { field: 'shotIds' });
  }
  return [...new Set(shotIds)];
}

const NEEDS_REBUILD = 'Your script changed since the storyboard was made. Rebuild the storyboard, then generate.';

/**
 * The price of generating these shots (default: every shot that wants a
 * clip), worked out the way startGeneration charges it.
 * -> { total, lines, holdNeeded, shotIds, items, fee }
 */
export async function priceGeneration(project, shotIds) {
  const [view, jobs, pricing] = await Promise.all([shotsView(project.id), clipJobsByShot(project.id), getPricing()]);
  if (view.some((s) => s.needs_rebuild)) throw new ConflictError(NEEDS_REBUILD, { code: 'needs_rebuild' });
  let targets;
  if (shotIds) {
    targets = shotIds.map((id) => {
      const row = view.find((s) => s.id === id);
      if (!row) throw new NotFoundError('Shot not found.');
      return row;
    });
    for (const shot of targets) {
      if (!isGenerated(shot)) throw new ValidationError('This shot uses your own footage, so it has nothing to generate.', { field: 'shotIds' });
      if (BUSY.includes(shot.status)) throw new ConflictError('This shot is already being made. Wait for it to finish.', { code: 'shots_busy' });
      if (!wantsClip(shot)) {
        throw new ConflictError('This shot already has its clip. Use Make it again on the Review step to redo it.', { code: 'already_ready' });
      }
    }
  } else {
    targets = view.filter((s) => wantsClipByDefault(s, jobs.get(s.id) || []));
  }
  const items = targets.map((shot) => ({ shot, ...clipAttemptCost({ shot, jobs: jobs.get(shot.id) || [], pricing }) }));
  const fee = items.length && !project.fee_charged ? pricing.projectFee : 0;

  const lines = [];
  if (fee > 0) lines.push({ label: 'Project fee', credits: fee });
  const groups = new Map();
  for (const it of items.filter((x) => x.kind === 'first')) {
    const g = groups.get(it.shot.quality) || { count: 0, credits: 0 };
    g.count += 1;
    g.credits += it.credits;
    groups.set(it.shot.quality, g);
  }
  for (const [quality, g] of groups) {
    lines.push({ label: `${g.count} ${QUALITY_LABELS[quality] || quality} ${g.count === 1 ? 'shot' : 'shots'}`, credits: g.credits });
  }
  const retries = items.filter((x) => x.kind === 'retry');
  if (retries.length) {
    lines.push({ label: `${retries.length} ${retries.length === 1 ? 'retry' : 'retries'}`, credits: retries.reduce((n, x) => n + x.credits, 0) });
  }
  const total = lines.reduce((n, l) => n + l.credits, 0);
  return { total, lines, holdNeeded: total, shotIds: items.map((x) => x.shot.id), items, fee };
}

/**
 * The quote for generating these shots (default: every shot that wants a clip).
 * -> { total, lines, holdNeeded, shotIds, spent }   spent: credits charged on this project so far
 */
export async function quoteGeneration({ userId, projectId, shotIds }) {
  const project = await getProject({ userId, id: projectId });
  const ids = cleanShotIds(shotIds);
  await recoverStalledClips(projectId);
  const { total, lines, holdNeeded, shotIds: quoted } = await priceGeneration(project, ids);
  return { total, lines, holdNeeded, shotIds: quoted, spent: await projectCharged({ userId, projectId }) };
}

/**
 * Starts the clips of these shots (default: every shot that wants one) for
 * exactly the price the customer confirmed (confirmTotal, else 409
 * quote_changed with the current total). One hold for the lot; 402 when the
 * balance does not cover it, with nothing queued. Moves the project to the
 * generate step. -> { shots, charged, queued }
 */
export async function startGeneration({ userId, projectId, shotIds, confirmTotal, user }) {
  const project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  const ids = cleanShotIds(shotIds);
  if (!Number.isInteger(confirmTotal) || confirmTotal < 0) {
    throw new ValidationError('Confirm the price before generating.', { field: 'confirmTotal' });
  }
  await assertAllowed({ userId, action: 'shots_generate', projectId, user });
  await recoverStalledClips(projectId);

  const quote = await priceGeneration(project, ids);
  if (confirmTotal !== quote.total) {
    throw new QuoteChangedError(`The price is now ${quote.total} credits. Check it and confirm again.`, { total: quote.total });
  }
  if (!quote.items.length) throw new StoryError('There is nothing to generate right now.', { status: 422, code: 'nothing_to_generate' });
  const missing = quote.items.find((it) => !it.shot.still_url);
  if (missing) throw new StoryError('Every shot needs its picture before it can be generated.', { status: 422, code: 'still_missing' });
  if (quote.total > 0) {
    const { available } = await getBalance(userId, 'video');
    if (available < quote.total) throw new InsufficientCreditsError(quote.total, available);
  }

  const out = await startClips({ project, items: quote.items, fee: quote.fee });
  // Only forward, and only from the step read now (the last clip may have moved it to review meanwhile).
  const [now] = await storyDb().select('story_projects', { id: projectId, user_id: userId });
  if (now && STEPS.indexOf(now.step) < STEPS.indexOf('generate')) {
    await storyDb().update('story_projects', { id: projectId, user_id: userId, step: now.step }, { step: 'generate' });
  }
  return { shots: await clipView(projectId, await getProject({ userId, id: projectId })), charged: out.total, queued: out.queued };
}

/**
 * Makes a ready clip again (Review: Make it again). Free while the project's
 * free re-rolls last, then the clip price, held and settled when the clip
 * arrives (released if it fails). The old clip stays until the new one lands.
 * expectedCredits (optional): the price on the button; a different price is
 * 409 quote_changed ({ credits }). -> { shots, charged, rerolls }
 */
export async function rerollShot({ userId, projectId, shotId, expectedCredits, user }) {
  const project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  if (typeof shotId !== 'string' || !shotId) throw new ValidationError('Say which shot.', { field: 'shotId' });
  if (expectedCredits !== undefined && expectedCredits !== null && (!Number.isInteger(expectedCredits) || expectedCredits < 0)) {
    throw new ValidationError('The price must be a whole number of credits.', { field: 'expected_credits' });
  }
  await assertAllowed({ userId, action: 'shot_reroll', projectId, user });
  await recoverStalledClips(projectId);

  const [view, pricing, jobs] = await Promise.all([shotsView(projectId), getPricing(), clipJobsByShot(projectId)]);
  if (view.some((s) => s.needs_rebuild)) throw new ConflictError(NEEDS_REBUILD, { code: 'needs_rebuild' });
  const shot = view.find((s) => s.id === shotId);
  if (!shot) throw new NotFoundError('Shot not found.');
  if (!canReroll(shot)) {
    throw new ConflictError(
      shot.stale ? 'This shot changed since its clip was made. Generate it again on the Generate step.' : 'This clip cannot be made again right now. Wait for it to finish.',
      { code: 'reroll_not_available' }
    );
  }
  const cost = rerollCost({ project, shots: view, shot, pricing, jobs: jobs.get(shot.id) || [], allJobs: jobs });
  // A paid remake needs the price the customer saw; a free one may come without it.
  const unseen = expectedCredits === undefined || expectedCredits === null;
  if ((unseen && cost.credits > 0) || (!unseen && expectedCredits !== cost.credits)) {
    throw new QuoteChangedError(`Making this clip again now costs ${cost.credits} credits. Check it and try again.`, { credits: cost.credits });
  }
  if (cost.credits > 0) {
    const { available } = await getBalance(userId, 'video');
    if (available < cost.credits) throw new InsufficientCreditsError(cost.credits, available);
  }
  await startClips({
    project,
    items: [{ shot, credits: cost.credits, kind: cost.kind }],
    rerolls: { used: project.rerolls_used || 0, add: cost.kind === 'reroll_free' ? 1 : 0 },
  });
  const fresh = await getProject({ userId, id: projectId });
  const shots = await clipView(projectId, fresh);
  return { shots, charged: cost.credits, rerolls: await rerollAllowance(fresh, shots) };
}

// ---------------------------------------------------------------- HTTP actions

// POST /api/story/projects/[id]/quote     { shotIds? } -> { total, lines:[{label, credits}], holdNeeded, shotIds }
// POST /api/story/projects/[id]/generate  { shotIds?, confirmTotal } -> { shots, charged, queued }
//      409 quote_changed { total }, needs_rebuild, shots_busy, already_ready; 402 insufficient_credits / plan_required;
//      422 still_missing, nothing_to_generate
// POST /api/story/projects/[id]/reroll    { shotId, expected_credits? } -> { shots, charged, rerolls }
//      409 quote_changed { credits }, reroll_not_available, needs_rebuild; 402
export const quoteAction = async ({ userId, projectId, body = {} }) => quoteGeneration({ userId, projectId, shotIds: body.shotIds });
export const generateAction = async ({ userId, user, projectId, body = {} }) =>
  startGeneration({ userId, projectId, shotIds: body.shotIds, confirmTotal: body.confirmTotal, user });
export const rerollAction = async ({ userId, user, projectId, body = {} }) =>
  rerollShot({ userId, projectId, shotId: body.shotId, expectedCredits: body.expected_credits, user });

registerAction('quote', { method: 'POST', handler: quoteAction });
registerAction('generate', { method: 'POST', handler: generateAction });
registerAction('reroll', { method: 'POST', handler: rerollAction });
