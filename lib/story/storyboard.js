import { createHash, randomUUID } from 'node:crypto';
import { completeJSON } from '../providers/llm.js';
import { QUALITIES } from '../providers/video.js';
import { ModerationError, screenText, screenTextRegex } from '../moderation.js';
import { getBalance, HoldClosedError, holdCredits, InsufficientCreditsError, releaseHold } from '../credits.js';
import { generatedSeconds, getPricing } from '../pricing.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, StoryError, ValidationError } from './errors.js';
import { getProject, STEPS, assertNotExpired } from './projects.js';
import { assertAllowed, releaseAllowance } from './limits.js';
import { registerAction } from './actions.js';
import { enqueue } from './runner.js';
import { ASSET_MESSAGES, IMAGE_DB_KINDS, INSET_DEFAULT, INSET_RANGE, VIDEO_DB_KINDS } from './assetRules.js';
import { ownedAsset } from './assets.js';
import { onScenesChanged } from './script.js';
import { styleFragment } from './prompts/styles.js';
import { FAMILY_FRIENDLY_GUIDANCE } from './prompts/script.js';
import {
  buildSecondsRetryMessage, buildShotsMessage, buildShotsSystem, MAX_CAST_REFS, MAX_SHOT_DESCRIPTION, MAX_SHOT_LINE,
  MAX_SHOT_SECONDS, MAX_SHOTS, MIN_SHOT_SECONDS, secondsRange, SHOTS_SCHEMA, stillPrompt,
} from './prompts/shot.js';
import './mocks.js';

/*
 * The storyboard step (spec 7.3 step 8): the script's scenes become a shot
 * list, each shot gets one still picture (job kind 'still', handler in
 * lib/story/stillJobs.js), and the customer can edit or redo a shot.
 *
 * story_shots fields this step owns:
 *   ord, scene_id, description, line, seconds (integer 3..6), quality,
 *   cast_ids, still_url / still_key, still_round, status, stale, error.
 *   status: 'draft' (no still) -> 'still_pending' -> 'still_ready', or
 *   'failed' / 'blocked' when the still job ended that way. Task 16 moves a
 *   shot on to 'queued' / 'generating' / 'ready' for its clip.
 *   stale: the shot's clip (and, before a rebuild, its place in the shot
 *   list) no longer matches the script, the description or the quality.
 *   clip_url is kept; making a new clip clears stale.
 *
 * Money (lib/pricing.js is the only source of numbers), in stillAttemptCost:
 *   - a shot's first still is free until a still has been delivered for it,
 *     for at most FREE_FIRST_TRIES free attempts, and only on a shot whose
 *     scene never had a still before (free_still; a rebuild of a scene that
 *     already had pictures makes paid shots);
 *   - every later still is a re-roll and costs pricing.stillReroll, held up
 *     front and settled by the runner when the picture arrives (released if
 *     it fails);
 *   - a retry (`retry: true`) is allowed only when the shot's last still
 *     attempt failed at the provider. It costs what that attempt cost (a
 *     failed re-roll was refunded, so it is held again; a failed free first
 *     still is retried free): a retry never charges twice, and never counts
 *     as the free first still.
 * stills_generate needs a paid plan (lib/story/limits.js). A build that asks
 * the model also counts as shots_build (10 per project per day).
 *
 * Starting a still: claim the row (story_shot_claim, under the project row
 * lock; records the hold id and the state to go back to), then hold, then
 * queue. Any failure in between gives the hold back and puts the row back.
 * A claim older than STALE_CLAIM_MS with no job of its round was left by a
 * request that died: recoverStalledStills releases its hold and puts the row
 * back; generateStills, updateShot and buildShotList run it first.
 */

export const FREE_FIRST_TRIES = 3;
export const STALE_CLAIM_MS = 30_000;

