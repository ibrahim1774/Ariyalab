import { storyDb } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { screenText } from '../moderation.js';
import { assertAllowed, releaseAllowance } from './limits.js';
import { registerAction } from './actions.js';

/*
 * Story projects: create, read, list, update, delete, duplicate.
 * Every function takes { userId } and only touches that user's rows; a
 * project owned by someone else is reported as NotFoundError.
 */

export const PURPOSES = Object.freeze(['product', 'app', 'coaching', 'service', 'personal_brand', 'story']);
export const STYLES = Object.freeze([
  '3d_family', '2d_cartoon', 'anime', 'clay', 'comic', 'flat_motion', 'watercolor', 'custom',
]);
export const ASPECTS = Object.freeze(['9:16', '1:1', '16:9']);
export const QUALITIES = Object.freeze(['economy', 'standard', 'pro_narrated', 'pro_talking']);
export const MODES = Object.freeze(['narrated', 'talking']);
export const STEPS = Object.freeze([
  'brief', 'breakdown', 'script', 'cast', 'storyboard', 'audio', 'generate', 'review', 'done',
]);
export const PROJECT_STATUSES = Object.freeze(['draft', 'generating', 'finished', 'failed', 'expired']);
export const MIN_SECONDS = 15;
export const MAX_SECONDS = 75;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Customer-editable fields and their maximum text length (null = enum or number).
const TEXT_LIMITS = { title: 120, offer: 1000, audience: 500, style_custom: 300 };
const ENUMS = { purpose: PURPOSES, style: STYLES, aspect: ASPECTS, quality: QUALITIES, mode: MODES };
export const EDITABLE_FIELDS = Object.freeze([
  'title', 'purpose', 'offer', 'audience', 'style', 'style_custom', 'seconds', 'aspect', 'quality', 'mode',
]);
const SCREENED_FIELDS = ['title', 'offer', 'audience', 'style_custom'];

function cleanFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Expected a JSON object.');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!EDITABLE_FIELDS.includes(key)) throw new ValidationError(`${key} cannot be set.`, { field: key });
    if (key === 'seconds') {
      if (!Number.isInteger(value) || value < MIN_SECONDS || value > MAX_SECONDS) {
        throw new ValidationError(`Length must be a whole number from ${MIN_SECONDS} to ${MAX_SECONDS} seconds.`, { field: key });
      }
      out[key] = value;
    } else if (ENUMS[key]) {
      const required = key === 'aspect' || key === 'quality' || key === 'mode';
      if (value === null && !required) out[key] = null;
      else if (!ENUMS[key].includes(value)) throw new ValidationError(`Unknown ${key}.`, { field: key });
      else out[key] = value;
    } else {
      if (value === null && key !== 'title') {
        out[key] = null;
        continue;
      }
      if (typeof value !== 'string') throw new ValidationError(`${key} must be text.`, { field: key });
      // A NUL character cannot be stored in a Postgres text column.
      const text = value.replace(/\u0000/g, '').trim();
      if (key === 'title' && text === '') throw new ValidationError('Title cannot be empty.', { field: key });
      if (text.length > TEXT_LIMITS[key]) {
        throw new ValidationError(`${key} must be at most ${TEXT_LIMITS[key]} characters.`, { field: key });
      }
      out[key] = text === '' ? null : text;
    }
  }
  return out;
}

async function screen(fields) {
  const texts = SCREENED_FIELDS.map((k) => fields[k]).filter((v) => typeof v === 'string' && v);
  if (texts.length) await screenText(texts);
}

// Talking videos use the video model's own voices, which only pro_talking
// has: quality 'pro_talking' means mode 'talking' and nothing else does.
// `fields` gets the resolved mode; `current` is the stored project, if any.
function resolveMode(fields, current = { quality: 'standard', mode: 'narrated' }) {
  const quality = fields.quality ?? current.quality;
  if (quality === 'pro_talking') {
    if (fields.mode === 'narrated') {
      throw new ValidationError(
        'Pro talking videos use the characters’ own voices. Choose another quality for a narrated video.',
        { field: 'mode' }
      );
    }
    if (current.mode !== 'talking' || fields.mode) fields.mode = 'talking';
    return;
  }
  const mode = fields.mode ?? current.mode;
  if (mode === 'talking') {
    throw new ValidationError(
      fields.mode
        ? 'Talking videos need the pro_talking quality. Set quality to pro_talking, or mode to narrated.'
        : 'This video is in talking mode, which needs pro_talking. Also set mode to narrated to change the quality.',
      { field: fields.mode ? 'mode' : 'quality' }
    );
  }
}

