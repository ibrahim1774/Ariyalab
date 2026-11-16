import path from 'node:path';

import { ModerationError, screenImage, screenText } from '../moderation.js';
import { isMock } from '../providers/mock.js';
import { MOCK_STORAGE_PREFIX, matchesMagic } from '../providers/storage.js';
import { ownBlobHost } from './blobHost.js';
import { runFfmpeg } from './checks.js';
import { registerAction } from './actions.js';
import { storyDb } from './db.js';
import { ConflictError, LimitError, NotFoundError, ValidationError } from './errors.js';
import { customerVideoArgs, imageInputArgs } from './mediaArgs.js';
import {
  ASSET_LIMITS, ASSET_MESSAGES, AUDIO_API_KINDS, BRAND_LIMITS, BRAND_MESSAGES, IMAGE_API_KINDS, IMAGE_DB_KINDS, IMAGE_MIME, VIDEO_API_KINDS,
  VIDEO_MIME, apiKind, brandPrefix, cleanColor, dbKind, imageExtension, videoExtension,
} from './assetRules.js';
import { deleteUpload, localCopy, parseAudioProbe, readHead, registerAudio, storedSize } from './voices.js';

export { ASSET_LIMITS, ASSET_MESSAGES, BRAND_LIMITS, brandPrefix };

/*
 * The customer's own pictures and clips (the brand kit and the files a video draws on), and the brand text.
 *
 * Uploads. The browser sends a PNG, JPG or WebP (at most 5 MB) or an MP4 or MOV (at most 200 MB and 5 minutes) straight
 * to Vercel Blob under story-brand/<userId>/ (the token route allows only that folder for that customer), then calls
 * registerAsset. The server looks at the stored file itself, in this order, and a file that fails any step is deleted and
 * answered with a specific 422: its key sits under the caller's own folder and our own store, its size, its first bytes
 * (never the browser's content type), and what ffmpeg says it is (the demuxer is forced, only the plain file protocol is
 * allowed, so a playlist saved as a picture or a clip is not read as one). Pictures are then checked by the content
 * rules (lib/moderation.js screenImage), which fails closed: a block deletes the file, an unavailable checker (503)
 * keeps nothing in the kit and leaves the file for another try. Clips are not content-checked (the customer's own
 * footage; the render pipeline never sends them to a model).
 *
 * Privacy: every lookup filters by user_id; another customer's asset id is a 404, the same as a missing one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The download of a clip of up to 200 MB, and the probe after it, stay well inside the route's 300 s.
const DOWNLOAD_MS = 200_000;
const log = (...args) => console.error('[story-assets]', ...args);

/** The most files one customer keeps (pictures, clips and audio together), so storage cannot grow without end. */
export const MAX_ASSETS = 200;

/** The picture, clip and audio kinds as the API names them. */
export const MEDIA_KINDS = Object.freeze([...IMAGE_API_KINDS, ...VIDEO_API_KINDS]);

// ---------------------------------------------------------------- views

/** How an asset is shown to the customer. */
export function assetView(a) {
  return {
    id: a.id,
    kind: apiKind(a.kind) || a.kind,
    name: a.name,
    url: a.url,
    seconds: a.duration_seconds ?? null,
    bytes: a.bytes ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
    inBrandKit: Boolean(a.in_brand_kit),
    created_at: a.created_at,
  };
}

// ---------------------------------------------------------------- registering an upload