let deps = { enqueue, holdCredits };
/** Tests replace the queue and the hold call. Call with no argument to restore the real ones. */
export function _setStoryboardDeps(patch = {}) {
  deps = { enqueue: patch.enqueue || enqueue, holdCredits: patch.holdCredits || holdCredits };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// Statuses from which a still can be started (anything else is busy).
const STILL_STARTABLE = ['draft', 'still_ready', 'failed', 'blocked', 'ready'];
const BUSY = ['still_pending', 'queued', 'generating'];

// ---------------------------------------------------------------- data

const shotRows = (projectId) => storyDb().select('story_shots', { project_id: projectId }, { order: 'ord' });

async function getShot(projectId, shotId) {
  if (typeof shotId !== 'string' || !UUID.test(shotId)) throw new NotFoundError('Shot not found.');
  const [row] = await storyDb().select('story_shots', { id: shotId, project_id: projectId });
  if (!row) throw new NotFoundError('Shot not found.');
  return row;
}

async function latestScript(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  return row || null;
}

/** Still jobs by shot id, oldest first. */
async function stillJobsByShot(projectId) {
  const rows = await storyDb().select('story_jobs', { project_id: projectId, kind: 'still' }, { order: ['created_at', 'id'], limit: 5000 });
  const map = new Map();
  for (const job of rows) {
    if (!job.shot_id) continue;
    if (!map.has(job.shot_id)) map.set(job.shot_id, []);
    map.get(job.shot_id).push(job);
  }
  return map;
}

// ---------------------------------------------------------------- money

/**
 * What one still attempt costs. The one place the storyboard's still price
 * rules live (see the header). jobs: the shot's still jobs, oldest first.
 * -> { credits, kind: 'first' | 'reroll' | 'retry' }; a retry that is not
 * allowed throws ConflictError 'retry_not_available'.
 */
export function stillAttemptCost({ shot, jobs = [], retry = false, pricing }) {
  if (retry) {
    // The job of the latest round; a description change since then (still_base_round) makes it not retryable.
    const last = jobs.reduce((a, j) => (!a || Number(j.payload?.round ?? -1) >= Number(a.payload?.round ?? -1) ? j : a), null);
    if (!last || last.status !== 'failed' || Number(last.payload?.round ?? 0) <= Number(shot.still_base_round ?? 0) || Number(last.payload?.round) > shot.still_round) {
      throw new ConflictError('There is nothing to try again for this shot. Make the picture again instead.', { code: 'retry_not_available' });
    }
    let credits = Number(last.payload?.credits ?? last.cost_credits ?? 0) || 0;
    // Free retries of free attempts are capped like free makes; after that a retry is a re-roll.
    if (credits === 0 && jobs.filter((j) => j.payload?.kind === 'retry' && !(Number(j.payload?.credits) > 0)).length >= FREE_FIRST_TRIES) {
      credits = pricing.stillReroll;
    }
    return { credits, kind: 'retry' };
  }
  const delivered = shot.still_delivered === true || jobs.some((j) => j.status === 'done');
  const freeTries = jobs.filter((j) => j.payload?.kind === 'first').length;
  if (delivered || shot.free_still === false || freeTries >= FREE_FIRST_TRIES) return { credits: pricing.stillReroll, kind: 'reroll' };
  return { credits: 0, kind: 'first' };
}

/** The price of a Try again on this shot right now, or null when it cannot be retried. */
function retryCredits(shot, jobs, pricing) {
  try {
    return stillAttemptCost({ shot, jobs, retry: true, pricing }).credits;
  } catch {
    return null;
  }
}

/**
 * The shots as the screen reads them: rows plus retry_credits, still_credits (a normal make now; null for
 * footage) and needs_rebuild (the shot's scene changed or was removed, or a scene has no shots yet).
 */
export async function shotsView(projectId) {
  const [rows, jobs, pricing, script] = await Promise.all([shotRows(projectId), stillJobsByShot(projectId), getPricing(), latestScript(projectId)]);
  const sigs = new Map((script?.scenes || []).map((sc) => [sc.id, sceneSig(sc)]));
  // A scene with no shots yet (added to the script) needs a rebuild too; it has no shot to carry the flag, so all do.
  const sceneWithoutShots = rows.length > 0 && [...sigs.keys()].some((id) => !rows.some((r) => r.scene_id === id));
  // The customer's own footage and inset files, for the screen to show. Only files of the project's owner are read.
  const mediaIds = [...new Set(rows.flatMap((r) => [r.footage_asset_id, r.inset_asset_id]).filter(Boolean))];
  let media = new Map();
  if (mediaIds.length) {
    const [owner] = await storyDb().select('story_projects', { id: projectId }, { columns: ['user_id'], limit: 1 });
    const own = owner ? await storyDb().select('story_assets', { id: mediaIds, user_id: owner.user_id }, { columns: ['id', 'kind', 'url', 'name'] }) : [];
    media = new Map(own.map((a) => [a.id, a]));
  }
  return rows.map((row) => {
    const mine = jobs.get(row.id) || [];
    const footage = row.footage_asset_id ? media.get(row.footage_asset_id) : null;
    const inset = row.inset_asset_id ? media.get(row.inset_asset_id) : null;
    return {
      ...row,
      footage_url: footage?.url ?? null,
      footage_name: footage?.name ?? null,
      inset_url: inset?.url ?? null,
      inset_name: inset?.name ?? null,
      inset_is_image: inset ? IMAGE_DB_KINDS.includes(inset.kind) : null,
      needs_rebuild: sceneWithoutShots || row.scene_sig !== sigs.get(row.scene_id),
      retry_credits: retryCredits(row, mine, pricing),
      still_credits: row.source === 'footage' ? null : stillAttemptCost({ shot: row, jobs: mine, pricing }).credits,
    };
  });
}

/**
 * Puts back shots whose still claim was left by a request that died: older
 * than STALE_CLAIM_MS with no still job of the claimed round. Releases the
 * claim's hold first; a release that fails (other than a hold that was never
 * made) is logged and the row is left for the next call.
 */
export async function recoverStalledStills(projectId) {
  const pending = await storyDb().select('story_shots', { project_id: projectId, status: 'still_pending' });
  const now = Date.now();
  const stuck = pending.filter((r) => r.still_claimed_at && now - Date.parse(r.still_claimed_at) > STALE_CLAIM_MS);
  if (!stuck.length) return 0;
  const jobs = await stillJobsByShot(projectId);
  let reset = 0;
  for (const row of stuck) {
    if ((jobs.get(row.id) || []).some((j) => j.payload?.round === row.still_round)) continue;
    if (row.still_hold_id) {
      try {
        await releaseHold({ holdId: row.still_hold_id });
      } catch (err) {
        // A hold that was never made, or is already closed, has nothing left to give back.
        if (!(err instanceof HoldClosedError) && !/hold_not_found/.test(err?.message || '')) {
          console.error('[story] could not release a stalled still hold', row.id, row.still_hold_id, err?.message);
          continue;
        }
      }
    }
    const back = await storyDb().update(
      'story_shots',
      { id: row.id, still_round: row.still_round, status: 'still_pending', still_hold_id: row.still_hold_id },
      restorePatch(row)
    );
    reset += back.length;
  }
  return reset;
}

/**
 * The fields that put a claimed row back as it was before the claim. The round
 * stays where the claim moved it (rounds never go backwards), so a job of the
 * aborted start can never land on a later attempt.
 */
function restorePatch(row) {
  const prev = row.still_prev || {};
  return {
    status: prev.status || 'draft',
    stale: typeof prev.stale === 'boolean' ? prev.stale : row.stale,
    clip_mismatch: typeof prev.clip_mismatch === 'boolean' ? prev.clip_mismatch : row.clip_mismatch,
    error: prev.error ?? null,
    still_hold_id: null,
    still_claimed_at: null,
    still_prev: null,
  };
}

// ---------------------------------------------------------------- the shot list

/**
 * Whole seconds 3..6 for each shot, adding up to within 10% of target.
 * items: [{ seconds, fixed? }]; fixed shots (kept from the last list, whose
 * pictures and clips were made for their length) are not changed.
 * -> seconds[] in order, or null when no split can reach the range.
 */
export function fitSeconds(items, target) {
  const { min, max } = secondsRange(target);
  const out = items.map((it) => (it.fixed ? it.seconds : Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.round(Number(it.seconds) || MIN_SHOT_SECONDS)))));
  const free = items.map((it, i) => (it.fixed ? -1 : i)).filter((i) => i >= 0);
  let sum = out.reduce((a, b) => a + b, 0);
  while (sum < min) {
    const i = free.filter((k) => out[k] < MAX_SHOT_SECONDS).sort((a, b) => out[a] - out[b] || a - b)[0];
    if (i === undefined) return null;
    out[i] += 1;
    sum += 1;
  }
  while (sum > max) {
    const i = free.filter((k) => out[k] > MIN_SHOT_SECONDS).sort((a, b) => out[b] - out[a] || a - b)[0];
    if (i === undefined) return null;
    out[i] -= 1;
    sum -= 1;
  }
  return out;
}