function requireUser(userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new NotFoundError();
}

/** `user` (optional) is the session user, passed through to the free-tier check. */
export async function createProject({ userId, input = {}, user }) {
  requireUser(userId);
  const fields = cleanFields(input);
  resolveMode(fields);
  await screen(fields);
  // Free-tier daily project cap, after validation and moderation so a refused request costs nothing.
  const allowance = await assertAllowed({ userId, action: 'project_create', user });
  try {
    const [project] = await storyDb().insert('story_projects', { ...fields, user_id: userId });
    return project;
  } catch (err) {
    await releaseAllowance(allowance).catch(() => {});
    throw err;
  }
}

export async function getProject({ userId, id }) {
  requireUser(userId);
  if (typeof id !== 'string' || !UUID.test(id)) throw new NotFoundError('Project not found.');
  const [project] = await storyDb().select('story_projects', { id, user_id: userId });
  if (!project) throw new NotFoundError('Project not found.');
  return project;
}

export async function listProjects({ userId }) {
  requireUser(userId);
  const projects = await storyDb().select('story_projects', { user_id: userId }, { order: ['-updated_at', '-created_at'] });
  // A project without a stored thumbnail shows its first picture (by shot order), so a card is never just a colour.
  const bare = projects.filter((p) => !p.thumbnail_url).map((p) => p.id);
  if (bare.length === 0) return projects;
  const shots = await storyDb().select('story_shots', { project_id: bare }, { columns: ['project_id', 'ord', 'still_url'], order: ['ord'] });
  const first = new Map();
  for (const shot of shots) if (shot.still_url && !first.has(shot.project_id)) first.set(shot.project_id, shot.still_url);
  return projects.map((p) => (p.thumbnail_url || !first.has(p.id) ? p : { ...p, thumbnail_url: first.get(p.id) }));
}

export async function updateProject({ userId, id, patch }) {
  const current = await getProject({ userId, id });
  const fields = cleanFields(patch);
  if (Object.keys(fields).length === 0) throw new ValidationError('Nothing to update.');
  resolveMode(fields, current);
  await screen(fields);
  const [project] = await storyDb().update('story_projects', { id, user_id: userId }, fields);
  if (!project) throw new NotFoundError('Project not found.');
  return project;
}

/**
 * Deletes the project and (by cascade) its references, scripts, cast, shots,
 * jobs, renders, chat and asset links (the assets stay). Refused while a job
 * is queued or running, because those jobs carry credit holds that only the
 * runner settles or releases. The check and the delete are one SQL call.
 */
export async function deleteProject({ userId, id }) {
  await getProject({ userId, id });
  // Starts left by requests that died give their holds back first (imported here: those modules import this one).
  try {
    const [{ recoverStalledStills }, { recoverStalledClips }] = await Promise.all([import('./storyboard.js'), import('./shots.js')]);
    await recoverStalledStills(id);
    await recoverStalledClips(id);
  } catch (err) {
    console.error('[story] could not recover stalled starts before a delete', id, err?.message);
  }
  let deleted;
  try {
    deleted = await storyDb().rpc('story_delete_project', { p_user: userId, p_project: id });
  } catch (err) {
    if (err?.message === 'project_busy') {
      throw new ConflictError('This video is still generating. Try again when it has finished.');
    }
    throw err;
  }
  if (!deleted) throw new NotFoundError('Project not found.');
  return { id };
}

const SYSTEM_COLUMNS = ['id', 'project_id', 'created_at', 'updated_at'];
const strip = (row, extra = []) => {
  const copy = { ...row };
  for (const k of [...SYSTEM_COLUMNS, ...extra]) delete copy[k];
  return copy;
};

// A copy has no jobs, so nothing would ever finish a 'pending' row.
const settledCastStatus = (c) => (c.status !== 'pending' ? c.status : c.image_url || c.candidates?.length ? 'ready' : 'draft');

/**
 * Copies the project (title + " copy"), its reference, its latest script,
 * its cast (with images, regenerations reset), its shots without clips
 * (cast_ids pointed at the copied cast) and its asset links (the assets
 * themselves are the user's and are shared). Billing state starts fresh.
 *
 * Stored files are shared with the source, not copied, so the copy keeps the
 * source's files_expire_at and both lose them on the same day. When the
 * source has already expired, its file references are dropped instead. The step goes back to 'storyboard' (the furthest step that needs
 * no clips) if the source was past it; otherwise it stays.
 */
