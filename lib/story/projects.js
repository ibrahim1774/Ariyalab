import { storyDb } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { screenText } from '../moderation.js';

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
export const PROJECT_STATUSES = Object.freeze(['draft', 'generating', 'finished', 'failed']);
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
      const text = value.trim();
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

function requireUser(userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new NotFoundError();
}

export async function createProject({ userId, input = {} }) {
  requireUser(userId);
  const fields = cleanFields(input);
  await screen(fields);
  if (!fields.mode && fields.quality === 'pro_talking') fields.mode = 'talking';
  const [project] = await storyDb().insert('story_projects', { ...fields, user_id: userId });
  return project;
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
  return storyDb().select('story_projects', { user_id: userId }, { order: ['-updated_at', '-created_at'] });
}

export async function updateProject({ userId, id, patch }) {
  await getProject({ userId, id });
  const fields = cleanFields(patch);
  if (Object.keys(fields).length === 0) throw new ValidationError('Nothing to update.');
  await screen(fields);
  const [project] = await storyDb().update('story_projects', { id, user_id: userId }, fields);
  if (!project) throw new NotFoundError('Project not found.');
  return project;
}

/**
 * Deletes the project and (by cascade) its references, scripts, cast, shots,
 * jobs, renders and chat. Refused while a job is queued or running, because
 * those jobs carry credit holds that only the runner settles or releases.
 */
export async function deleteProject({ userId, id }) {
  await getProject({ userId, id });
  const busy = await storyDb().select(
    'story_jobs',
    { project_id: id, status: ['queued', 'running'] },
    { columns: ['id'], limit: 1 }
  );
  if (busy.length) throw new ConflictError('This video is still generating. Try again when it has finished.');
  await storyDb().remove('story_projects', { id, user_id: userId });
  return { id };
}

const SYSTEM_COLUMNS = ['id', 'project_id', 'created_at', 'updated_at'];
const strip = (row, extra = []) => {
  const copy = { ...row };
  for (const k of [...SYSTEM_COLUMNS, ...extra]) delete copy[k];
  return copy;
};

/**
 * Copies the project (title + " copy"), its reference, its latest script,
 * its cast (with images) and its shots without clips. Billing state starts
 * fresh. The step goes back to 'storyboard' (the furthest step that needs
 * no clips) if the source was past it; otherwise it stays.
 */
export async function duplicateProject({ userId, id }) {
  const src = await getProject({ userId, id });
  const db = storyDb();

  const [shots, [script], cast, [reference]] = await Promise.all([
    db.select('story_shots', { project_id: id }, { order: 'ord' }),
    db.select('story_scripts', { project_id: id }, { order: '-version', limit: 1 }),
    db.select('story_cast', { project_id: id }, { order: ['ord', 'created_at'] }),
    src.reference_id ? db.select('story_references', { id: src.reference_id, project_id: id }) : Promise.resolve([]),
  ]);

  const step = STEPS.indexOf(src.step) > STEPS.indexOf('storyboard') ? 'storyboard' : src.step;
  const title = `${src.title} copy`.slice(0, TEXT_LIMITS.title);

  const [copy] = await db.insert('story_projects', {
    ...strip(src, ['user_id', 'reference_id', 'fee_charged', 'rerolls_used', 'narrations_used', 'music_used', 'chat_used', 'status', 'step', 'title']),
    user_id: userId,
    title,
    step,
  });

  try {
    let referenceId = null;
    if (reference) {
      const [ref] = await db.insert('story_references', { ...strip(reference), project_id: copy.id });
      referenceId = ref.id;
    }
    if (script) {
      await db.insert('story_scripts', { ...strip(script), project_id: copy.id, version: 1 });
    }
    if (cast.length) {
      await db.insert('story_cast', cast.map((c) => ({ ...strip(c), project_id: copy.id })));
    }
    if (shots.length) {
      await db.insert(
        'story_shots',
        shots.map((s) => ({
          ...strip(s, ['error']),
          project_id: copy.id,
          clip_url: null,
          attempts: 0,
          status: s.still_url ? 'still_ready' : 'draft',
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