function normalizeShots(raw, { sceneIds, castByName }) {
  const out = [];
  for (const item of Array.isArray(raw?.shots) ? raw.shots : []) {
    const sceneId = String(item?.sceneId ?? '');
    const description = clean(item?.description, MAX_SHOT_DESCRIPTION);
    if (!sceneIds.has(sceneId) || !description) continue;
    const line = clean(item?.line, MAX_SHOT_LINE) || null;
    const castIds = [];
    for (const name of Array.isArray(item?.cast) ? item.cast : []) {
      const id = castByName.get(String(name ?? '').trim().toLowerCase());
      if (id && !castIds.includes(id)) castIds.push(id);
    }
    out.push({ sceneId, description, line, seconds: item?.seconds, castIds });
    if (out.length === MAX_SHOTS) break;
  }
  return out;
}

/** Marks which new shots match an existing row (same scene, description, line), the way story_shots_replace does. */
function matchExisting(shots, existing) {
  const used = new Set();
  return shots.map((s) => {
    const row = existing.find((r) => !used.has(r.id) && r.scene_id === s.sceneId && r.description === s.description && (r.line ?? null) === s.line);
    if (row) used.add(row.id);
    return row || null;
  });
}

const BLOCKED_MESSAGE = 'We could not plan the shots in a way we were happy with. Try changing a few words in the script.';
const FAILED_MESSAGE = "We couldn't plan the shots this time. Please try again.";
const BUSY_MESSAGE = 'Some pictures or clips are still being made. Wait for them to finish, then rebuild the storyboard.';

/**
 * What a scene's shots are planned from: title, visual, lines and mention.
 * markStale and buildShotList both use it, so a shot is stale exactly when a
 * rebuild would plan its scene again.
 */
export function sceneSig(scene) {
  const body = JSON.stringify({
    title: scene.title || '', visual: scene.visual || '', lines: (scene.lines || []).map((l) => [l.speaker, l.text]), mention: scene.mention === true,
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 24);
}

// count: finished clips the swap removes (what story_shots_replace is told it may lose); own: shots that carry the customer's
// own footage or picture-in-picture and would go too. Both are lost work, so both are confirmed.
function loseClipsError(count, token, own = 0) {
  const parts = [];
  if (count > 0) parts.push(`${count} finished ${count === 1 ? 'clip' : 'clips'}`);
  if (own > 0) parts.push(`${own} ${own === 1 ? 'shot' : 'shots'} with your own footage or picture-in-picture`);
  return new ConflictError(
    `Rebuilding the storyboard removes ${parts.join(' and ')} from shots whose scene changed. Confirm to rebuild anyway.`,
    { code: 'rebuild_loses_clips', count, ...(own > 0 ? { own } : {}), ...(token ? { token } : {}) }
  );
}

/** A stored plan may be confirmed for this long. */
export const PENDING_PLAN_MS = 10 * 60_000;

/**
 * What a plan was made from: the script version, the video length, the cast
 * and every shot's id, clip, description and line. Status is left out: work
 * in flight is refused by the busy guards anyway, and a still finishing
 * between the ask and the confirm should not void it.
 */
function planBasis(script, rows, project, cast) {
  const parts = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [r.id, r.clip_url, r.description, r.line]);
  const castIds = cast.map((c) => c.id).sort();
  return createHash('sha256').update(JSON.stringify([script.id, script.version, project.seconds, castIds, parts])).digest('hex');
}

/** The stored plan this confirm token stands for, or null (wrong token, too old, or something changed since). */
function confirmedPlan(project, token, basis) {
  const pending = project.pending_shots;
  if (typeof token !== 'string' || !token || !pending || pending.token !== token) return null;
  if (project.pending_basis !== basis || !project.pending_at || Date.now() - Date.parse(project.pending_at) > PENDING_PLAN_MS) return null;
  return pending;
}

function mapReplaceError(err) {
  const msg = err?.message || '';
  if (/shots_busy/.test(msg)) return new ConflictError(BUSY_MESSAGE, { code: 'shots_busy' });
  const lost = /rebuild_loses_clips:(\d+)/.exec(msg);
  if (lost) return loseClipsError(Number(lost[1]));
  if (/shots_changed/.test(msg)) return new ConflictError('The storyboard just changed. Reload and try again.', { code: 'shots_changed' });
  return err;
}

/**
 * The shot list from the latest script. Scenes whose visual and lines are
 * unchanged since their shots were planned keep those shots as they are
 * (still, clip, quality, seconds) without asking the model; only changed and
 * new scenes go to the smart model (one more call when its words trip the
 * regex moderation, or its seconds cannot add up). The list is swapped in
 * atomically by story_shots_replace. A rebuild that would remove shots with a
 * clip needs confirm: true (409 'rebuild_loses_clips' with the count).
 * Moves the project to the storyboard step. -> { shots }
 */
export async function buildShotList(args) {
  const taken = args.allowance;
  if (!taken) return buildShots(args);
  // taken: a shots_build count the caller already took (a queued MCP plan, lib/story/draftJobs.js). It is used
  // instead of a new count, so a retried plan never counts twice. A build that fails before the model is asked
  // gives it back, as on the website; a plan that needed no model call keeps it (it was taken before the scenes
  // were compared, and a retry after a saved plan must not give back the count its first run used).
  // A caller that passes its own `asked` (the drafting job) gives the count back itself, once, across retries.
  const owned = !args.asked;
  const asked = args.asked ?? { model: false };
  try {
    return await buildShots({ ...args, taken, asked });
  } catch (err) {
    if (owned && !asked.model) await releaseAllowance(taken).catch(() => {});
    throw err;
  }
}

