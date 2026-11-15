import { randomUUID } from 'node:crypto';
import { completeJSON } from '../providers/llm.js';
import { ModerationError, screenText, screenTextRegex } from '../moderation.js';
import { holdCredits, releaseHold, spendCredits } from '../credits.js';
import { getPricing } from '../pricing.js';
import { storyDb } from './db.js';
import { ConflictError, LimitError, NotFoundError, StoryError, ValidationError } from './errors.js';
import { getProject, STEPS } from './projects.js';
import { assertAllowed } from './limits.js';
import { registerAction } from './actions.js';
import { enqueue } from './runner.js';
import { styleFragment } from './prompts/styles.js';
import { FAMILY_FRIENDLY_GUIDANCE } from './prompts/script.js';
import {
  buildCastMessage, buildCastSystem, candidatePrompt, CANDIDATE_ASPECT, CANDIDATES_PER_CHARACTER, CAST_SCHEMA,
  MAX_CHARACTERS, MAX_DESCRIPTION, MAX_NAME, MAX_NOTE, MAX_VOICE_NOTE, SHEET_ASPECT, sheetPrompt,
} from './prompts/cast.js';
import './mocks.js';

/*
 * The cast step (spec 7.3 step 7): a script becomes characters, each with
 * three picture options, a pick and a cast sheet. The picture jobs run on the
 * runner (kind 'cast_image', handler in lib/story/castJobs.js).
 *
 * story_cast.status:
 *   draft    the row exists and its jobs are being queued (a moment). A draft
 *            older than DRAFT_RESUME_MS means the request that made it died.
 *   pending  at least one picture of the current round is still being made
 *   ready    pictures are in `candidates` ([{ slot, url, key, prompt }], by slot)
 *   failed   the round ended with no picture and no block
 *   blocked  the round ended with no picture and the provider blocked one
 * A round is one batch of 3 pictures (story_cast.round). A start, a regeneration
 * and a retry each begin a new round; jobs of an older round never write.
 *
 * Money (lib/pricing.js is the only source of numbers):
 *   - the project fee (pricing.projectFee) is spent once, ref `project-fee:<projectId>`,
 *     when the cast is first generated; the first 3 pictures per character and
 *     the cast sheets are covered by it;
 *   - the first pricing.included.castRegenPerCharacter regenerations per
 *     character are free; each one after costs pricing.castRegen, held up
 *     front and split over the round's 3 jobs (each job settles its share when
 *     its picture arrives, and the runner releases the share of one that fails);
 *   - a retry (`retry: true`, the customer pressing Try again on a failed
 *     character) is never charged and does not use a free regeneration. It is
 *     only allowed while the character's last round failed, so it is not a
 *     free re-roll.
 * All of cast_generate, cast_regenerate need a paid plan (lib/story/limits.js).
 */

export const CAST_MAX = MAX_CHARACTERS;
// A draft this old was left by a request that died before it queued the jobs.
const DRAFT_RESUME_MS = 30_000;
// Cast sheets one character can have made per round of pictures (failed ones do not count).
export const SHEET_LIMIT = 6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isUniqueViolation = (err) => err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
const splitCost = (total, parts) => Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));

// ---------------------------------------------------------------- data

const castRows = (projectId) => storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' });

async function getCast(projectId, castId) {
  if (typeof castId !== 'string' || !UUID.test(castId)) throw new NotFoundError('Character not found.');
  const [row] = await storyDb().select('story_cast', { id: castId, project_id: projectId });
  if (!row) throw new NotFoundError('Character not found.');
  return row;
}

async function latestScript(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  return row || null;
}

/** Every cast_image job of one character, oldest first. */
async function jobsOfCast(projectId, castId) {
  const rows = await storyDb().select('story_jobs', { project_id: projectId, kind: 'cast_image' }, { order: ['created_at', 'id'], limit: 1000 });
  return rows.filter((j) => j.payload?.castId === castId);
}

async function advanceStep(project) {
  if (STEPS.indexOf(project.step) < STEPS.indexOf('cast')) {
    await storyDb().update('story_projects', { id: project.id, user_id: project.user_id }, { step: 'cast' });
  }
}

