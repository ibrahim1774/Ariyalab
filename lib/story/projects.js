import { storyDb } from './db.js';
import { ConflictError, NotFoundError, QuoteChangedError, ValidationError } from './errors.js';
import { screenText } from '../moderation.js';
import { assertAllowed, releaseAllowance } from './limits.js';
import { registerAction } from './actions.js';
import { linkBrandAssets, withBrandDefaults } from './assets.js';
import { getPricing } from '../pricing.js';
import { assertNoModeRewrite } from './drafting.js';
import { styleFragment } from './prompts/styles.js';

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
export const MIN_SECONDS = 7;
export const MAX_SECONDS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Customer-editable fields and their maximum text length (null = enum or number).
const TEXT_LIMITS = { title: 120, offer: 1000, audience: 500, style_custom: 300 };
const ENUMS = { purpose: PURPOSES, style: STYLES, aspect: ASPECTS, quality: QUALITIES, mode: MODES };
export const EDITABLE_FIELDS = Object.freeze([
  'title', 'purpose', 'offer', 'audience', 'style', 'style_custom', 'seconds', 'aspect', 'quality', 'mode', 'consistent_cast',
]);
const SCREENED_FIELDS = ['title', 'offer', 'audience', 'style_custom'];

function cleanFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Expected a JSON object.');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!EDITABLE_FIELDS.includes(key)) throw new ValidationError(`${key} cannot be set.`, { field: key });
    if (key === 'consistent_cast') {
      if (typeof value !== 'boolean') throw new ValidationError('consistent_cast must be true or false.', { field: key });
      out[key] = value;
    } else if (key === 'seconds') {
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

function requireUser(userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new NotFoundError();
}

/** `user` (optional) is the session user, passed through to the free-tier check. */
export async function createProject({ userId, input = {}, user }) {
  requireUser(userId);
  // The brand kit's offer and audience start the brief unless the request has its own (every caller: the site and the MCP tools).
  const fields = cleanFields(await withBrandDefaults({ userId, input }));
  await screen(fields);
  // Free-tier daily project cap, after validation and moderation so a refused request costs nothing.
  const allowance = await assertAllowed({ userId, action: 'project_create', user });
  try {
    const [project] = await storyDb().insert('story_projects', { ...fields, user_id: userId });
    // The kit's pictures are a convenience: a failure here never loses the project the customer just made.
    await linkBrandAssets({ userId, projectId: project.id }).catch((err) => console.error('[story] could not attach the brand kit', project.id, err?.message));
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
  const first = new Map();
  if (bare.length) {
    const shots = await storyDb().select('story_shots', { project_id: bare }, { columns: ['project_id', 'ord', 'still_url'], order: ['ord'] });
    for (const shot of shots) if (shot.still_url && !first.has(shot.project_id)) first.set(shot.project_id, shot.still_url);
  }
  // The newest finished render's file, so a card can offer a download without opening the project. Only the first 60
  // projects that reached review can have one (the rest get no card download); one query, newest version first.
  const latest = new Map();
  const can = projects.filter((p) => ['review', 'done'].includes(p.step) && p.status !== 'expired').slice(0, 60);
  if (can.length) {
    const rows = await storyDb().select('story_renders', { project_id: can.map((p) => p.id), status: 'done' }, { columns: ['project_id', 'version', 'file_url'], order: ['-version'], limit: 1000 });
    for (const r of rows) if (r.file_url && !latest.has(r.project_id)) latest.set(r.project_id, r);
  }
  return projects.map((p) => {
    const out = !p.thumbnail_url && first.has(p.id) ? { ...p, thumbnail_url: first.get(p.id) } : p;
    const r = latest.get(p.id);
    return r ? { ...out, latest_render_url: r.file_url, latest_render_version: r.version } : out;
  });
}

/**
 * expectedCredits: the redo total the customer was shown for a style change that remakes things already made (styleRedo.js);
 * without it, or with another number, that change is 409 quote_changed { credits, lines, render_credits } and nothing happens.
 */
export async function updateProject({ userId, id, patch, modeJob = false, expectedCredits }) {
  const current = await getProject({ userId, id });
  const fields = cleanFields(patch);
  if (Object.keys(fields).length === 0) throw new ValidationError('Nothing to update.');
  await screen(fields);
  const flagChanges = typeof fields.consistent_cast === 'boolean' && fields.consistent_cast !== current.consistent_cast;
  const modeChanges = typeof fields.mode === 'string' && fields.mode !== current.mode;
  const qualityChanges = typeof fields.quality === 'string' && fields.quality !== current.quality;
  // The look of the pictures: the same words the prompts use, so a change that does not change them marks nothing.
  const styleChanges = ('style' in fields || 'style_custom' in fields) && styleFragment({ ...current, ...fields }) !== styleFragment(current);
  // Not while a script is being rewritten for a new style (the rewrite itself sets the mode: modeJob).
  if (!modeJob && (flagChanges || modeChanges || styleChanges)) await assertNoModeRewrite(id);
  if (flagChanges || modeChanges || qualityChanges || styleChanges) await assertNoShotBeingMade(id);
  if (styleChanges) {
    const drawing = await storyDb().select('story_cast', { project_id: id, status: ['pending', 'draft'] }, { columns: ['id'], limit: 1 });
    if (drawing.length) throw new ConflictError('Some characters are still being drawn. Wait for them to finish, then change the style.', { code: 'shots_busy' });
  }
  if (styleChanges) {
    const rendering = await storyDb().select('story_renders', { project_id: id, status: ['queued', 'running'] }, { columns: ['id'], limit: 1 });
    if (rendering.length) throw new ConflictError('Your video is being put together. Wait for it to finish, then change the style.', { code: 'render_busy' });
    if (expectedCredits !== undefined && expectedCredits !== null && (!Number.isInteger(expectedCredits) || expectedCredits < 0)) {
      throw new ValidationError('The price must be a whole number of credits.', { field: 'expected_credits' });
    }
    // Remaking what is made costs credits: never without the customer seeing the total (every path, the website and the chat).
    // A cheap look first: nothing made, nothing to price (and the pricing modules are not loaded).
    const shotsMade = (await storyDb().select('story_shots', { project_id: id }, { columns: ['still_url', 'clip_url'] })).some((s) => s.still_url || s.clip_url);
    const castMade = !shotsMade && (await storyDb().select('story_cast', { project_id: id }, { columns: ['image_url', 'candidates'] })).some((c) => c.image_url || (Array.isArray(c.candidates) && c.candidates.length));
    const redo = shotsMade || castMade ? await (await import('./styleRedo.js')).styleRedo(current) : { made: false };
    if (redo.made && expectedCredits !== redo.total) {
      throw new QuoteChangedError(`Changing the style remakes your characters, pictures and clips. That costs ${redo.total} credits in all.`, { credits: redo.total, lines: redo.lines, render_credits: redo.render.credits });
    }
    // The reset comes first: if it fails the style is not saved and asking again does it all, and nothing old stays in use.
    await resetForNewStyle(current);
  }
  const [project] = await storyDb().update('story_projects', { id, user_id: userId }, fields);
  if (!project) throw new NotFoundError('Project not found.');
  if (modeChanges) await markClipsOutOfDateForMode(id);
  if (qualityChanges) await (await import('./storyboard.js')).applyProjectQuality(id, project.quality);
  if (typeof fields.consistent_cast === 'boolean' && fields.consistent_cast !== current.consistent_cast) {
    await resetPlanForCastChange(project);
  }
  return project;
}

/**
 * What a shot's picture is cleared to when what it was drawn from changed (a new art style, or the same-people switch): no
 * current picture, a new still round counted as a first picture of it, and the clip it has (if any) kept, marked out of
 * date and not matching. The price of a new picture is the one the shot already had (a delivered picture costs a re-roll).
 */
function clearedPicturePatch(shot) {
  return {
    still_url: null, still_key: null, still_round: shot.still_round + 1, still_base_round: shot.still_round + 1,
    status: 'draft', error: null, stale: true, clip_mismatch: true,
  };
}

/**
 * A new art style: nothing made in the old one may be used for new work.
 *  - every picture is cleared (clearedPicturePatch) and every finished clip is marked out of date; both are made again when
 *    the customer chooses, at the prices the screens show;
 *  - every drawn character (not one using the customer's own photo) is put back to "needs new pictures": no pictures, pick or
 *    sheet, style_stale set. It is drawn again with a regeneration (free while the included ones last), so no old-style
 *    picture is a reference or a first frame. The round moves on so a late picture of the old one never lands.
 *  - the project goes back to the cast step when characters were reset, and the plan marker is set so the free parts of the
 *    redo start by themselves; every paid part still asks for its price first.
 * Nothing is charged or refunded here. -> true when something was reset
 */
async function resetForNewStyle(project) {
  const db = storyDb();
  const shots = await db.select('story_shots', { project_id: project.id });
  let any = false;
  for (const shot of shots) {
    if ((shot.source || 'generated') === 'footage') continue;
    if (shot.still_url || shot.clip_url) {
      any = true;
      await db.update('story_shots', { id: shot.id }, clearedPicturePatch(shot));
    }
  }
  // Also on a different-people video: its old automatic pictures must never come back as references if the customer switches later.
  let reset = 0;
  const cast = await db.select('story_cast', { project_id: project.id });
  for (const c of cast) {
    if (c.asset_id || !(c.image_url || (Array.isArray(c.candidates) && c.candidates.length))) continue;
    await db.update('story_cast', { id: c.id }, {
      round: c.round + 1, status: 'ready', candidates: [], candidates_round: null, chosen_index: null, image_url: null, image_key: null,
      sheet: {}, style_stale: true, hold_id: null, hold_credits: 0,
    });
    reset += 1;
  }
  if (reset && project.consistent_cast !== false && STEPS.indexOf(project.step) > STEPS.indexOf('cast')) await db.update('story_projects', { id: project.id }, { step: 'cast' });
  if (any || reset) await db.update('story_projects', { id: project.id }, { plan_requested: true });
  return any || reset > 0;
}

const SHOT_BUSY = ['still_pending', 'queued', 'generating'];

/**
 * A narrator telling the story or the characters speaking changes what a clip is made to sound like (ambience only, or a
 * character's line). A finished clip made the other way no longer matches: it is kept, marked out of date, and made
 * again when the customer chooses (the same marks a cast change puts on a clip). Footage the customer brought stays.
 */
async function markClipsOutOfDateForMode(projectId) {
  const shots = await storyDb().select('story_shots', { project_id: projectId }, { columns: ['id', 'clip_url', 'source'] });
  const made = shots.filter((s) => s.source !== 'footage' && s.clip_url).map((s) => s.id);
  if (made.length) await storyDb().update('story_shots', { id: made }, { stale: true, clip_mismatch: true });
}

export async function assertNoShotBeingMade(projectId) {
  const shots = await storyDb().select('story_shots', { project_id: projectId }, { columns: ['id', 'status'] });
  if (shots.some((s) => SHOT_BUSY.includes(s.status))) {
    throw new ConflictError('Some pictures or clips are still being made. Wait for them to finish, then change this.', { code: 'shots_busy' });
  }
}

/**
 * Same people or different people in every scene is a different plan, so the plan is reset cleanly:
 *  - every generated shot loses its picture as the current one (the same fields a changed description clears), so the
 *    default "make pictures" start makes it again and Generate refuses it (still_missing); a clip it already has stays
 *    until it is made again, marked out of date and not matching;
 *  - every shot counts as planned from an older scene (scene_sig 'cast-changed'), so the storyboard shows needs_rebuild and
 *    the next build plans the shots again with the new setting;
 *  - switching to true while some character has no pick sends the project back to the cast step; the storyboard build
 *    and the pictures wait for the cast (storyboard.js assertCastReady).
 */
async function resetPlanForCastChange(project) {
  const db = storyDb();
  const shots = await db.select('story_shots', { project_id: project.id });
  for (const shot of shots) {
    const patch = { scene_sig: 'cast-changed' };
    if (shot.source !== 'footage' && (shot.still_url || shot.clip_url)) {
      Object.assign(patch, clearedPicturePatch(shot));
    }
    await db.update('story_shots', { id: shot.id }, patch);
  }
  if (project.consistent_cast !== false && STEPS.indexOf(project.step) > STEPS.indexOf('cast')) {
    const cast = await db.select('story_cast', { project_id: project.id });
    const picked = cast.length > 0 && cast.every((c) => c.chosen_index != null || c.image_url);
    if (!picked) await db.update('story_projects', { id: project.id }, { step: 'cast' });
  }
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
 * Paid starts (cast, stills, clips, re-rolls, narration, music, render) are
 * refused on a project whose files the retention cleanup removed: what they
 * would make would point at deleted files. A copy starts fresh.
 */
export const EXPIRED_MESSAGE = "This video's files were removed. Make a copy to continue.";
export function assertNotExpired(project) {
  if (project?.status === 'expired') throw new ConflictError(EXPIRED_MESSAGE, { code: 'project_expired' });
}

/**
 * Copies the project (title + " copy"), its reference, its latest script,
 * its cast (with images, regenerations reset), its shots without clips
 * (cast_ids pointed at the copied cast) and its asset links (the assets
 * themselves are the user's and are shared). Billing state starts fresh.
 *
 * Stored files are shared with the source, not copied. The copy gets a fresh
 * files_expire_at (now + retentionDays) when the source has files; the
 * retention cleanup deletes a shared key only once no unexpired project names
 * it (refcount), so the copy keeps its files after the source expires. When
 * the source has already expired, its file references are dropped instead. The step goes back to 'storyboard' (the furthest step that needs
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
  if (!expired && src.files_expire_at) {
    // The retention setting is not worth failing or stalling a copy for: 30 days when it cannot be read quickly.
    const days = Number(await Promise.race([
      getPricing().then((p) => p.retentionDays, () => 30),
      new Promise((resolve) => { setTimeout(() => resolve(30), 2000).unref?.(); }),
    ]));
    const ms = (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000;
    noFiles.files_expire_at = new Date(Date.now() + ms).toISOString();
  }
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
      // A character's own picture is a file of the customer's kit, which does not expire: the copy keeps it (the drawn options are gone).
      const ownIds = expired ? [...new Set(cast.map((c) => c.asset_id).filter(Boolean))] : [];
      const own = new Map((ownIds.length ? await db.select('story_assets', { id: ownIds, user_id: userId }) : []).map((a) => [a.id, a]));
      const copied = await db.insert(
        'story_cast',
        cast.map((c) => {
          if (!expired) return { ...strip(c), project_id: copy.id, status: settledCastStatus(c), regens_used: 0 };
          const mine = c.asset_id ? own.get(c.asset_id) : null;
          const base = { ...strip(c), project_id: copy.id, regens_used: 0, candidates: [], chosen_index: null, sheet: {} };
          return mine
            ? { ...base, status: 'ready', asset_id: mine.id, image_url: mine.url, image_key: mine.storage_key ?? null }
            : { ...base, status: 'draft', asset_id: null, image_url: null, image_key: null };
        })
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