async function buildShots({ userId, projectId, user, confirm = null, taken = null, asked: askedOut = null }) {
  const project = await getProject({ userId, id: projectId });
  await assertAllowed({ userId, action: 'stills_generate', projectId, user });
  await recoverStalledStills(projectId);

  const script = await latestScript(projectId);
  if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
    throw new ValidationError('Write the script first, then build the storyboard.', { field: 'script' });
  }
  const [cast, existing] = await Promise.all([
    storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' }),
    shotRows(projectId),
  ]);
  if (existing.some((s) => BUSY.includes(s.status))) throw new ConflictError(BUSY_MESSAGE, { code: 'shots_busy' });

  const sigs = new Map(script.scenes.map((s) => [s.id, sceneSig(s)]));
  const rowsOf = (sceneId) => existing.filter((r) => r.scene_id === sceneId);
  const unchanged = new Set(script.scenes.filter((s) => rowsOf(s.id).length && rowsOf(s.id).every((r) => r.scene_sig === sigs.get(s.id))).map((s) => s.id));
  const changedScenes = script.scenes.filter((s) => !unchanged.has(s.id));
  const replaced = existing.filter((r) => !unchanged.has(r.scene_id));
  const keptRows = (sceneId) => rowsOf(sceneId).map((r) => ({ keep: r }));
  const basis = planBasis(script, existing, project, cast);
  const stored = confirmedPlan(project, confirm, basis);
  let plan;
  let changed = changedScenes.length > 0;
  let allowedLoss = 0;
  if (stored) {
    // The customer confirmed this exact plan: apply it as it was, without asking the model or counting a build.
    plan = stored.plan;
    changed = stored.changed === true;
    allowedLoss = stored.count;
  } else {
    if (!changedScenes.length) {
      if (!replaced.length) {
        await clearSettledStale(projectId);
        return { shots: await shotsView(projectId) };
      }
      plan = script.scenes.flatMap((sc) => keptRows(sc.id).map(({ keep }) => ({ id: keep.id })));
    } else {
      const receipt = taken ?? await assertAllowed({ userId, action: 'shots_build', projectId, user });
      const asked = askedOut ?? { model: false };
      try {
        plan = await planChangedScenes({ project, script, cast, existing, changedScenes, unchanged, sigs, keptRows, asked });
      } catch (err) {
        // A build that reached the model counts, whatever its outcome; only one that never asked is given back
        // (a taken count by buildShotList's wrapper).
        if (!asked.model && !taken) await releaseAllowance(receipt).catch(() => {});
        throw err;
      }
    }
    // Clips the swap would really remove (the same keep rule as story_shots_replace), so nobody is asked about nothing.
    const keptIds = new Set(plan.filter((x) => x.id).map((x) => x.id));
    for (const m of matchExisting(plan.filter((x) => !x.id), replaced)) if (m) keptIds.add(m.id);
    const gone = existing.filter((r) => !keptIds.has(r.id));
    const lost = gone.filter((r) => r.clip_url).length;
    // A footage choice or a picture-in-picture is work too: a rebuild never drops one without asking.
    const lostOwn = gone.filter((r) => !r.clip_url && (r.source === 'footage' || r.inset_asset_id)).length;
    if (lost > 0 || lostOwn > 0) {
      // Keep the plan, so the confirm applies exactly what the customer was asked about.
      const token = randomUUID();
      await storyDb().update('story_projects', { id: projectId, user_id: userId }, {
        pending_shots: { token, plan, count: lost, own: lostOwn, changed }, pending_basis: basis, pending_at: new Date().toISOString(),
      });
      throw loseClipsError(lost, token, lostOwn);
    }
  }

  // A removal-only rebuild keeps the remaining shots as they are, so the total can drift from the length:
  // it is not blocked, but the answer says so (length_note).
  const range = changed ? secondsRange(project.seconds) : { min: null, max: null };
  try {
    await storyDb().rpc('story_shots_replace', { p_project: projectId, p_shots: plan, p_confirm: allowedLoss, p_min: range.min, p_max: range.max });
  } catch (err) {
    throw mapReplaceError(err);
  }
  if (project.pending_shots || project.pending_basis) {
    await storyDb().update('story_projects', { id: projectId, user_id: userId }, { pending_shots: null, pending_basis: null, pending_at: null });
  }
  await clearSettledStale(projectId);
  if (STEPS.indexOf(project.step) < STEPS.indexOf('storyboard')) {
    await storyDb().update('story_projects', { id: projectId, user_id: userId }, { step: 'storyboard' });
  }
  const shots = await shotsView(projectId);
  const totalSeconds = shots.reduce((n, r) => n + r.seconds, 0);
  const { min, max } = secondsRange(project.seconds);
  if (!changed && (totalSeconds < min || totalSeconds > max)) {
    return { shots, length_note: { totalSeconds, targetSeconds: project.seconds } };
  }
  return { shots };
}

/**
 * Shots planned from their scene as it is now are not stale, unless their clip
 * no longer matches their own description or still. The script is read again
 * here, right before the clear, so a scene edited while the build ran (its
 * signature moved on, markStale flagged its shots) keeps its stale flag.
 */
async function clearSettledStale(projectId) {
  const script = await latestScript(projectId);
  for (const scene of script?.scenes || []) {
    await storyDb().update('story_shots', { project_id: projectId, scene_id: scene.id, scene_sig: sceneSig(scene), stale: true, clip_mismatch: false }, { stale: false });
  }
}
export const _clearSettledStale = clearSettledStale;

/** Output budget for the shot plan: about 100 tokens a shot for MAX_SHOTS shots, with margin, so a 2 minute plan is never cut off. */
const SHOTS_MAX_TOKENS = Math.max(12000, MAX_SHOTS * 250);