const draftIsStale = (row) => row.status === 'draft' && Date.now() - Date.parse(row.updated_at) > DRAFT_RESUME_MS;

/**
 * Takes queued jobs out of the queue (they never reach the provider) and gives
 * back the hold share each carried. A job the runner claimed meanwhile stays.
 */
async function dropQueuedJobs(jobs) {
  const queued = jobs.filter((j) => j.status === 'queued');
  if (!queued.length) return [];
  const removed = await storyDb().remove('story_jobs', { id: queued.map((j) => j.id), status: 'queued' });
  for (const job of removed) {
    if (job.hold_id && job.cost_credits > 0) {
      await releaseHold({ holdId: job.hold_id, amount: job.cost_credits, ref: `job:${job.id}` }).catch(() => {});
    }
  }
  return removed;
}

// ---------------------------------------------------------------- the characters

function normalizeCharacters(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw?.characters) ? raw.characters : []) {
    const name = clean(item?.name, MAX_NAME);
    const description = clean(item?.description, MAX_DESCRIPTION);
    if (!name || !description || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, description, voice_note: clean(item?.voiceNote, MAX_VOICE_NOTE) || null });
    if (out.length === CAST_MAX) break;
  }
  return out;
}

const BLOCKED_MESSAGE = 'We could not describe the characters in a way we were happy with. Try changing a few words in the script.';

/**
 * One model call (the fast tier), checked with the regex moderation layer
 * before anything is saved. On a trip the call runs once more with a family
 * friendly instruction; a second trip is StoryError 422 'cast_blocked'.
 */
async function draftCharacters({ scenes, project }) {
  const system = buildCastSystem({ mode: project.mode });
  const messages = [{ role: 'user', content: buildCastMessage({ scenes, brief: { purpose: project.purpose, mode: project.mode } }) }];
  for (const extra of [null, FAMILY_FRIENDLY_GUIDANCE]) {
    const answer = await completeJSON({
      name: 'story_cast', tier: 'fast', system: extra ? `${system}\n\n${extra}` : system, messages, schema: CAST_SCHEMA, maxTokens: 2000,
    });
    const characters = normalizeCharacters(answer);
    if (!characters.length) throw new StoryError("We couldn't work out the characters this time. Please try again.", { status: 502, code: 'cast_failed' });
    try {
      for (const c of characters) screenTextRegex([c.name, c.description, c.voice_note]);
      return characters;
    } catch (err) {
      if (!(err instanceof ModerationError)) throw err;
    }
  }
  throw new StoryError(BLOCKED_MESSAGE, { status: 422, code: 'cast_blocked' });
}

// ---------------------------------------------------------------- rounds

/**
 * Moves a character to its next round: clears pictures, pick and sheet and
 * leaves the row a draft until its jobs are queued. Only one of several
 * requests that read the same round gets it. -> the claimed row, or null.
 */
async function claimRound(cast, patch = {}, holdId = null) {
  const [claimed] = await storyDb().update(
    'story_cast',
    { id: cast.id, project_id: cast.project_id, round: cast.round },
    { round: cast.round + 1, status: 'draft', candidates: [], chosen_index: null, image_url: null, image_key: null, sheet: {}, hold_id: holdId, ...patch }
  );
  return claimed || null;
}

/**
 * Queues the 3 picture jobs of a draft row's current round and marks it
 * pending. `shares` are the hold credits each job carries (all 0 when free).
 * If a job cannot be queued the ones that were are taken back out.
 */
async function launchRound({ project, cast, note = '', holdId = null, shares = [] }) {
  const style = styleFragment(project);
  const made = [];
  try {
    for (let slot = 0; slot < CANDIDATES_PER_CHARACTER; slot += 1) {
      const share = shares[slot] || 0;
      made.push(await enqueue({
        projectId: project.id,
        kind: 'cast_image',
        payload: {
          stage: 'candidate',
          castId: cast.id,
          round: cast.round,
          slot,
          note,
          aspect: CANDIDATE_ASPECT,
          prompt: candidatePrompt({ style, name: cast.name, description: cast.description, note, slot }),
        },
        holdId: share > 0 ? holdId : null,
        costCredits: share > 0 ? share : null,
      }));
    }
    await storyDb().update('story_cast', { id: cast.id, round: cast.round, status: 'draft' }, { status: 'pending', hold_id: null });
  } catch (err) {
    await dropQueuedJobs(made).catch(() => {});
    throw err;
  }
}

