import { randomUUID } from 'node:crypto';
import { completeJSON } from '../providers/llm.js';
import { QUALITIES } from '../providers/video.js';
import { ModerationError, screenText, screenTextRegex } from '../moderation.js';
import { getBalance, holdCredits, InsufficientCreditsError, releaseHold } from '../credits.js';
import { getPricing } from '../pricing.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, StoryError, ValidationError } from './errors.js';
import { getProject, STEPS } from './projects.js';
import { assertAllowed } from './limits.js';
import { registerAction } from './actions.js';
import { enqueue } from './runner.js';
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
 *   list) no longer matches the script or the description. clip_url is kept;
 *   making a new clip clears stale.
 *
 * Money (lib/pricing.js is the only source of numbers), in stillAttemptCost:
 *   - a shot's first still is free (until a still has been delivered for it);
 *   - every later still is a re-roll and costs pricing.stillReroll, held up
 *     front and settled by the runner when the picture arrives (released if
 *     it fails);
 *   - a retry (`retry: true`) is allowed only when the shot's last still
 *     attempt failed at the provider. It costs what that attempt cost (a
 *     failed re-roll was refunded, so it is held again; a failed free first
 *     still is retried free): a retry never charges twice, and never counts
 *     as the free first still.
 * stills_generate needs a paid plan (lib/story/limits.js); building the shot
 * list uses the same gate, since it asks the smart model.
 */

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
    const last = jobs[jobs.length - 1];
    if (!last || last.status !== 'failed' || last.payload?.round !== shot.still_round) {
      throw new ConflictError('There is nothing to try again for this shot. Make the picture again instead.', { code: 'retry_not_available' });
    }
    const credits = Number(last.payload?.credits ?? last.cost_credits ?? 0) || 0;
    return { credits, kind: 'retry' };
  }
  const delivered = jobs.some((j) => j.status === 'done');
  return delivered ? { credits: pricing.stillReroll, kind: 'reroll' } : { credits: 0, kind: 'first' };
}

/** The price of a Try again on this shot right now, or null when it cannot be retried. */
function retryCredits(shot, jobs) {
  try {
    return stillAttemptCost({ shot, jobs, retry: true, pricing: { stillReroll: 0 } }).credits;
  } catch {
    return null;
  }
}