/** Asks the model for the shots of the changed scenes and returns the whole list for story_shots_replace. */
async function planChangedScenes({ project, script, cast, existing, changedScenes, unchanged, sigs, keptRows, asked = {} }) {
  const castByName = new Map(cast.map((c) => [c.name.toLowerCase(), c.id]));
  const castName = new Map(cast.map((c) => [c.id, c.name]));
  const sceneIds = new Set(changedScenes.map((s) => s.id));
  const target = project.seconds;
  const keptSeconds = existing.filter((r) => unchanged.has(r.scene_id)).reduce((n, r) => n + r.seconds, 0);
  const budget = Math.max(MIN_SHOT_SECONDS * changedScenes.length, target - keptSeconds);
  const current = existing.filter((r) => sceneIds.has(r.scene_id)).map((s) => ({
    sceneId: s.scene_id, description: s.description, line: s.line || '', seconds: s.seconds, cast: (s.cast_ids || []).map((id) => castName.get(id)).filter(Boolean),
  }));

  const system = buildShotsSystem({ seconds: budget });
  const messages = [{ role: 'user', content: buildShotsMessage({ scenes: changedScenes, seconds: budget, cast, current }) }];
  let extra = null;
  let lastProblem = 'failed';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    asked.model = true;
    const answer = await completeJSON({
      name: 'story_shots', tier: 'smart', system: extra ? `${system}\n\n${extra}` : system, messages, schema: SHOTS_SCHEMA, maxTokens: SHOTS_MAX_TOKENS,
    });
    const shots = normalizeShots(answer, { sceneIds, castByName });
    if (!shots.length) throw new StoryError(FAILED_MESSAGE, { status: 502, code: 'shots_failed' });
    try {
      for (const s of shots) screenTextRegex([s.description, s.line || '']);
    } catch (err) {
      if (!(err instanceof ModerationError)) throw err;
      extra = FAMILY_FRIENDLY_GUIDANCE;
      lastProblem = 'blocked';
      continue;
    }
    // The whole list in script order: kept rows of unchanged scenes, then the model's shots of each changed scene.
    const replacedRows = existing.filter((r) => sceneIds.has(r.scene_id));
    const matches = matchExisting(shots, replacedRows);
    const ordered = script.scenes.flatMap((scene) => {
      if (unchanged.has(scene.id)) return keptRows(scene.id);
      return shots.map((s, i) => ({ shot: s, match: matches[i] })).filter((x) => x.shot.sceneId === scene.id);
    });
    const seconds = fitSeconds(ordered.map((x) => (x.keep ? { seconds: x.keep.seconds, fixed: true } : x.match ? { seconds: x.match.seconds, fixed: true } : { seconds: x.shot.seconds })), target);
    if (!seconds || changedScenes.some((sc) => !shots.some((s) => s.sceneId === sc.id))) {
      lastProblem = 'failed';
      messages.push({ role: 'assistant', content: JSON.stringify(answer) }, { role: 'user', content: buildSecondsRetryMessage(budget) });
      continue;
    }
    return ordered.map((x, i) => (x.keep
      ? { id: x.keep.id }
      : { sceneId: x.shot.sceneId, sceneSig: sigs.get(x.shot.sceneId), description: x.shot.description, line: x.shot.line, seconds: seconds[i], quality: project.quality, castIds: x.shot.castIds }));
  }
  if (lastProblem === 'blocked') throw new StoryError(BLOCKED_MESSAGE, { status: 422, code: 'shots_blocked' });
  throw new StoryError(FAILED_MESSAGE, { status: 502, code: 'shots_failed' });
}

/** The shots, in order, with retry_credits. -> { shots } */
export async function listShots({ userId, projectId }) {
  await getProject({ userId, id: projectId });
  await recoverStalledStills(projectId);
  return { shots: await shotsView(projectId) };
}

/** Flags the shots of these scenes stale (called after a script change). -> updated rows */
export async function markStale({ projectId, sceneIds }) {
  if (!projectId || !Array.isArray(sceneIds) || !sceneIds.length) return [];
  const script = await latestScript(projectId);
  const sigs = new Map((script?.scenes || []).map((sc) => [sc.id, sceneSig(sc)]));
  const rows = await storyDb().select('story_shots', { project_id: projectId, scene_id: sceneIds.map(String) });
  const changed = rows.filter((r) => r.scene_sig !== sigs.get(r.scene_id));
  // A scene edited back to what its shots were planned from (A to B to A) is not stale any more,
  // unless the clip no longer matches the shot itself.
  const back = rows.filter((r) => r.stale && r.scene_sig === sigs.get(r.scene_id) && !r.clip_mismatch);
  const out = [];
  if (changed.length) out.push(...await storyDb().update('story_shots', { id: changed.map((r) => r.id) }, { stale: true }));
  if (back.length) out.push(...await storyDb().update('story_shots', { id: back.map((r) => r.id) }, { stale: false }));
  return out;
}

onScenesChanged(markStale);

// ---------------------------------------------------------------- stills

/** References for one shot: up to MAX_CAST_REFS cast sheets (or picks), then the product photo. */
async function stillRefs(project, shot, castById, product) {
  const people = [];
  for (const id of shot.cast_ids || []) {
    const c = castById.get(id);
    const url = c?.sheet?.url || c?.image_url;
    if (url) people.push({ name: c.name, url });
    if (people.length === MAX_CAST_REFS) break;
  }
  const refs = people.map((p) => p.url);
  if (product) refs.push(product);
  return { refs, castNames: people.map((p) => p.name), product: Boolean(product) };
}

/** The first product photo attached to the project (owned by the project's owner), or null. */
async function productPhoto(project) {
  const links = await storyDb().select('story_project_assets', { project_id: project.id, role: 'product' }, { order: 'created_at' });
  if (!links.length) return null;
  const assets = await storyDb().select('story_assets', { id: links.map((l) => l.asset_id), user_id: project.user_id });
  for (const link of links) {
    const asset = assets.find((a) => a.id === link.asset_id);
    // Only a picture is a reference (a link to anything else, from an older version, is skipped).
    if (asset?.url && IMAGE_DB_KINDS.includes(asset.kind)) return asset.url;
  }
  return null;
}

function cleanShotIds(shotIds) {
  if (shotIds === undefined || shotIds === null) return null;
  if (!Array.isArray(shotIds) || shotIds.length > 100 || shotIds.some((id) => typeof id !== 'string')) {
    throw new ValidationError('Say which shots.', { field: 'shotIds' });
  }
  return [...new Set(shotIds)];
}

/**
 * Claims one shot, holds its price, queues its job. -> 'queued' | 'busy' |
 * 'insufficient'. Any failure after the claim releases the hold (logged if
 * that fails too) and puts the row back, then rethrows.
 */