export async function duplicateProject({ userId, id, user }) {
  const src = await getProject({ userId, id });
  // A copy is a new project, so it counts against the free daily project cap
  // (given back if the copy fails).
  const allowance = await assertAllowed({ userId, action: 'project_create', user });
  try {
    return await copyProject(src, userId);
  } catch (err) {
    await releaseAllowance(allowance).catch(() => {});
    throw err;
  }
}

async function copyProject(src, userId) {
  const { id } = src;
  const db = storyDb();

  const [shots, [script], cast, [reference], links] = await Promise.all([
    db.select('story_shots', { project_id: id }, { order: 'ord', limit: 1000 }),
    db.select('story_scripts', { project_id: id }, { order: '-version', limit: 1 }),
    db.select('story_cast', { project_id: id }, { order: ['ord', 'created_at'] }),
    src.reference_id ? db.select('story_references', { id: src.reference_id, project_id: id }) : Promise.resolve([]),
    db.select('story_project_assets', { project_id: id }),
  ]);

  const expired = src.status === 'expired';
  const noFiles = expired
    ? { narration_url: null, narration_key: null, music_url: null, music_key: null, thumbnail_url: null, thumbnail_key: null, files_expire_at: null }
    : {};
  const step = STEPS.indexOf(src.step) > STEPS.indexOf('storyboard') ? 'storyboard' : src.step;
  const title = `${src.title} copy`.slice(0, TEXT_LIMITS.title);

  const [copy] = await db.insert('story_projects', {
    ...strip(src, [
      'user_id', 'reference_id', 'fee_charged', 'rerolls_used', 'narrations_used', 'music_used', 'chat_used', 'status', 'step', 'title',
      // a clip start in flight belongs to the source project's hold
      'gen_claim_id', 'gen_hold_id', 'gen_claimed_at', 'gen_shots', 'gen_rerolls',
    ]),
    ...noFiles,
    user_id: userId,
    title,
    step,
  });

  try {
    let referenceId = null;
    if (reference) {
      const pending = reference.status === 'pending';
      const [ref] = await db.insert('story_references', {
        ...strip(reference),
        project_id: copy.id,
        ...(pending ? { status: 'failed', error: 'The analysis had not finished when this copy was made.' } : {}),
        ...(expired ? { file_url: null, storage_key: null, frames: [] } : {}),
      });
      referenceId = ref.id;
    }
    if (script) {
      await db.insert('story_scripts', { ...strip(script), project_id: copy.id, version: 1 });
    }
    const castIds = new Map();
    if (cast.length) {
      const copied = await db.insert(
        'story_cast',
        cast.map((c) =>
          expired
            ? { ...strip(c), project_id: copy.id, regens_used: 0, status: 'draft', candidates: [], chosen_index: null, image_url: null, image_key: null, sheet: {} }
            : { ...strip(c), project_id: copy.id, status: settledCastStatus(c), regens_used: 0 }
        )
      );
      cast.forEach((c, i) => castIds.set(c.id, copied[i].id));
    }
    if (links.length) {
      await db.insert('story_project_assets', links.map((l) => ({ ...strip(l), project_id: copy.id })));
    }
    if (shots.length) {
      await db.insert(
        'story_shots',
        shots.map((s) => ({
          ...strip(s, ['error']),
          project_id: copy.id,
          clip_url: null,
          clip_key: null,
          clip_prev: null,
          // No clip in the copy, so nothing is stale or mismatched.
          stale: false,
          clip_mismatch: false,
          attempts: 0,
          ...(expired ? { still_url: null, still_key: null } : {}),
          status: s.still_url && !expired ? 'still_ready' : 'draft',
          cast_ids: (s.cast_ids || []).filter((cid) => castIds.has(cid)).map((cid) => castIds.get(cid)),
        }))
      );
    }
    if (referenceId) {
      const [updated] = await db.update('story_projects', { id: copy.id }, { reference_id: referenceId });
      return updated;
    }
    return copy;
  } catch (err) {
    // No transactions over supabase-js: remove the partial copy (children cascade).
    await db.remove('story_projects', { id: copy.id }).catch(() => {});
    throw err;
  }
}

// POST /api/story/projects/[id]/duplicate -> 201 { project }
registerAction('duplicate', {
  method: 'POST',
  status: 201,
  handler: async ({ userId, user, projectId }) => ({ project: await duplicateProject({ userId, id: projectId, user }) }),
});