/** The storage key of an upload of this customer's under their own folder of our own store, from its URL; null for anything else. */
export function brandUploadKey(userId, url, { mock = isMock() } = {}) {
  if (typeof url !== 'string') return null;
  let key = null;
  if (mock) {
    if (url.startsWith(MOCK_STORAGE_PREFIX)) {
      try {
        key = decodeURIComponent(url.slice(MOCK_STORAGE_PREFIX.length));
      } catch {
        key = null;
      }
    }
  } else {
    try {
      const u = new URL(url);
      const host = ownBlobHost();
      if (host && u.protocol === 'https:' && u.hostname.toLowerCase() === host && !u.port) key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch {
      key = null;
    }
  }
  if (!key || key.includes('..') || !key.startsWith(brandPrefix(userId))) return null;
  const rest = key.slice(brandPrefix(userId).length);
  if (!rest || rest.includes('/')) return null;
  return key;
}

/** -> { width, height } from an ffmpeg report of a decoded picture or clip (null when it names no picture stream). */
function parseSize(stderr) {
  const line = String(stderr).split('\n').find((l) => /Stream #\d+:\d+.*?: Video:/.test(l) && !/\(attached pic\)/.test(l));
  const m = line ? /,\s*(\d{1,5})x(\d{1,5})[\s,[]/.exec(`${line} `) : null;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
}

async function probeImage(file, mime) {
  const { stderr } = await runFfmpeg([...imageInputArgs(mime), '-i', file], { check: false, timeoutMs: 20_000 });
  const { width, height } = parseSize(stderr);
  // Decode it once: a file that only opens as a picture (right first bytes, nothing after them) is not one.
  const decoded = await runFfmpeg(['-v', 'error', ...imageInputArgs(mime), '-i', file, '-frames:v', '1', '-f', 'null', '-'], { check: false, timeoutMs: 20_000 });
  return { width, height, hasVideo: /: Video:/.test(stderr) && decoded.stderr.trim() === '' };
}

async function probeVideo(file) {
  const { stderr } = await runFfmpeg([...customerVideoArgs(), '-i', file], { check: false, timeoutMs: 30_000 });
  return { ...parseAudioProbe(stderr), ...parseSize(stderr) };
}

/** A picture or clip name the customer sees: single spaces, at most 120 characters. */
function cleanName(name, fallback) {
  return String(name || fallback).replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

/**
 * Registers a picture or clip the customer just uploaded (under story-brand/<userId>/) as an asset, or an audio file
 * (voice_sample, voice_track, music, audio) through lib/story/voices.js registerAudio.
 * kind: 'logo' | 'product' | 'mascot' (pictures), 'recording' | 'clip' (videos), or an audio kind.
 * inBrandKit: true only from the brand page (shows it in the kit, and new videos attach it); every other upload stays out of the kit.
 * -> the asset: { id, kind, name, url, seconds, bytes, width, height, inBrandKit }
 */
export async function registerAsset({ userId, kind, url, name, inBrandKit }) {
  if (AUDIO_API_KINDS.includes(kind)) return registerAudio({ userId, kind, url, name });
  const stored = dbKind(kind);
  if (!stored || !MEDIA_KINDS.includes(kind)) throw new ValidationError(ASSET_MESSAGES.kind, { field: 'kind' });
  const key = brandUploadKey(userId, url);
  if (!key) throw new ValidationError(ASSET_MESSAGES.upload, { field: 'url' });
  const isImage = IMAGE_API_KINDS.includes(kind);
  const ext = isImage ? imageExtension(key) : videoExtension(key);
  if (!ext) {
    // This customer's own upload under their own folder, and not a type we take: it is never used, so remove it.
    await deleteUpload({ url, key }).catch((e) => log('could not delete a refused upload', key, e?.message));
    throw new ValidationError(isImage ? ASSET_MESSAGES.wrongImage : ASSET_MESSAGES.wrongVideo, { field: 'url' });
  }
  const mime = isImage ? IMAGE_MIME[ext] : VIDEO_MIME[ext];
  const maxBytes = isImage ? ASSET_LIMITS.imageMaxBytes : ASSET_LIMITS.videoMaxBytes;
  const bytes = await storedSize(url).catch(() => null);
  if (bytes === null) throw new ValidationError(ASSET_MESSAGES.upload, { field: 'url' });
  if ((await storyDb().select('story_assets', { user_id: userId }, { columns: ['id'], limit: MAX_ASSETS })).length >= MAX_ASSETS) {
    // Not the customer's mistake in this file: it stays in storage so they can register it after deleting another.
    throw new LimitError(`You have ${MAX_ASSETS} files in your kit. Delete some you no longer use, then upload again.`, { code: 'asset_limit' });
  }

  let info;
  try {
    if (bytes > maxBytes) throw new ValidationError(isImage ? ASSET_MESSAGES.imageTooBig : ASSET_MESSAGES.videoTooBig, { field: 'url' });
    const copy = await localCopy(url, { maxBytes, tooBig: isImage ? ASSET_MESSAGES.imageTooBig : ASSET_MESSAGES.videoTooBig, timeoutMs: DOWNLOAD_MS });
    try {
      const refuse = (message) => new ValidationError(message, { field: 'url' });
      if (!matchesMagic(mime, await readHead(copy.file))) throw refuse(isImage ? ASSET_MESSAGES.notImage : ASSET_MESSAGES.notVideo);
      if (isImage) {
        info = await probeImage(copy.file, mime).catch(() => null);
        if (!info || !info.hasVideo || !info.width || !info.height) throw refuse(ASSET_MESSAGES.notImage);
      } else {
        info = await probeVideo(copy.file).catch(() => null);
        if (!info || !info.hasVideo || !info.duration || info.duration <= 0) throw refuse(ASSET_MESSAGES.notVideo);
        if (info.duration > ASSET_LIMITS.videoMaxSeconds) throw refuse(ASSET_MESSAGES.tooLong);
      }
    } finally {
      await copy.cleanup();
    }
    // Pictures only. A block is a refusal (the file is removed below); an unavailable checker throws a 503
    // ModerationError that keeps the file, so nothing enters the kit and the customer can register it again.
    if (isImage) await screenImage(url);
  } catch (err) {
    // Every failure removes the upload, except an unavailable content check: that file is fine and waits for another try.
    const unavailable = err instanceof ModerationError && err.reason === 'unavailable';
    if (!unavailable) await deleteUpload({ url, key }).catch((e) => log('could not delete a refused upload', key, e?.message));
    throw err;
  }
  const [row] = await storyDb().insert('story_assets', {
    user_id: userId,
    kind: stored,
    in_brand_kit: inBrandKit === true, // only the brand page asks for it
    name: cleanName(name, path.basename(key, `.${ext}`) || 'My file'),
    url,
    storage_key: key,
    mime,
    bytes,
    duration_seconds: isImage ? null : info.duration,
    width: info.width ?? null,
    height: info.height ?? null,
    metadata: {},
  });
  return assetView(row);
}

// ---------------------------------------------------------------- reading and deleting

/** The caller's own asset by id, or null (another customer's, a missing one and a malformed id all give null). */
export async function ownedAsset(userId, assetId) {
  if (typeof assetId !== 'string' || !UUID.test(assetId)) return null;
  const [row] = await storyDb().select('story_assets', { id: assetId, user_id: userId });
  return row || null;
}

/**
 * The caller's assets, newest first. kinds: API kinds to keep (default every kind); brandOnly: only the brand kit's.
 * -> [asset view]
 */
export async function listAssets({ userId, kinds, brandOnly = false }) {
  const match = { user_id: userId };
  if (brandOnly) match.in_brand_kit = true;
  if (Array.isArray(kinds) && kinds.length) {
    const stored = kinds.flatMap((k) => (dbKind(k) ? [dbKind(k)] : []));
    if (!stored.length) return [];
    match.kind = stored;
  }
  const rows = await storyDb().select('story_assets', match, { order: ['-created_at', '-id'], limit: 500 });
  return rows.filter((r) => apiKind(r.kind)).map(assetView);
}

/**
 * Deletes one of the caller's assets and its stored file. An asset a video still uses is not deleted:
 * 409 asset_in_use { projects: [{ id, title }], voices: [{ id, name }] }. The check and the delete are one SQL call.
 * -> { id }
 */
export async function deleteAsset({ userId, assetId }) {
  if (typeof assetId !== 'string' || !UUID.test(assetId)) throw new NotFoundError(ASSET_MESSAGES.notFound);
  const result = await storyDb().rpc('story_asset_delete', { p_user: userId, p_asset: assetId });
  if (!result) throw new NotFoundError(ASSET_MESSAGES.notFound);
  if (!result.deleted) {
    const projects = Array.isArray(result.projects) ? result.projects : [];
    const voices = Array.isArray(result.voices) ? result.voices : [];
    const names = projects.map((p) => `"${p.title || 'Untitled'}"`);
    throw new ConflictError(
      projects.length
        ? `This file is used in ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}. Take it out of ${names.length === 1 ? 'that video' : 'those videos'} first, then delete it.`
        : 'This file is the sample of a cloned voice. Delete the voice first, then the file.',
      { code: 'asset_in_use', projects, voices }
    );
  }
  const row = result.row;
  await deleteUpload({ url: row.url, key: row.storage_key }).catch((e) => log('could not delete a stored file', row.storage_key, e?.message));
  return { id: assetId };
}

// ---------------------------------------------------------------- brand text

const emptyBrand = () => ({ offer: null, audience: null, tone: null, avoid: [], colors: [], logo: null });

async function brandView(row) {
  if (!row) return emptyBrand();
  const logo = row.logo_asset_id ? await ownedAsset(row.user_id, row.logo_asset_id) : null;
  return {
    offer: row.offer ?? null,
    audience: row.audience ?? null,
    tone: row.tone ?? null,
    avoid: Array.isArray(row.avoid) ? row.avoid : [],
    colors: Array.isArray(row.colors) ? row.colors : [],
    logo: logo ? assetView(logo) : null,
  };
}

/** The caller's brand: { offer, audience, tone, avoid:[word], colors:['#rrggbb'], logo: asset | null }. Empty values when none is saved. */
export async function getBrand({ userId }) {
  const [row] = await storyDb().select('story_brand', { user_id: userId });
  return brandView(row);
}

function cleanText(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('That must be text.', { field });
  // A NUL character cannot be stored in a Postgres text column.
  const text = value.replace(/\u0000/g, '').trim();
  if (text.length > BRAND_LIMITS[field]) throw new ValidationError(`Keep this to ${BRAND_LIMITS[field]} characters or fewer.`, { field });
  return text === '' ? null : text;
}

/** The avoid list as a clean array: trimmed, no blanks, no repeats (case aside), at most 30 of at most 40 characters. */
export function cleanAvoidList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : null;
  if (!list) throw new ValidationError(BRAND_MESSAGES.avoid, { field: 'avoid' });
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') throw new ValidationError(BRAND_MESSAGES.avoid, { field: 'avoid' });
    const word = item.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    if (!word) continue;
    if (word.length > BRAND_LIMITS.avoidLength) throw new ValidationError(BRAND_MESSAGES.avoid, { field: 'avoid' });
    if (!out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  if (out.length > BRAND_LIMITS.avoidWords) throw new ValidationError(BRAND_MESSAGES.avoid, { field: 'avoid' });
  return out;
}

function cleanColors(value) {
  if (!Array.isArray(value) || value.length > BRAND_LIMITS.colors) throw new ValidationError(BRAND_MESSAGES.colors, { field: 'colors' });
  const out = [];
  for (const c of value) {
    const hex = cleanColor(c);
    if (!hex) throw new ValidationError(BRAND_MESSAGES.colors, { field: 'colors' });
    if (!out.includes(hex)) out.push(hex);
  }
  return out;
}

const BRAND_FIELDS = ['offer', 'audience', 'tone', 'avoid', 'colors', 'logoAssetId'];

/**
 * Saves the brand fields that are in the patch (the others are kept). offer, audience and tone are screened by the
 * content rules; the avoid words are not (a list of words to keep out of a video can fairly hold words the rules block).
 * logoAssetId: one of the caller's own logo pictures, or null to clear it. -> the brand (see getBrand)
 */
export async function saveBrand({ userId, patch }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new ValidationError('Say what to change.', { field: 'patch' });
  const bad = Object.keys(patch).find((k) => !BRAND_FIELDS.includes(k));
  if (bad) throw new ValidationError(`${bad} cannot be set.`, { field: bad });
  const next = {};
  for (const field of ['offer', 'audience', 'tone']) if (field in patch) next[field] = cleanText(patch[field], field);
  if ('avoid' in patch) next.avoid = cleanAvoidList(patch.avoid);
  if ('colors' in patch) next.colors = cleanColors(patch.colors);
  let logo = null;
  if ('logoAssetId' in patch) {
    if (patch.logoAssetId === null) {
      next.logo_asset_id = null;
    } else {
      logo = await ownedAsset(userId, patch.logoAssetId);
      if (!logo || logo.kind !== 'logo') throw new ValidationError(BRAND_MESSAGES.logo, { field: 'logoAssetId' });
      next.logo_asset_id = logo.id;
    }
  }
  const texts = ['offer', 'audience', 'tone'].map((k) => next[k]).filter((v) => typeof v === 'string' && v);
  if (texts.length) await screenText(texts);

  const db = storyDb();
  const write = async () => {
    const updated = await db.update('story_brand', { user_id: userId }, { ...next, updated_at: new Date().toISOString() });
    if (updated.length) return updated[0];
    return (await db.insert('story_brand', { user_id: userId, ...next }))[0];
  };
  let row;
  try {
    row = await write();
  } catch (err) {
    // Two first saves at the same moment: the loser updates the row the winner made.
    if (err?.code === '23505' || /duplicate key/i.test(err?.message || '')) row = await write();
    else throw err;
  }
  if (logo && !logo.in_brand_kit) await db.update('story_assets', { id: logo.id, user_id: userId }, { in_brand_kit: true });
  return brandView(row);
}

// ---------------------------------------------------------------- new projects

/**
 * The brief fields a new project starts with: the brand's offer and audience, unless the request gives its own.
 * (The tone and the words to avoid are read from the brand each time the script is written.)
 */
export async function withBrandDefaults({ userId, input }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input; // createProject refuses it in its own words
  const base = input;
  const [row] = await storyDb().select('story_brand', { user_id: userId });
  if (!row) return base;
  const out = { ...base };
  for (const field of ['offer', 'audience']) if (!(field in out) && row[field]) out[field] = row[field];
  return out;
}

const PROJECT_ROLES = Object.freeze(['product', 'logo', 'mascot']);

/** Attaches the brand kit's logo, product and mascot pictures to a new project (the product pictures are what its stills draw from). */
export async function linkBrandAssets({ userId, projectId }) {
  const rows = await storyDb().select('story_assets', { user_id: userId, in_brand_kit: true, kind: IMAGE_DB_KINDS }, { order: ['-created_at', '-id'], limit: 50 });
  const links = rows.map((a) => ({ project_id: projectId, asset_id: a.id, role: apiKind(a.kind) })).filter((l) => PROJECT_ROLES.includes(l.role));
  if (!links.length) return [];
  return storyDb().insert('story_project_assets', links);
}

// ---------------------------------------------------------------- a project's pictures

/** The pictures a project draws on: [{ ...asset view, role }]. */
export async function listProjectAssets({ userId, projectId }) {
  const links = await storyDb().select('story_project_assets', { project_id: projectId }, { order: 'created_at' });
  if (!links.length) return [];
  const assets = await storyDb().select('story_assets', { id: [...new Set(links.map((l) => l.asset_id))], user_id: userId });
  const byId = new Map(assets.map((a) => [a.id, a]));
  return links.filter((l) => byId.has(l.asset_id)).map((l) => ({ ...assetView(byId.get(l.asset_id)), role: l.role }));
}

/** Attaches one of the caller's own pictures to a project in a role (product, logo or mascot). The project is the caller's (the route checks). */
export async function attachProjectAsset({ userId, projectId, assetId, role }) {
  if (!PROJECT_ROLES.includes(role)) throw new ValidationError('Say what the picture is: a product, a logo or a mascot.', { field: 'role' });
  const asset = await ownedAsset(userId, assetId);
  if (!asset) throw new NotFoundError(ASSET_MESSAGES.notFound);
  if (!IMAGE_DB_KINDS.includes(asset.kind)) throw new ValidationError('Pick one of your own pictures.', { field: 'assetId' });
  const [existing] = await storyDb().select('story_project_assets', { project_id: projectId, asset_id: asset.id, role });
  if (!existing) await storyDb().insert('story_project_assets', { project_id: projectId, asset_id: asset.id, role });
  return { assets: await listProjectAssets({ userId, projectId }) };
}

/** Takes a picture out of a project (the file stays in the customer's kit). */
export async function detachProjectAsset({ userId, projectId, assetId, role }) {
  const match = { project_id: projectId, asset_id: String(assetId) };
  if (!UUID.test(match.asset_id)) throw new NotFoundError(ASSET_MESSAGES.notFound);
  if (role) match.role = role;
  await storyDb().remove('story_project_assets', match);
  return { assets: await listProjectAssets({ userId, projectId }) };
}

// ---------------------------------------------------------------- HTTP actions

// GET    /api/story/projects/[id]/assets                      -> { assets }  the pictures this video draws on, each with its role
// POST   /api/story/projects/[id]/assets  { assetId, role }   -> { assets }  role: product | logo | mascot
// DELETE /api/story/projects/[id]/assets  { assetId, role? }  -> { assets }  the file itself stays in the customer's kit
registerAction('assets', { method: 'GET', handler: async ({ userId, projectId }) => ({ assets: await listProjectAssets({ userId, projectId }) }) });
registerAction('assets', { method: 'POST', handler: async ({ userId, projectId, body = {} }) => attachProjectAsset({ userId, projectId, assetId: body.assetId, role: body.role }) });
registerAction('assets', { method: 'DELETE', handler: async ({ userId, projectId, body = {} }) => detachProjectAsset({ userId, projectId, assetId: body.assetId, role: body.role }) });
