import { randomUUID } from 'node:crypto';
import { completeJSON } from '../providers/llm.js';
import { ModerationError, screenText, screenTextRegex } from '../moderation.js';
import { hasLedgerEntry, holdCredits, HoldClosedError, holdRemaining, RefConflictError, releaseHold, spendCredits } from '../credits.js';
import { getPricing } from '../pricing.js';
import { storyDb } from './db.js';
import { ConflictError, LimitError, NotFoundError, QuoteChangedError, StoryError, ValidationError } from './errors.js';
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
 *   - the price of the current round is kept on the row (round_credits, 0 for a
 *     free round). A retry (`retry: true`, Try again on a failed character) does
 *     not use a free regeneration and is priced from it: a retry of a free round
 *     is free; a retry of a failed paid round holds that price again (the failed
 *     round's hold was given back), so a retry never charges twice and a paid
 *     round is never free. It is only allowed while the last round failed.
 *   - story_cast.hold_id / hold_credits record a round's hold from the moment
 *     the round is claimed until all its jobs are queued. A round whose request
 *     died is not restarted: it is reset to failed (price kept) and the part of
 *     its hold that no job carries is given back, so Try again holds the price
 *     once (resetStaleRound). A picture that arrives for a round that is no
 *     longer current is discarded and its share released (lib/story/castJobs.js).
 *   - the cast view carries the prices (retry_credits, regen_credits, from the
 *     same code that charges); a request may send `expected_credits`, and a
 *     different price is 409 quote_changed.
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

/**
 * Every cast_image job of one character, oldest first. storyDb cannot match
 * inside the payload, so the project's newest 1000 cast_image jobs are read and
 * filtered: a heavy project loses its oldest jobs, never the current round's.
 */
async function jobsOfCast(projectId, castId) {
  const rows = await storyDb().select('story_jobs', { project_id: projectId, kind: 'cast_image' }, { order: ['-created_at', '-id'], limit: 1000 });
  return rows.filter((j) => j.payload?.castId === castId).reverse();
}

async function advanceStep(project) {
  if (STEPS.indexOf(project.step) < STEPS.indexOf('cast')) {
    await storyDb().update('story_projects', { id: project.id, user_id: project.user_id }, { step: 'cast' });
  }
}

// A round whose request died: still a draft, or still pointing at its hold (the request clears the hold when every job is queued).
const draftIsStale = (row) => (row.status === 'draft' || row.hold_id !== null) && Date.now() - Date.parse(row.updated_at) > DRAFT_RESUME_MS;

/**
 * Takes queued jobs out of the queue (they never reach the provider) and gives
 * back the hold share each carried (unless `release` is false: the share is
 * carried on by a new round). A job the runner claimed meanwhile stays.
 */
async function dropQueuedJobs(jobs, { release = true } = {}) {
  const queued = jobs.filter((j) => j.status === 'queued');
  if (!queued.length) return [];
  const removed = await storyDb().remove('story_jobs', { id: queued.map((j) => j.id), status: 'queued' });
  for (const job of removed) {
    if (release && job.hold_id && job.cost_credits > 0) {
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
async function claimRound(cast, patch = {}, { holdId = null, holdCredits: held = 0, roundCredits = 0 } = {}) {
  const [claimed] = await storyDb().update(
    'story_cast',
    { id: cast.id, project_id: cast.project_id, round: cast.round },
    {
      round: cast.round + 1, status: 'draft', candidates: [], candidates_round: null, chosen_index: null, image_url: null, image_key: null, sheet: {},
      hold_id: holdId, hold_credits: held, round_credits: roundCredits, ...patch,
    }
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
    // A paid round also matches its hold: a stale reset that kept the round but took over the hold (gave back the
    // shares of jobs not queued yet) clears hold_id, so this request must not leave jobs whose shares are gone.
    const match = { id: cast.id, round: cast.round, status: 'draft', ...(holdId ? { hold_id: holdId } : {}) };
    const [queuedRow] = await storyDb().update('story_cast', match, { status: 'pending', hold_id: null, hold_credits: 0 });
    // The row moved on while the jobs were queued (a reset, another request): the jobs belong to a dead round.
    if (!queuedRow) throw new ConflictError(`The pictures for ${cast.name} just changed. Reload and try again.`);
  } catch (err) {
    await dropQueuedJobs(made).catch(() => {});
    throw err;
  }
}

/** The candidate jobs of one round. */
const roundJobs = (jobs, round) => jobs.filter((j) => j.payload?.stage === 'candidate' && j.payload.round === round);

/** A job still carrying its hold share: the runner has not yet settled or released it (both happen before applied_at is set). */
const carriesShare = (job, holdId) => job.hold_id === holdId && job.cost_credits > 0 && !job.applied_at;

/**
 * Gives back the part of a round's hold that belongs to no job.
 * The reset first takes the hold off the row (compare and set on hold_id). From
 * then on a slow request that is still queuing this round cannot mark it queued
 * (launchRound matches the hold), so it takes its own jobs back out: no job it
 * queues during the reset keeps a share this gives back. A reset that loses the
 * compare and set does nothing (another reset, or the request, has the hold).
 * Then:
 *   - No job of the round carries a share: everything left in the hold (a
 *     release with no amount, which does nothing on a closed hold).
 *   - Otherwise: the hold's actual remainder minus the live shares. The jobs are
 *     read before the remainder, so a job finishing in between makes this give
 *     back less, never a live job's share.
 * The partial release has one ref per round; meeting it again with another
 * amount means a concurrent reset already gave back its part. Any other failure
 * after the hold was taken off the row is logged with the hold id: the row no
 * longer points at it, so the stale-hold sweeper (Task 27) gives back the rest.
 */
async function releaseUnowned(cast) {
  const holdId = cast.hold_id;
  if (!holdId) return;
  const [taken] = await storyDb().update('story_cast', { id: cast.id, round: cast.round, hold_id: holdId }, { hold_id: null, hold_credits: 0 });
  if (!taken) return;
  try {
    const jobs = roundJobs(await jobsOfCast(cast.project_id, cast.id), cast.round);
    const live = jobs.filter((j) => carriesShare(j, holdId)).reduce((n, j) => n + j.cost_credits, 0);
    if (live === 0) {
      await releaseHold({ holdId });
      return;
    }
    const hold = await holdRemaining(holdId);
    const amount = (hold?.status === 'active' ? hold.remaining : 0) - live;
    if (amount > 0) await releaseHold({ holdId, amount, ref: `cast:${cast.id}:${cast.round}:unqueued` });
  } catch (err) {
    if (err instanceof HoldClosedError || err instanceof RefConflictError || /hold_not_found/.test(err?.message || '')) return;
    console.error('[story] could not give back the unused part of a cast hold; left for the stale-hold sweeper', cast.id, holdId, err?.message);
  }
}

/**
 * A round whose request died (see draftIsStale) is not restarted; it is
 * reset, and the customer's next Try again holds the round's price again.
 *   - No job of the round has left the queue, and every one of them is taken
 *     out: no job carries a share, so whatever is left in the hold is given
 *     back, and the row becomes failed with round_credits kept. Refunded now,
 *     paid once on the retry: never free, never twice.
 *   - Some job has left the queue (also when one leaves it while the others are
 *     being taken out): every job still out is left to finish and settle or
 *     release its own share, the round is kept so those jobs still write, and
 *     only the part of the hold that belongs to no job is given back.
 * See releaseUnowned for the amounts. A repeat is harmless.
 */
async function resetStaleRound(cast, jobs) {
  if (!draftIsStale(cast)) return;
  const mine = roundJobs(jobs, cast.round);
  if (cast.status === 'draft' && mine.every((j) => j.status === 'queued')) {
    const removed = await dropQueuedJobs(mine, { release: false });
    if (removed.length === mine.length) {
      await releaseUnowned(cast);
      await claimRound(cast, { status: 'failed' }, { roundCredits: cast.round_credits });
      return;
    }
    // A job left the queue while the others were taken out: it keeps the round (below).
  }
  await releaseUnowned(cast);
}

const regenCost = (row, pricing) => (row.regens_used < pricing.included.castRegenPerCharacter ? 0 : pricing.castRegen);

/** What Try again costs for this character: its failed round's price again (0 for a free round), 0 when there is nothing to retry. */
export const retryPrice = (row) => (row.status === 'failed' ? row.round_credits || 0 : 0);

/**
 * The cast as the screen reads it: the rows plus the price of each next
 * action, from the same code that charges (retry_credits, regen_credits).
 * Task 16's status route should return its cast through this.
 */
export function presentCast(rows, pricing) {
  const one = (row) => ({ ...row, retry_credits: retryPrice(row), regen_credits: regenCost(row, pricing) });
  return Array.isArray(rows) ? rows.map(one) : one(rows);
}
export async function castView(rows) {
  return presentCast(rows, await getPricing());
}

// ---------------------------------------------------------------- services

/**
 * The project fee the next cast start charges: pricing.projectFee while the
 * fee is unpaid and the project has no cast, else 0. "Unpaid" means neither
 * the project's fee_charged flag nor the fee's ledger entry (ref
 * project-fee:<id>, which a request that died after the spend leaves behind).
 * pricing is one getPricing() read; the caller charges exactly this number.
 */
export async function castFeeDue(project, pricing) {
  if (project.fee_charged || !(pricing.projectFee > 0)) return 0;
  if ((await castRows(project.id)).length) return 0;
  const paid = await hasLedgerEntry({ userId: project.user_id, currency: 'video', reason: 'story_project_fee', ref: `project-fee:${project.id}` });
  return paid ? 0 : pricing.projectFee;
}

/**
 * The model step of a cast start on its own (the MCP connector queues it as a
 * drafting job, lib/story/draftJobs.js): the characters of the latest script,
 * nothing saved or charged. -> { characters, scriptId, scriptVersion }
 */
export async function draftCastCharacters({ userId, projectId }) {
  const project = await getProject({ userId, id: projectId });
  const script = await latestScript(projectId);
  if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
    throw new ValidationError('Write the script first, then choose your characters.', { field: 'script' });
  }
  const characters = await draftCharacters({ scenes: script.scenes, project });
  return { characters, scriptId: script.id, scriptVersion: script.version };
}

/**
 * Writes the characters from the latest script, spends the project fee (once,
 * for the project) and queues 3 picture jobs per character. Called again, it
 * charges and queues nothing more: it returns the characters (and starts again
 * any whose start died, once its draft is old enough). Moves the project to the
 * cast step. -> { cast, charged }   charged: the fee this call spent (0 when none was due)
 *
 * The fee is read once (castFeeDue on one getPricing()) before the model call
 * and that one number is checked, spent and recorded.
 * expectedCredits (optional, the MCP connector): the price the customer was
 * shown. A different price is 409 quote_changed { total } before the model is
 * asked and before anything is charged.
 * drafted (optional, the MCP connector): { characters, scriptId } from
 * draftCastCharacters. The model is not asked; the characters are normalised
 * and screened again, and a draft of an older script is 409 draft_outdated.
 */
export async function generateCast({ userId, projectId, user, expectedCredits, drafted }) {
  const project = await getProject({ userId, id: projectId });
  await assertAllowed({ userId, action: 'cast_generate', projectId, user });
  const pricing = await getPricing();
  const due = await castFeeDue(project, pricing);
  if (expectedCredits !== undefined && expectedCredits !== null && expectedCredits !== due) {
    throw new QuoteChangedError(`The price is now ${due} credits. Check it and confirm again.`, { total: due });
  }

  const existing = await castRows(projectId);
  if (existing.length) {
    await advanceStep(project);
    for (const row of existing.filter(draftIsStale)) {
      // One character's reset failing must not fail the whole request; the next call tries it again.
      try {
        await resetStaleRound(row, await jobsOfCast(projectId, row.id));
      } catch (err) {
        console.error('[story] could not reset a stale cast round', row.id, err?.message);
      }
    }
    return { cast: await castView(await castRows(projectId)), charged: 0 };
  }

  const script = await latestScript(projectId);
  if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
    throw new ValidationError('Write the script first, then choose your characters.', { field: 'script' });
  }
  let characters;
  if (drafted) {
    if (drafted.scriptId !== script.id) {
      throw new ConflictError('The script changed after these characters were written. Make the characters again.', { code: 'draft_outdated' });
    }
    characters = normalizeCharacters({ characters: (drafted.characters || []).map((c) => ({ name: c?.name, description: c?.description, voiceNote: c?.voice_note })) });
    if (!characters.length) throw new StoryError("We couldn't work out the characters this time. Please try again.", { status: 502, code: 'cast_failed' });
    for (const c of characters) screenTextRegex([c.name, c.description, c.voice_note]);
  } else {
    characters = await draftCharacters({ scenes: script.scenes, project });
  }

  // The fee goes first and is safe to repeat: the ref names this one charge,
  // so a retry after a failure later in this function never charges again.
  if (due > 0) {
    await spendCredits({ userId, currency: 'video', amount: due, reason: 'story_project_fee', ref: `project-fee:${projectId}`, projectId });
  }
  if (!project.fee_charged) await storyDb().update('story_projects', { id: projectId, user_id: userId }, { fee_charged: true });

  let rows;
  try {
    rows = await storyDb().insert('story_cast', characters.map((c, ord) => ({ project_id: projectId, ord, ...c, status: 'draft', round: 1 })));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another request started the cast a moment ago; it queues the jobs and its fee is the one charge
    // (the same ref), so this call spent nothing.
    return { cast: await castView(await castRows(projectId)), charged: 0 };
  }
  await advanceStep(project);
  for (const row of rows) await launchRound({ project, cast: row });
  return { cast: await castView(await castRows(projectId)), charged: due };
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
 * the same request again and does not count toward the free regenerations. It
 * is refused (409 'retry_not_available') unless the character's last round
 * failed. It costs the failed round's price again (retry_credits): 0 for a free
 * round, the round's price for a paid one (that hold was given back).
 *
 * expectedCredits (optional): the price the customer was shown. A different
 * price is 409 quote_changed and nothing happens.
 *
 * -> { cast, charged }   charged: credits held for this round (0 when free)
 */
export async function regenerateCharacter({ userId, projectId, castId, note, retry = false, expectedCredits, user }) {
  const project = await getProject({ userId, id: projectId });
  let cast = await getCast(projectId, castId);
  const text = cleanNote(note);
  if (expectedCredits !== undefined && expectedCredits !== null && (!Number.isInteger(expectedCredits) || expectedCredits < 0)) {
    throw new ValidationError('The price must be a whole number of credits.', { field: 'expected_credits' });
  }
  await assertAllowed({ userId, action: 'cast_regenerate', projectId, user });
  if (text) await screenText([text]);

  // A round whose request died is reset first (see resetStaleRound); the request then goes on as any other.
  let jobs = await jobsOfCast(projectId, cast.id);
  if (draftIsStale(cast)) {
    await resetStaleRound(cast, jobs);
    cast = await getCast(projectId, cast.id);
    jobs = await jobsOfCast(projectId, cast.id);
  }
  if (cast.status === 'pending' || cast.status === 'draft') {
    throw new ConflictError(`The pictures for ${cast.name} are still being made. Wait for them to finish.`);
  }
  // A delivered picture whose job is not applied yet may still be settling: starting a new round now would discard it
  // (and release its share), so it would have been seen for free. Wait for the runner to finish it.
  if (jobs.some((j) => j.payload?.stage === 'candidate' && j.status === 'done' && !j.applied_at)) {
    throw new ConflictError(`The pictures for ${cast.name} are still being saved. Wait a moment and try again.`);
  }
  if (retry === true && cast.status !== 'failed') throw new ConflictError(RETRY_REFUSED, { code: 'retry_not_available' });

  const pricing = await getPricing();
  const cost = retry === true ? retryPrice(cast) : regenCost(cast, pricing);
  const patch = retry === true ? {} : { regens_used: cast.regens_used + 1 };
  if (expectedCredits !== undefined && expectedCredits !== null && expectedCredits !== cost) {
    throw new ConflictError(`The price for ${cast.name} is now ${cost} credits. Check it and try again.`, { code: 'quote_changed', credits: cost });
  }
  const lastNote = [...jobs].reverse().find((j) => j.payload?.stage === 'candidate')?.payload?.note || '';

  // The hold id is recorded on the row when the round is claimed, before the
  // credits are held, so a request that dies in between leaves a record the
  // restart can act on.
  const holdId = cost > 0 ? randomUUID() : null;
  let claimed = null;
  try {
    claimed = await claimRound(cast, patch, { holdId, holdCredits: cost, roundCredits: cost });
    if (!claimed) throw new ConflictError(`The pictures for ${cast.name} just changed. Reload and try again.`);
    if (holdId) await holdCredits({ userId, currency: 'video', amount: cost, projectId, holdId });
    await dropQueuedJobs(jobs.filter((j) => j.payload?.stage === 'candidate' && j.payload.round < claimed.round));
    await launchRound({ project, cast: claimed, note: retry === true ? lastNote : text, holdId, shares: cost > 0 ? splitCost(cost, CANDIDATES_PER_CHARACTER) : [] });
  } catch (err) {
    // Nothing may stay held: every way out of here gives the credits back
    // (releasing a hold that was never made is harmless).
    if (holdId) await releaseHold({ holdId }).catch(() => {});
    if (claimed) {
      // Put the pictures, the pick and the prices back as they were. The round number moves on again, so a job of
      // the aborted round that is already running cannot write into the restored row.
      // If this fails the row stays a draft and the stale reset deals with it (the hold is closed, nothing more to
      // give back). The failure is logged; the caller gets the original error.
      await storyDb().update('story_cast', { id: cast.id, round: claimed.round }, {
        round: claimed.round + 1,
        status: cast.status,
        candidates: cast.candidates,
        candidates_round: cast.candidates_round,
        chosen_index: cast.chosen_index,
        image_url: cast.image_url,
        image_key: cast.image_key,
        sheet: cast.sheet,
        regens_used: cast.regens_used,
        hold_id: cast.hold_id,
        hold_credits: cast.hold_credits,
        round_credits: cast.round_credits,
      }).catch((rollbackErr) => console.error('[story] could not put a character back after a failed start', cast.id, rollbackErr?.message));
    }
    throw err;
  }
  return { cast: await castView(await getCast(projectId, cast.id)), charged: cost };
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
  if (samePick && (cast.sheet?.from_key === picked.key || making)) return { cast: await castView(cast) };
  if (making) throw new ConflictError(`The character sheet for ${cast.name} is still being drawn. Wait a moment, then pick again.`);
  // Sheets are counted per round of the pictures they were made from (not the row's round, which a rolled back request moves on).
  const sheetRound = cast.candidates_round ?? cast.round;

  const [saved] = await storyDb().update(
    'story_cast',
    { id: cast.id, project_id: projectId, round: cast.round, image_key: cast.image_key },
    { chosen_index: candidateIndex, image_url: picked.url, image_key: picked.key, sheet: {} }
  );
  if (!saved) throw new ConflictError(`The pictures for ${cast.name} just changed. Reload and try again.`);

  // Going back to a picture whose sheet is already made reuses that sheet.
  const finished = [...sheetJobs].reverse().find((j) => j.status === 'done' && j.payload.fromKey === picked.key && j.result?.url && j.result?.key);
  if (finished) {
    await storyDb().update('story_cast', { id: cast.id, project_id: projectId, image_key: picked.key }, { sheet: { url: finished.result.url, key: finished.result.key, from_key: picked.key } });
    return { cast: await castView(await getCast(projectId, cast.id)) };
  }

  const made = sheetJobs.filter((j) => j.payload.round === sheetRound && j.status !== 'failed' && j.status !== 'blocked').length;
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
      round: sheetRound,
      fromKey: picked.key,
      refs: [picked.url],
      aspect: SHEET_ASPECT,
      prompt: sheetPrompt({ style: styleFragment(project), name: cast.name, description: cast.description }),
    },
  });
  return { cast: await castView(await getCast(projectId, cast.id)) };
}