async function startStill({ project, shot, cost, payload }) {
  const holdId = cost.credits > 0 ? randomUUID() : null;
  const round = shot.still_round + 1;
  const [claimed] = await storyDb().rpc('story_shot_claim', {
    p_project: project.id, p_shot: shot.id, p_round: shot.still_round, p_status: shot.status,
    p_description: shot.description, p_hold: holdId, p_now: new Date().toISOString(),
  });
  if (!claimed) return 'busy';
  try {
    if (holdId) await deps.holdCredits({ userId: project.user_id, currency: 'video', amount: cost.credits, projectId: project.id, holdId });
    // A claim reset as stalled meanwhile is not ours any more.
    const [mine] = await storyDb().select('story_shots', { id: shot.id, still_round: round, status: 'still_pending' });
    if (!mine || (mine.still_hold_id ?? null) !== holdId) {
      if (holdId) await releaseHold({ holdId }).catch((e) => console.error('[story] still hold release failed', holdId, e?.message));
      return 'busy';
    }
    await deps.enqueue({
      projectId: project.id,
      shotId: shot.id,
      kind: 'still',
      payload: { shotId: shot.id, round, kind: cost.kind, credits: cost.credits, ...payload },
      holdId,
      costCredits: holdId ? cost.credits : null,
    });
  } catch (err) {
    if (holdId) {
      await releaseHold({ holdId }).catch((e) => console.error('[story] still hold release failed', holdId, e?.message));
    }
    await storyDb().update(
      'story_shots',
      { id: shot.id, still_round: round, status: 'still_pending', still_hold_id: holdId },
      restorePatch(claimed)
    ).catch((e) => console.error('[story] could not put a shot back after a failed start', shot.id, e?.message));
    if (err instanceof InsufficientCreditsError) return 'insufficient';
    throw err;
  }
  await storyDb().update('story_shots', { id: shot.id, still_round: round }, { still_hold_id: null, still_claimed_at: null, still_prev: null })
    .catch((e) => console.error('[story] could not clear a still claim', shot.id, e?.message));
  return 'queued';
}

/**
 * Starts one still per shot. shotIds omitted: every generated shot with no
 * still that is not busy. Footage shots get no still. retry: true is the
 * customer's Try again after a provider failure (see stillAttemptCost).
 * Each shot stands on its own: the ones that can start are queued, the rest
 * are refused with a reason ('footage', 'busy', 'retry_not_available',
 * 'insufficient_credits', 'failed'). Only when nothing could start is it an
 * error (402, 409, or the failure itself).
 * expectedCredits (optional): the price the customer was shown for these
 * shots (the sum of their still_credits, or of their Try again price with
 * retry). A different price is 409 quote_changed { credits } and nothing starts.
 * -> { shots, charged, queued: [shotId], refused: [{ shotId, reason }] }
 */