/** The shots as the screen reads them: rows plus retry_credits. */
async function shotsView(projectId) {
  const [rows, jobs] = await Promise.all([shotRows(projectId), stillJobsByShot(projectId)]);
  return rows.map((row) => ({ ...row, retry_credits: retryCredits(row, jobs.get(row.id) || []) }));
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

/**
 * The shot list from the latest script: one smart model call (one more when
 * its words trip the regex moderation, or its seconds cannot add up), then the
 * list is swapped in atomically by story_shots_replace. Shots whose scene,
 * description and line are unchanged keep their row (still, clip, quality,
 * seconds). Moves the project to the storyboard step. -> { shots }
 */
export async function buildShotList({ userId, projectId, user }) {
  const project = await getProject({ userId, id: projectId });
  await assertAllowed({ userId, action: 'stills_generate', projectId, user });

  const script = await latestScript(projectId);
  if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
    throw new ValidationError('Write the script first, then build the storyboard.', { field: 'script' });
  }
  const [cast, existing] = await Promise.all([
    storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' }),
    shotRows(projectId),
  ]);
  if (existing.some((s) => BUSY.includes(s.status))) {
    throw new ConflictError('Some pictures or clips are still being made. Wait for them to finish, then rebuild the storyboard.', { code: 'shots_busy' });
  }
  const castByName = new Map(cast.map((c) => [c.name.toLowerCase(), c.id]));
  const castName = new Map(cast.map((c) => [c.id, c.name]));
  const sceneIds = new Set(script.scenes.map((s) => s.id));
  const target = project.seconds;

  const system = buildShotsSystem({ seconds: target });
  const current = existing.map((s) => ({
    sceneId: s.scene_id, description: s.description, line: s.line || '', seconds: s.seconds, cast: (s.cast_ids || []).map((id) => castName.get(id)).filter(Boolean),
  }));
  const messages = [{ role: 'user', content: buildShotsMessage({ scenes: script.scenes, seconds: target, cast, current }) }];

  let extra = null;
  let lastProblem = 'failed';
  let plan = null;
  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    const answer = await completeJSON({
      name: 'story_shots', tier: 'smart', system: extra ? `${system}\n\n${extra}` : system, messages, schema: SHOTS_SCHEMA, maxTokens: 4000,
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
    const matches = matchExisting(shots, existing);
    const seconds = fitSeconds(shots.map((s, i) => (matches[i] ? { seconds: matches[i].seconds, fixed: true } : { seconds: s.seconds })), target);
    if (!seconds) {
      lastProblem = 'failed';
      messages.push({ role: 'assistant', content: JSON.stringify(answer) }, { role: 'user', content: buildSecondsRetryMessage(target) });
      continue;
    }
    plan = shots.map((s, i) => ({ ...s, seconds: seconds[i], quality: project.quality }));
  }
  if (!plan) {
    if (lastProblem === 'blocked') throw new StoryError(BLOCKED_MESSAGE, { status: 422, code: 'shots_blocked' });
    throw new StoryError(FAILED_MESSAGE, { status: 502, code: 'shots_failed' });
  }

  try {
    await storyDb().rpc('story_shots_replace', { p_project: projectId, p_shots: plan });
  } catch (err) {
    if (/shots_busy/.test(err?.message || '')) {
      throw new ConflictError('Some pictures or clips are still being made. Wait for them to finish, then rebuild the storyboard.', { code: 'shots_busy' });
    }
    throw err;
  }
  if (STEPS.indexOf(project.step) < STEPS.indexOf('storyboard')) {
    await storyDb().update('story_projects', { id: projectId, user_id: userId }, { step: 'storyboard' });
  }
  return { shots: await shotsView(projectId) };
}

/** The shots, in order, with retry_credits. -> { shots } */
export async function listShots({ userId, projectId }) {
  await getProject({ userId, id: projectId });
  return { shots: await shotsView(projectId) };
}

/** Flags the shots of these scenes stale (called after a script change). -> updated rows */
export async function markStale({ projectId, sceneIds }) {
  if (!projectId || !Array.isArray(sceneIds) || !sceneIds.length) return [];
  return storyDb().update('story_shots', { project_id: projectId, scene_id: sceneIds.map(String) }, { stale: true });
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
    if (asset?.url) return asset.url;
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
 * Starts one still per shot. shotIds omitted: every generated shot with no
 * still that is not busy. Footage shots get no still. retry: true is the
 * customer's Try again after a provider failure (see stillAttemptCost).
 * Paid attempts are all-or-nothing on credits: 402 before anything starts.
 * -> { shots, charged, queued: [shotId], skipped: [{ shotId, reason }] }
 */
export async function generateStills({ userId, projectId, shotIds, retry = false, user }) {
  const project = await getProject({ userId, id: projectId });
  const ids = cleanShotIds(shotIds);
  await assertAllowed({ userId, action: 'stills_generate', projectId, user });

  const all = await shotRows(projectId);
  let targets;
  if (ids) {
    targets = ids.map((id) => {
      const row = all.find((s) => s.id === id);
      if (!row) throw new NotFoundError('Shot not found.');
      return row;
    });
  } else {
    targets = all.filter((s) => !s.still_url && STILL_STARTABLE.includes(s.status));
  }

  const skipped = [];
  const busy = [];
  const work = [];
  const [jobsByShot, pricing] = await Promise.all([stillJobsByShot(projectId), getPricing()]);
  let firstRetryError = null;
  for (const shot of targets) {
    if (shot.source === 'footage') {
      skipped.push({ shotId: shot.id, reason: 'footage' });
      continue;
    }
    if (!STILL_STARTABLE.includes(shot.status)) {
      busy.push(shot.id);
      skipped.push({ shotId: shot.id, reason: 'busy' });
      continue;
    }
    const jobs = jobsByShot.get(shot.id) || [];
    try {
      work.push({ shot, jobs, ...stillAttemptCost({ shot, jobs, retry, pricing }) });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      firstRetryError ||= err;
      skipped.push({ shotId: shot.id, reason: 'retry_not_available' });
    }
  }
  if (!work.length && firstRetryError) throw firstRetryError;
  if (!work.length && busy.length) {
    throw new ConflictError('The picture for this shot is still being made. Wait for it to finish.');
  }

  const total = work.reduce((n, w) => n + w.credits, 0);
  if (total > 0) {
    const { available } = await getBalance(userId, 'video');
    if (available < total) throw new InsufficientCreditsError(total, available);
  }

  const style = styleFragment(project);
  const castRows = await storyDb().select('story_cast', { project_id: projectId });
  const castById = new Map(castRows.map((c) => [c.id, c]));
  const product = work.some((w) => w.kind !== 'retry') ? await productPhoto(project) : null;

  const queued = [];
  let charged = 0;
  for (const w of work) {
    const { shot } = w;
    let payload;
    if (w.kind === 'retry') {
      const failed = w.jobs[w.jobs.length - 1].payload;
      payload = { prompt: failed.prompt, refs: failed.refs || [], aspect: failed.aspect || project.aspect };
    } else {
      const r = await stillRefs(project, shot, castById, product);
      payload = { prompt: stillPrompt({ style, description: shot.description, castNames: r.castNames, product: r.product, aspect: project.aspect }), refs: r.refs, aspect: project.aspect };
    }

    let holdId = null;
    if (w.credits > 0) {
      holdId = randomUUID();
      await holdCredits({ userId, currency: 'video', amount: w.credits, projectId, holdId });
    }
    const round = shot.still_round + 1;
    const [claimed] = await storyDb().update(
      'story_shots',
      { id: shot.id, project_id: projectId, still_round: shot.still_round, status: shot.status, description: shot.description },
      { status: 'still_pending', still_round: round, error: null, stale: shot.clip_url ? true : shot.stale }
    );
    if (!claimed) {
      if (holdId) await releaseHold({ holdId }).catch(() => {});
      busy.push(shot.id);
      skipped.push({ shotId: shot.id, reason: 'busy' });
      continue;
    }
    try {
      await enqueue({
        projectId,
        shotId: shot.id,
        kind: 'still',
        payload: { shotId: shot.id, round, kind: w.kind, credits: w.credits, ...payload },
        holdId,
        costCredits: holdId ? w.credits : null,
      });
    } catch (err) {
      if (holdId) await releaseHold({ holdId }).catch(() => {});
      await storyDb().update('story_shots', { id: shot.id, still_round: round, status: 'still_pending' }, { status: shot.status, error: shot.error }).catch(() => {});
      throw err;
    }
    queued.push(shot.id);
    charged += w.credits;
  }
  if (!queued.length && busy.length && !skipped.some((s) => s.reason === 'footage')) {
    throw new ConflictError('The picture for this shot is still being made. Wait for it to finish.');
  }
  return { shots: await shotsView(projectId), charged, queued, skipped };
}

// ---------------------------------------------------------------- edits

const PATCH_KEYS = ['description', 'quality'];

/**
 * Changes one shot. description: a new picture is needed, so the still is
 * cleared (status 'draft', a new still_round) and a clip, if any, is kept but
 * marked stale. quality: only the price changes. -> { shot }
 */
export async function updateShot({ userId, projectId, shotId, patch }) {
  await getProject({ userId, id: projectId });
  const shot = await getShot(projectId, shotId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new ValidationError('Say what to change.', { field: 'patch' });
  }
  const bad = Object.keys(patch).find((k) => !PATCH_KEYS.includes(k));
  if (bad) throw new ValidationError(`${bad} cannot be changed here.`, { field: bad });

  const next = {};
  if ('quality' in patch) {
    if (!QUALITIES.includes(patch.quality)) throw new ValidationError('Choose one of the quality levels.', { field: 'quality' });
    if (patch.quality !== shot.quality) next.quality = patch.quality;
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
        status: 'draft',
        error: null,
        stale: shot.clip_url ? true : shot.stale,
      });
    }
  }
  if (BUSY.includes(shot.status)) {
    throw new ConflictError('This shot is still being made. Wait for it to finish, then change it.');
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
// POST  /api/story/projects/[id]/shots   -> { shots }      build or rebuild the shot list (own route file: maxDuration)
// POST  /api/story/projects/[id]/stills  { shotIds?, retry? } -> { shots, charged, queued, skipped }
// PATCH /api/story/projects/[id]/shot    { shotId, patch: { description?, quality? } } -> { shot }
// Every shot in a response carries retry_credits: what Try again costs now, or null when it is not available.
export const listShotsAction = async ({ userId, projectId }) => listShots({ userId, projectId });
export const buildShotsAction = async ({ userId, user, projectId }) => buildShotList({ userId, projectId, user });
export const stillsAction = async ({ userId, user, projectId, body = {} }) =>
  generateStills({ userId, projectId, shotIds: body.shotIds, retry: body.retry === true, user });
export const updateShotAction = async ({ userId, projectId, body = {} }) => {
  if (typeof body.shotId !== 'string' || !body.shotId) throw new ValidationError('Say which shot.', { field: 'shotId' });
  return updateShot({ userId, projectId, shotId: body.shotId, patch: body.patch });
};

registerAction('shots', { method: 'GET', handler: listShotsAction });
registerAction('shots', { method: 'POST', handler: buildShotsAction });
registerAction('stills', { method: 'POST', handler: stillsAction });
registerAction('shot', { method: 'PATCH', handler: updateShotAction });