// ---------------------------------------------------------------- HTTP actions

// GET  /api/story/projects/[id]/cast        -> { cast }       the characters, in order
// POST /api/story/projects/[id]/cast        -> { cast }       write the characters, queue their pictures
// POST /api/story/projects/[id]/cast-regen  { castId, note?, retry?, expected_credits? } -> { cast, charged }
// Every cast row in a response carries retry_credits and regen_credits (the price of Try again and of a regeneration).
// POST /api/story/projects/[id]/cast-pick   { castId, candidateIndex }     -> { cast }
// The model call is quick (fast tier), but cast has its own route file
// (pages/api/story/projects/[id]/cast.js) for a longer maxDuration, like script.
function castIdOf(body) {
  if (typeof body.castId !== 'string' || !body.castId) throw new ValidationError('Say which character.', { field: 'castId' });
  return body.castId;
}

export const listCastAction = async ({ projectId }) => ({ cast: await castView(await castRows(projectId)) });
export const generateCastAction = async ({ userId, user, projectId }) => generateCast({ userId, projectId, user });
export const regenerateCastAction = async ({ userId, user, projectId, body = {} }) =>
  regenerateCharacter({ userId, projectId, castId: castIdOf(body), note: body.note, retry: body.retry === true, expectedCredits: body.expected_credits, user });
export const pickCastAction = async ({ userId, projectId, body = {} }) =>
  pickCast({ userId, projectId, castId: castIdOf(body), candidateIndex: body.candidateIndex });

registerAction('cast', { method: 'GET', handler: listCastAction });
registerAction('cast', { method: 'POST', handler: generateCastAction });
registerAction('cast-regen', { method: 'POST', handler: regenerateCastAction });
registerAction('cast-pick', { method: 'POST', handler: pickCastAction });