/** The candidate jobs of one round. */
const roundJobs = (jobs, round) => jobs.filter((j) => j.payload?.stage === 'candidate' && j.payload.round === round);

/**
 * A draft left behind by a request that died, with every job it did queue
 * still waiting in the queue (none has started, so none can have been paid
 * for or be about to write). Anything else is left to finish.
 */
const restartable = (row, jobs) => draftIsStale(row) && roundJobs(jobs, row.round).every((j) => j.status === 'queued');

/** Gives back the credits a round held, once its queued jobs are out of the queue. */
async function releaseRoundHold(row) {
  if (row.hold_id) await releaseHold({ holdId: row.hold_id }).catch(() => {});
}

/** Restarts a dead start: a new round (free: its hold is given back) and its jobs. */
async function restartStaleDraft(project, cast, jobs) {
  if (!restartable(cast, jobs)) return;
  const claimed = await claimRound(cast);
  if (!claimed) return; // another request got there first
  await dropQueuedJobs(roundJobs(jobs, cast.round));
  await releaseRoundHold(cast);
  await launchRound({ project, cast: claimed, note: roundJobs(jobs, cast.round)[0]?.payload?.note || '' });
}

/**
 * What a retry of the character's last (failed) round costs: the sum of that
 * round's job prices (0 for a free round). A retry holds this again, because
 * the failed attempt's hold was given back; it never uses a free regeneration.
 */
export function retryPrice(jobs, round) {
  return roundJobs(jobs, round).reduce((n, j) => n + (j.cost_credits || 0), 0);
}

// ---------------------------------------------------------------- services

/**
 * Writes the characters from the latest script, spends the project fee (once,
 * for the project) and queues 3 picture jobs per character. Called again, it
 * charges and queues nothing more: it returns the characters (and starts again
 * any whose start died, once its draft is old enough). Moves the project to the
 * cast step. -> { cast }
 */
export async function generateCast({ userId, projectId, user }) {
  const project = await getProject({ userId, id: projectId });
  await assertAllowed({ userId, action: 'cast_generate', projectId, user });

  const existing = await castRows(projectId);
  if (existing.length) {
    await advanceStep(project);
    for (const row of existing.filter(draftIsStale)) await restartStaleDraft(project, row, await jobsOfCast(projectId, row.id));
    return { cast: await castRows(projectId) };
  }

  const script = await latestScript(projectId);
  if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
    throw new ValidationError('Write the script first, then choose your characters.', { field: 'script' });
  }
  const characters = await draftCharacters({ scenes: script.scenes, project });

  // The fee goes first and is safe to repeat: the ref names this one charge,
  // so a retry after a failure later in this function never charges again.
  const { projectFee } = await getPricing();
  if (!project.fee_charged && projectFee > 0) {
    await spendCredits({ userId, currency: 'video', amount: projectFee, reason: 'story_project_fee', ref: `project-fee:${projectId}`, projectId });
  }
  if (!project.fee_charged) await storyDb().update('story_projects', { id: projectId, user_id: userId }, { fee_charged: true });

  let rows;
  try {
    rows = await storyDb().insert('story_cast', characters.map((c, ord) => ({ project_id: projectId, ord, ...c, status: 'draft', round: 1 })));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another request started the cast a moment ago; it queues the jobs.
    return { cast: await castRows(projectId) };
  }
  await advanceStep(project);
  for (const row of rows) await launchRound({ project, cast: row });
  return { cast: await castRows(projectId) };
}

function cleanNote(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') throw new ValidationError('Describe the change in a few words.', { field: 'note' });
  const text = note.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_NOTE) throw new ValidationError(`Keep the change to ${MAX_NOTE} characters or fewer.`, { field: 'note' });
  return text;
}