export async function generateStills({ userId, projectId, shotIds, retry = false, user, expectedCredits }) {
  const project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  const ids = cleanShotIds(shotIds);
  await assertAllowed({ userId, action: 'stills_generate', projectId, user });
  await recoverStalledStills(projectId);

  const all = await shotRows(projectId);
  let targets;
  if (ids) {
    targets = ids.map((id) => {
      const row = all.find((s) => s.id === id);
      if (!row) throw new NotFoundError('Shot not found.');
      return row;
    });
  } else {
    // Blocked shots are left out: they need a new description first.
    targets = all.filter((s) => !s.still_url && s.status !== 'blocked' && STILL_STARTABLE.includes(s.status));
  }

  const [jobsByShot, pricing, balance] = await Promise.all([stillJobsByShot(projectId), getPricing(), getBalance(userId, 'video')]);
  let available = balance.available;
  if (expectedCredits !== undefined && expectedCredits !== null) {
    if (!Number.isInteger(expectedCredits) || expectedCredits < 0) {
      throw new ValidationError('The price must be a whole number of credits.', { field: 'expected_credits' });
    }
    // The same price rules the loop below charges by, for the shots that can start.
    let price = 0;
    for (const shot of targets) {
      if (shot.source === 'footage' || !STILL_STARTABLE.includes(shot.status)) continue;
      try {
        price += stillAttemptCost({ shot, jobs: jobsByShot.get(shot.id) || [], retry, pricing }).credits;
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    }
    if (price !== expectedCredits) {
      throw new ConflictError(`Making ${targets.length === 1 ? 'this picture' : 'these pictures'} now costs ${price} credits. Check it and try again.`, { code: 'quote_changed', credits: price });
    }
  }
  const style = styleFragment(project);
  const castRows = await storyDb().select('story_cast', { project_id: projectId });
  const castById = new Map(castRows.map((c) => [c.id, c]));
  let product;

  const queued = [];
  const refused = [];
  let charged = 0;
  let retryError = null;
  let failure = null;
  let shortOf = null;
  for (const shot of targets) {
    if (shot.source === 'footage') {
      refused.push({ shotId: shot.id, reason: 'footage' });
      continue;
    }
    if (!STILL_STARTABLE.includes(shot.status)) {
      refused.push({ shotId: shot.id, reason: 'busy' });
      continue;
    }
    const jobs = jobsByShot.get(shot.id) || [];
    let cost;
    try {
      cost = stillAttemptCost({ shot, jobs, retry, pricing });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      retryError ||= err;
      refused.push({ shotId: shot.id, reason: 'retry_not_available' });
      continue;
    }
    if (cost.credits > available) {
      shortOf = shortOf === null ? cost.credits : Math.min(shortOf, cost.credits);
      refused.push({ shotId: shot.id, reason: 'insufficient_credits' });
      continue;
    }

    let payload;
    if (cost.kind === 'retry') {
      const failed = jobs[jobs.length - 1].payload;
      payload = { prompt: failed.prompt, refs: failed.refs || [], aspect: failed.aspect || project.aspect };
    } else {
      if (product === undefined) product = await productPhoto(project);
      const r = await stillRefs(project, shot, castById, product);
      payload = { prompt: stillPrompt({ style, description: shot.description, castNames: r.castNames, product: r.product, aspect: project.aspect }), refs: r.refs, aspect: project.aspect };
    }

    let outcome;
    try {
      outcome = await startStill({ project, shot, cost, payload });
    } catch (err) {
      console.error('[story] could not start a still', shot.id, err?.message);
      failure = err;
      refused.push({ shotId: shot.id, reason: 'failed' });
      continue;
    }
    if (outcome === 'queued') {
      queued.push(shot.id);
      charged += cost.credits;
      available -= cost.credits;
    } else if (outcome === 'insufficient') {
      shortOf = shortOf === null ? cost.credits : Math.min(shortOf, cost.credits);
      refused.push({ shotId: shot.id, reason: 'insufficient_credits' });
    } else {
      refused.push({ shotId: shot.id, reason: 'busy' });
    }
  }

  if (!queued.length) {
    if (shortOf !== null) throw new InsufficientCreditsError(shortOf, Math.max(0, available));
    if (failure) throw failure;
    if (retryError) throw retryError;
    if (refused.some((r) => r.reason === 'busy')) throw new ConflictError('The picture for this shot is still being made. Wait for it to finish.');
  }
  return { shots: await shotsView(projectId), charged, queued, refused };
}

// ---------------------------------------------------------------- edits

/**
 * The shot's clip was made at this quality, from this description and still,
 * at the generated seconds the shot has now: -> { stale } (stale only when the
 * scene changed since), else null. Reads the clip job that delivered the clip.
 */
async function clipMatchesAgain(projectId, shot, quality) {
  const jobs = await storyDb().select('story_jobs', { project_id: projectId, shot_id: shot.id, kind: 'clip', status: 'done' }, { order: ['-created_at', '-id'], limit: 50 });
  const job = jobs.find((j) => j.result?.key && j.result.key === shot.clip_key);
  const p = job?.payload;
  if (!p || p.quality !== quality || p.description !== shot.description || (p.stillKey ?? null) !== (shot.still_key ?? null)) return null;
  const pricing = await getPricing();
  if (Number(p.seconds) !== generatedSeconds(pricing, quality, shot.seconds)) return null;
  const script = await latestScript(projectId);
  const scene = (script?.scenes || []).find((sc) => sc.id === shot.scene_id);
  return { stale: !scene || sceneSig(scene) !== shot.scene_sig };
}

const PATCH_KEYS = ['description', 'quality', 'source', 'footage_asset_id', 'footage', 'inset_asset_id', 'inset'];
const MEDIA_KEYS = ['source', 'footage_asset_id', 'footage', 'inset_asset_id', 'inset'];
const FOOTAGE_FITS = ['cover', 'contain'];
const FOOTAGE_DEFAULT = Object.freeze({ trimStart: 0, fit: 'contain' });
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A footage option set { trimStart (seconds), fit } on top of the current one; footage is fitted (letterboxed) unless the customer asks to fill the frame. */
function cleanFootage(value, current, clip) {
  if (!isPlain(value)) throw new ValidationError('Say where in the clip to start, and how to fit it.', { field: 'footage' });
  const bad = Object.keys(value).find((k) => k !== 'trimStart' && k !== 'fit');
  if (bad) throw new ValidationError(`${bad} cannot be set on footage.`, { field: 'footage' });
  const base = isPlain(current) ? current : FOOTAGE_DEFAULT;
  const out = { trimStart: Number.isFinite(Number(base.trimStart)) ? Number(base.trimStart) : 0, fit: FOOTAGE_FITS.includes(base.fit) ? base.fit : 'contain' };
  if ('trimStart' in value) {
    const t = value.trimStart;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new ValidationError('Start the clip at 0 seconds or later.', { field: 'footage' });
    if (Number.isFinite(Number(clip?.duration_seconds)) && Number(clip.duration_seconds) > 0 && t >= Number(clip.duration_seconds)) {
      throw new ValidationError(`This clip is ${Math.floor(Number(clip.duration_seconds))} seconds long. Start it earlier.`, { field: 'footage' });
    }
    out.trimStart = Math.round(t * 100) / 100;
  }
  if ('fit' in value) {
    if (!FOOTAGE_FITS.includes(value.fit)) throw new ValidationError('Fit the clip to the frame (contain) or fill the frame (cover).', { field: 'footage' });
    out.fit = value.fit;
  }
  return out;
}

/**
 * A picture-in-picture placement. The customer's numbers are percent of the frame (x and y: where its centre sits, w: its
 * width); a shot stores them as fractions (0 to 1), which is what the render reads. Left-out numbers keep the current value.
 */
function cleanInset(value, current) {
  if (!isPlain(value)) throw new ValidationError('Say where the picture-in-picture goes.', { field: 'inset' });
  const bad = Object.keys(value).find((k) => !['x', 'y', 'w'].includes(k));
  if (bad) throw new ValidationError(`${bad} cannot be set on a picture-in-picture.`, { field: 'inset' });
  const cur = isPlain(current) ? current : {};
  const out = {};
  for (const k of ['x', 'y', 'w']) {
    const percent = k in value ? value[k] : Number.isFinite(Number(cur[k])) && cur[k] > 0 && cur[k] < 1 ? cur[k] * 100 : INSET_DEFAULT[k];
    const [min, max] = k === 'w' ? [INSET_RANGE.wMin, INSET_RANGE.wMax] : [INSET_RANGE.min, INSET_RANGE.max];
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < min || percent > max) {
      throw new ValidationError(`${k === 'w' ? 'The width' : k === 'x' ? 'The left to right place' : 'The top to bottom place'} must be ${min} to ${max} percent.`, { field: 'inset' });
    }
    out[k] = Math.round(percent * 100) / 10000;
  }
  return out;
}

/** The part of a shot patch about the customer's own footage and picture-in-picture. -> the columns to change */
async function mediaChanges({ userId, shot, patch }) {
  const next = {};
  const source = 'source' in patch ? patch.source : shot.source;
  if (source !== 'generated' && source !== 'footage') throw new ValidationError('A shot is generated or uses your own footage.', { field: 'source' });
  if (source === 'footage') {
    const id = 'footage_asset_id' in patch ? patch.footage_asset_id : shot.footage_asset_id;
    const clip = await ownedAsset(userId, id);
    // Another customer's file is a missing one, the same answer.
    if (!clip) throw new NotFoundError(ASSET_MESSAGES.notFound);
    if (!VIDEO_DB_KINDS.includes(clip.kind)) throw new ValidationError(ASSET_MESSAGES.footage, { field: 'footage_asset_id' });
    const sameClip = id === shot.footage_asset_id;
    next.source = 'footage';
    // Flags left from the shot's generated state (an old clip, a changed face) say nothing about a clip of the customer's own.
    if (shot.source !== 'footage') Object.assign(next, { stale: false, clip_mismatch: false });
    next.footage_asset_id = clip.id;
    next.footage = cleanFootage('footage' in patch ? patch.footage : {}, sameClip ? shot.footage : null, clip);
  } else {
    if ((patch.footage_asset_id ?? null) !== null || ('footage' in patch && patch.footage !== null)) {
      throw new ValidationError('Switch the shot to your own footage first, then pick the clip.', { field: 'footage_asset_id' });
    }
    if (shot.source === 'footage') Object.assign(next, { source: 'generated', footage_asset_id: null, footage: null });
  }

  if ('inset_asset_id' in patch || 'inset' in patch) {
    const id = 'inset_asset_id' in patch ? patch.inset_asset_id : shot.inset_asset_id;
    if (id === null || id === undefined) {
      if ('inset' in patch && patch.inset !== null) throw new ValidationError('Pick the picture or clip first, then place it.', { field: 'inset' });
      Object.assign(next, { inset_asset_id: null, inset: null });
    } else {
      const file = await ownedAsset(userId, id);
      if (!file) throw new NotFoundError(ASSET_MESSAGES.notFound);
      if (![...IMAGE_DB_KINDS, ...VIDEO_DB_KINDS].includes(file.kind)) throw new ValidationError(ASSET_MESSAGES.inset, { field: 'inset_asset_id' });
      next.inset_asset_id = file.id;
      next.inset = cleanInset('inset' in patch ? patch.inset : {}, file.id === shot.inset_asset_id ? shot.inset : null);
    }
  }
  return next;
}