const RETRY_REFUSED = 'There is nothing to try again for this character. Describe a change and regenerate instead.';

/**
 * New pictures for one character, optionally shaped by `note`.
 * The first pricing.included.castRegenPerCharacter are free; later ones cost
 * pricing.castRegen (held, then settled per picture that comes out).
 *
 * retry: true is the customer's Try again after a provider failure: it makes
 * the same request again and does not count toward the free regenerations.
 * It is refused (409 'retry_not_available') unless the character's last round
 * failed. A failed round's hold was given back, so a retry of a paid round
 * holds that round's price again (retryPrice); a retry of a free round is free.
 *
 * -> { cast, charged }   charged: credits held for this round (0 when free)
 */
export async function regenerateCharacter({ userId, projectId, castId, note, retry = false, user }) {
  const project = await getProject({ userId, id: projectId });
  const cast = await getCast(projectId, castId);
  const text = cleanNote(note);
  await assertAllowed({ userId, action: 'cast_regenerate', projectId, user });
  if (text) await screenText([text]);

  const jobs = await jobsOfCast(projectId, cast.id);
  if (cast.status === 'pending' || (cast.status === 'draft' && !restartable(cast, jobs))) {
    throw new ConflictError(`The pictures for ${cast.name} are still being made. Wait for them to finish.`);
  }
  if (retry === true && cast.status !== 'failed') throw new ConflictError(RETRY_REFUSED, { code: 'retry_not_available' });

  // A restartable draft is a start that died: finishing it is free, like a retry of a free round.
  const again = retry === true || cast.status === 'draft';
  const lastNote = [...jobs].reverse().find((j) => j.payload?.stage === 'candidate')?.payload?.note || '';
  let cost = 0;
  let patch = {};
  if (cast.status === 'draft') {
    cost = 0;
  } else if (retry === true) {
    cost = retryPrice(jobs, cast.round);
  } else {
    const pricing = await getPricing();
    cost = cast.regens_used < pricing.included.castRegenPerCharacter ? 0 : pricing.castRegen;
    patch = { regens_used: cast.regens_used + 1 };
  }

  let holdId = null;
  let claimed = null;
  try {
    if (cost > 0) {
      holdId = randomUUID();
      await holdCredits({ userId, currency: 'video', amount: cost, projectId, holdId });
    }
    claimed = await claimRound(cast, patch, holdId);
    if (!claimed) throw new ConflictError(`The pictures for ${cast.name} just changed. Reload and try again.`);
    await dropQueuedJobs(jobs.filter((j) => j.payload?.stage === 'candidate' && j.payload.round < claimed.round));
    if (cast.status === 'draft') await releaseRoundHold(cast);
    await launchRound({ project, cast: claimed, note: again ? lastNote : text, holdId, shares: cost > 0 ? splitCost(cost, CANDIDATES_PER_CHARACTER) : [] });
  } catch (err) {
    // Nothing may stay held: every way out of here gives the credits back.
    if (holdId) await releaseHold({ holdId }).catch(() => {});
    if (claimed) {
      // Put the pictures back as they were. The round number moves on again, so a job of the aborted round that is
      // already running cannot write into the restored row.
      await storyDb().update('story_cast', { id: cast.id, round: claimed.round }, {
        round: claimed.round + 1,
        status: cast.status,
        candidates: cast.candidates,
        chosen_index: cast.chosen_index,
        image_url: cast.image_url,
        image_key: cast.image_key,
        sheet: cast.sheet,
        regens_used: cast.regens_used,
        hold_id: cast.hold_id,
      }).catch(() => {});
    }
    throw err;
  }
  return { cast: await getCast(projectId, cast.id), charged: cost };
}

const sheetInFlight = (j) => j.payload?.stage === 'sheet' && (j.status === 'queued' || j.status === 'running' || (j.status === 'done' && !j.applied_at));

/**
 * Picks one of a character's finished pictures and queues the cast sheet
 * (front, three quarter and close up in one image) with the pick as the
 * reference. 409 until the pictures are finished, and while the sheet for the
 * last pick is still being made. Picking the same picture again changes
 * nothing, unless its sheet never arrived, which makes a new one.
 * -> { cast }
 */