/**
 * Changes one shot. description: a new picture is needed, so the still is
 * cleared (status 'draft', a new still_round) and a clip, if any, is kept but
 * marked stale. quality: the price changes, and a clip, if any, is kept but
 * marked stale and mismatched (it was made at the old quality); changing back
 * to the clip's own quality clears that again. -> { shot }
 */
export async function updateShot({ userId, projectId, shotId, patch }) {
  await getProject({ userId, id: projectId });
  await recoverStalledStills(projectId);
  const shot = await getShot(projectId, shotId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new ValidationError('Say what to change.', { field: 'patch' });
  }
  const bad = Object.keys(patch).find((k) => !PATCH_KEYS.includes(k));
  if (bad) throw new ValidationError(`${bad} cannot be changed here.`, { field: bad });
  if (BUSY.includes(shot.status)) {
    throw new ConflictError('This shot is still being made. Wait for it to finish, then change it.');
  }

  const next = {};
  if (MEDIA_KEYS.some((k) => k in patch)) Object.assign(next, await mediaChanges({ userId, shot, patch }));
  if ('quality' in patch) {
    if (!QUALITIES.includes(patch.quality)) throw new ValidationError('Choose one of the quality levels.', { field: 'quality' });
    if (patch.quality !== shot.quality) {
      next.quality = patch.quality;
      // The clip was made at the old quality: it is made again (and paid) through Generate. Going back to the
      // quality the clip was made at (with the same description and still) makes it current again.
      if (shot.clip_url) {
        const back = await clipMatchesAgain(projectId, shot, patch.quality);
        Object.assign(next, back ? { stale: back.stale, clip_mismatch: false } : { stale: true, clip_mismatch: true });
      }
    }
  }
  if ('description' in patch) {
    if (typeof patch.description !== 'string') throw new ValidationError('Describe the shot in a few words.', { field: 'description' });
    const text = patch.description.replace(/\s+/g, ' ').trim();
    if (!text) throw new ValidationError('Describe the shot in a few words.', { field: 'description' });
    if (text.length > MAX_SHOT_DESCRIPTION) throw new ValidationError(`Keep the description to ${MAX_SHOT_DESCRIPTION} characters or fewer.`, { field: 'description' });
    if (text !== shot.description) {
      await screenText([text]);
      Object.assign(next, {
        description: text,
        still_url: null,
        still_key: null,
        still_round: shot.still_round + 1,
        still_base_round: shot.still_round + 1,
        status: 'draft',
        error: null,
        stale: shot.clip_url ? true : shot.stale,
        clip_mismatch: shot.clip_url ? true : shot.clip_mismatch,
      });
    }
  }
  if (!Object.keys(next).length) return { shot };

  const [saved] = await storyDb().update(
    'story_shots',
    { id: shot.id, project_id: projectId, status: shot.status, still_round: shot.still_round },
    next
  );
  if (!saved) throw new ConflictError('This shot just changed. Reload and try again.');
  return { shot: saved };
}

// ---------------------------------------------------------------- HTTP actions

// GET   /api/story/projects/[id]/shots   -> { shots }
// POST  /api/story/projects/[id]/shots   { confirm?: token } -> { shots, length_note? }   build or rebuild the shot list (own route file: maxDuration);
//       length_note { totalSeconds, targetSeconds } when a removal-only rebuild left the total outside 10% of the length
// POST  /api/story/projects/[id]/stills  { shotIds?, retry? } -> { shots, charged, queued, refused }
// PATCH /api/story/projects/[id]/shot    { shotId, patch: { description?, quality?, source?, footage_asset_id?, footage?, inset_asset_id?, inset? } } -> { shot }
//       source 'footage' + footage_asset_id (one of the customer's clips) + footage { trimStart, fit: 'contain' | 'cover' } uses the
//       customer's own clip instead of a generated one (nothing is generated or charged for it); inset_asset_id (a picture or clip of
//       theirs, null to remove) + inset { x, y, w } in percent of the frame puts it over the shot. The row keeps its scene_sig.
// Every shot in a response carries retry_credits (what Try again costs now, null when not available) and
// still_credits (what a normal make costs now, null for footage).
export const listShotsAction = async ({ userId, projectId }) => listShots({ userId, projectId });
export const buildShotsAction = async ({ userId, user, projectId, body = {} }) =>
  buildShotList({ userId, projectId, user, confirm: typeof body.confirm === 'string' ? body.confirm : null });
export const stillsAction = async ({ userId, user, projectId, body = {} }) =>
  generateStills({ userId, projectId, shotIds: body.shotIds, retry: body.retry === true, user, expectedCredits: body.expected_credits });
export const updateShotAction = async ({ userId, projectId, body = {} }) => {
  if (typeof body.shotId !== 'string' || !body.shotId) throw new ValidationError('Say which shot.', { field: 'shotId' });
  return updateShot({ userId, projectId, shotId: body.shotId, patch: body.patch });
};

registerAction('shots', { method: 'GET', handler: listShotsAction });
registerAction('shots', { method: 'POST', handler: buildShotsAction });
registerAction('stills', { method: 'POST', handler: stillsAction });
registerAction('shot', { method: 'PATCH', handler: updateShotAction });