export async function pickCast({ userId, projectId, castId, candidateIndex }) {
  const project = await getProject({ userId, id: projectId });
  const cast = await getCast(projectId, castId);
  if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
    throw new ValidationError('Choose one of the pictures.', { field: 'candidateIndex' });
  }
  if (cast.status !== 'ready' || !cast.candidates.length) {
    throw new ConflictError(`The pictures for ${cast.name} are not ready yet.`);
  }
  const picked = cast.candidates[candidateIndex];
  if (!picked) throw new ValidationError('That picture does not exist.', { field: 'candidateIndex' });

  const jobs = await jobsOfCast(projectId, cast.id);
  const sheetJobs = jobs.filter((j) => j.payload?.stage === 'sheet');
  const samePick = cast.image_key === picked.key;
  const making = sheetJobs.some(sheetInFlight);
  if (samePick && (cast.sheet?.from_key === picked.key || making)) return { cast };
  if (making) throw new ConflictError(`The character sheet for ${cast.name} is still being drawn. Wait a moment, then pick again.`);
  const made = sheetJobs.filter((j) => j.payload.round === cast.round && j.status !== 'failed' && j.status !== 'blocked').length;

  const [saved] = await storyDb().update(
    'story_cast',
    { id: cast.id, project_id: projectId, round: cast.round, image_key: cast.image_key },
    { chosen_index: candidateIndex, image_url: picked.url, image_key: picked.key, sheet: {} }
  );
  if (!saved) throw new ConflictError(`The pictures for ${cast.name} just changed. Reload and try again.`);
  // The pick is saved either way; only the sheet is held back at the cap.
  if (made >= SHEET_LIMIT) {
    throw new LimitError(`Your pick for ${cast.name} is saved, but we have drawn ${cast.name}'s character sheet ${SHEET_LIMIT} times for these pictures. Regenerate the pictures to get new sheets.`, { code: 'sheet_limit' });
  }

  await enqueue({
    projectId,
    kind: 'cast_image',
    payload: {
      stage: 'sheet',
      castId: cast.id,
      round: cast.round,
      fromKey: picked.key,
      refs: [picked.url],
      aspect: SHEET_ASPECT,
      prompt: sheetPrompt({ style: styleFragment(project), name: cast.name, description: cast.description }),
    },
  });
  return { cast: await getCast(projectId, cast.id) };
}

// ---------------------------------------------------------------- HTTP actions

// GET  /api/story/projects/[id]/cast        -> { cast }       the characters, in order
// POST /api/story/projects/[id]/cast        -> { cast }       write the characters, queue their pictures
// POST /api/story/projects/[id]/cast-regen  { castId, note?, retry? }      -> { cast, charged }
// POST /api/story/projects/[id]/cast-pick   { castId, candidateIndex }     -> { cast }
// The model call is quick (fast tier), but cast has its own route file
// (pages/api/story/projects/[id]/cast.js) for a longer maxDuration, like script.
function castIdOf(body) {
  if (typeof body.castId !== 'string' || !body.castId) throw new ValidationError('Say which character.', { field: 'castId' });
  return body.castId;
}

export const listCastAction = async ({ projectId }) => ({ cast: await castRows(projectId) });
export const generateCastAction = async ({ userId, user, projectId }) => generateCast({ userId, projectId, user });
export const regenerateCastAction = async ({ userId, user, projectId, body = {} }) =>
  regenerateCharacter({ userId, projectId, castId: castIdOf(body), note: body.note, retry: body.retry === true, user });
export const pickCastAction = async ({ userId, projectId, body = {} }) =>
  pickCast({ userId, projectId, castId: castIdOf(body), candidateIndex: body.candidateIndex });

registerAction('cast', { method: 'GET', handler: listCastAction });
registerAction('cast', { method: 'POST', handler: generateCastAction });
registerAction('cast-regen', { method: 'POST', handler: regenerateCastAction });
registerAction('cast-pick', { method: 'POST', handler: pickCastAction });
