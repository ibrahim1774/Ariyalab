import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { completeJSON } from '../providers/llm.js';
import { ProviderError, SAFE_MESSAGES } from '../providers/errors.js';
import { fetchReference } from '../providers/fetchVideo.js';
import { downloadToFile } from '../providers/http.js';
import { isMock } from '../providers/mock.js';
import { transcribe } from '../providers/stt.js';
import { MOCK_STORAGE_PREFIX, deleteObject, deleteObjects, localPathFor, matchesMagic, putObject } from '../providers/storage.js';
import { ownBlobHost } from './blobHost.js';
import { registerAction } from './actions.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { assertAllowed, releaseAllowance } from './limits.js';
import { getProject } from './projects.js';
import { ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, buildAnalysisMessage } from './prompts/analysis.js';
import { REFERENCE_LIMITS, REFERENCE_MESSAGES, RIGHTS_STATEMENT, VIDEO_EXTENSION, referenceLinkHost } from './referenceRules.js';
import { enqueue, registerHandler, settleJob } from './runner.js';
import { ANALYZE_WORKER_PATH, kickWorker } from './workers.js';
import './mocks.js';

/*
 * Reference ingestion and analysis (spec 7.3 step 5, 10.5).
 *
 * A customer uploads a video (or picks a clip they already have) or pastes an
 * Instagram, TikTok or Facebook link. startAnalysis checks it, stores a
 * story_references row and queues one 'analyze' job. The job is a WORKER kind
 * (lib/story/runner.js WORKER_KINDS): only /api/story/worker/analyze runs it,
 * one job per call, inside a 300 s function. The run:
 *
 *   get the file (the upload, or fetchReference for a link)
 *   -> probe (more than 180 s fails)
 *   -> ffmpeg scene detection at 0.22, cuts closer than 0.3 s merged -> shots
 *   -> 2 frames per shot at 448 px wide (at most 80)
 *   -> transcribe the audio (skipped when there is no sound at all)
 *   -> the fast model reads frames + shots + transcript -> beat sheet
 *   -> one thumbnail per beat is stored; the source file and audio are deleted.
 *
 * Money: analysis is part of the project fee (spec 8), so it holds no credits.
 * A free account has a daily count (limits.js 'reference_analysis'). A failed
 * analysis gives the count back only when no paid provider call happened:
 * story_references.provider_started_at is written just BEFORE the first paid
 * call (download, transcription or the model) and checked by onFail. Once it
 * is set, any failure is final: nothing is ever called twice for one job.
 *
 * The reference row (see supabase/migrations/20261114001200_story_references.sql):
 *   { id, project_id, source_type 'upload'|'link', source_url, platform, asset_id,
 *     status 'pending'|'ready'|'failed', error, duration_seconds,
 *     cut_list [{ start, end }], transcript { text, words }, beat_sheet Beat[],
 *     frames [{ ord, url, key }], hook, structure, mood, suggested_mode,
 *     rights_confirmed, rights_confirmed_at, rights_statement, provider_started_at, job_id }
 *   Beat = { ord, start, end, visual, said, why }
 *
 * lib/story/script.js writes from beat_sheet when the reference is ready, and
 * its rule checker flags any line that repeats a transcript sentence.
 */

export const ANALYSIS = Object.freeze({
  maxSeconds: REFERENCE_LIMITS.maxSeconds,
  maxBytes: REFERENCE_LIMITS.maxBytes,
  sceneThreshold: 0.22,
  mergeCutsSeconds: 0.3,
  framesPerShot: 2,
  frameWidth: 448,
  maxFrames: 80,
  // Audio quieter than this everywhere has no speech: no transcription is paid for.
  silenceDb: -50,
  maxBeats: 40,
  // The whole run must end inside the worker route's 300 s.
  windowMs: 270_000,
  // Longest each paid call may take; each also gets no more than the window has left after the steps behind it.
  timeouts: Object.freeze({ fetch: 120_000, stt: 60_000, llm: 90_000 }),
  // Time kept back for the steps after each call. After the model: the thumbnail uploads and the source delete,
  // each bounded by storageMs.
  reserve: Object.freeze({ fetch: 110_000, stt: 60_000, llm: 35_000 }),
  storageMs: 15_000,
  // A call is not started with less than this.
  minTimeouts: Object.freeze({ fetch: 30_000, stt: 15_000, llm: 20_000 }),
  uploadDownloadMs: 60_000,
});

// Kinds of the customer's own assets that can be a reference. Only a 'reference_video' that is not in the
// brand kit is deleted after the analysis; a clip from the brand kit stays theirs.
const SOURCE_KINDS = ['reference_video', 'video_clip', 'screen_recording'];
const UPLOAD_PREFIX = (projectId) => `story-uploads/${projectId}/`;

/** Bounds a storage call that has no signal of its own: rejects after `ms` (the call itself may still finish). */
function withinMs(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const MESSAGES = {
  busy: 'Your video is still being analysed. It takes about a minute.',
  failed: 'We could not analyse this video. Try again, or use another video.',
  blocked: 'This video could not be analysed under our content rules. Try another video.',
  slow: 'The analysis took too long. Try a shorter video.',
};

// ---------------------------------------------------------------- ffmpeg

async function ffmpegBinary() {
  try {
    const mod = await import('@ffmpeg-installer/ffmpeg');
    return (mod.default || mod).path || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

/** Runs ffmpeg; -> { code, stderr }. Killed after timeoutMs. */
async function runFfmpeg(args, timeoutMs = 30_000) {
  const bin = await ffmpegBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostats', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** -> { duration, hasVideo, hasAudio } from `ffmpeg -i` output (duration null when unknown). */
export function parseProbe(stderr) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    hasVideo: /Stream #\d+:\d+.*?: Video:/.test(stderr),
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(stderr),
  };
}

async function probe(file) {
  const { stderr } = await runFfmpeg(['-i', file], 20_000);
  return parseProbe(stderr);
}

/** The pts_time of every frame showinfo printed (the frames select passed), in order. */
export function parseSceneTimes(stderr) {
  return [...String(stderr).matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t >= 0);
}

/** Cut times sorted, with every cut closer than `gap` to the one kept before it (or to the start) dropped. */
export function mergeCuts(times, gap = ANALYSIS.mergeCutsSeconds) {
  const out = [];
  let last = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t - last < gap) continue;
    out.push(round3(t));
    last = t;
  }
  return out;
}

/** Shots covering [0, duration] from merged cut times; a cut within `gap` of the end is dropped. */
export function shotsFromCuts(cuts, duration, gap = ANALYSIS.mergeCutsSeconds) {
  const inner = cuts.filter((t) => t > 0 && duration - t >= gap);
  const bounds = [0, ...inner, round3(duration)];
  return bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }));
}

/**
 * Which frames to grab: 2 per shot (at 1/3 and 2/3 of it) while that stays within maxFrames, otherwise one per shot
 * (its middle), and with more shots than maxFrames, one frame from each of maxFrames shots spread evenly.
 * -> [{ shot (index), t }]
 */
export function framePlan(shots, { perShot = ANALYSIS.framesPerShot, max = ANALYSIS.maxFrames } = {}) {
  const at = (s, f) => round3(s.start + (s.end - s.start) * f);
  if (shots.length * perShot <= max) {
    const fractions = perShot === 1 ? [0.5] : Array.from({ length: perShot }, (_, k) => (k + 1) / (perShot + 1));
    return shots.flatMap((s, i) => fractions.map((f) => ({ shot: i, t: at(s, f) })));
  }
  const picks = shots.length <= max ? shots.map((_, i) => i) : Array.from({ length: max }, (_, k) => Math.floor((k * shots.length) / max));
  return picks.map((i) => ({ shot: i, t: at(shots[i], 0.5) }));
}

async function detectCuts(file) {
  const filter = `scale=320:-2,select='gt(scene\\,${ANALYSIS.sceneThreshold})',showinfo`;
  const { code, stderr } = await runFfmpeg(['-i', file, '-map', '0:v:0', '-an', '-vf', filter, '-f', 'null', '-'], 60_000);
  if (code !== 0) throw new ProviderError('failed', REFERENCE_MESSAGES.notVideo, { cause: { message: `scene detection exit ${code}` } });
  return parseSceneTimes(stderr);
}

async function extractFrames(file, plan, dir) {
  const out = new Array(plan.length);
  let next = 0;
  async function worker() {
    while (next < plan.length) {
      const i = next;
      next += 1;
      const dest = path.join(dir, `frame-${String(i).padStart(3, '0')}.jpg`);
      const { code } = await runFfmpeg(['-ss', plan[i].t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${ANALYSIS.frameWidth}:-2`, '-q:v', '5', '-y', dest], 15_000);
      const data = code === 0 ? await readFile(dest).catch(() => null) : null;
      out[i] = data?.length ? { ...plan[i], file: dest, data } : null;
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return out.filter(Boolean);
}

/** The audio as small mono mp3 for transcription, or null when it is silent (or missing). */
async function speechAudio(input, dir) {
  const dest = path.join(dir, 'audio.mp3');
  const made = await runFfmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', dest], 45_000);
  if (made.code !== 0) return null;
  const { stderr } = await runFfmpeg(['-i', dest, '-af', 'volumedetect', '-f', 'null', '-'], 30_000);
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  if (max === undefined || max === '-inf' || Number(max) <= ANALYSIS.silenceDb) return null;
  return dest;
}

// ---------------------------------------------------------------- beats

/** The transcript words whose middle falls inside [start, end), joined with spaces. */
export function saidBetween(words, start, end) {
  return (Array.isArray(words) ? words : [])
    .filter((w) => {
      const mid = (Number(w.start) + Number(w.end)) / 2;
      return mid >= start && mid < end;
    })
    .map((w) => String(w.w || '').trim())
    .filter(Boolean)
    .join(' ');
}

const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The model's beats made trustworthy: sorted, clamped to [0, duration], start and end snapped to the nearest shot
 * boundary, made contiguous (no gaps, no overlaps), numbered from 1, and `said` refilled from the transcript. When
 * nothing usable is left, one beat per shot.
 */
export function normaliseBeats(raw, { shots, duration, words }) {
  const bounds = [...new Set([0, ...shots.map((s) => s.end)].map(round3))].sort((a, b) => a - b);
  const snap = (t) => bounds.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), bounds[0]);
  const list = (Array.isArray(raw) ? raw : [])
    .filter((b) => b && Number.isFinite(Number(b.start)) && Number.isFinite(Number(b.end)))
    .map((b) => ({ start: snap(Math.min(Math.max(Number(b.start), 0), duration)), end: snap(Math.min(Math.max(Number(b.end), 0), duration)), visual: clean(b.visual), why: clean(b.why) }))
    .sort((a, b) => a.start - b.start);
  const beats = [];
  for (const b of list) {
    const start = beats.length ? beats[beats.length - 1].end : 0;
    if (b.end - start < 0.05) continue;
    beats.push({ ...b, start });
  }
  if (beats.length) beats[beats.length - 1].end = round3(duration);
  const usable = beats.length ? beats : shots.map((s, i) => ({ start: s.start, end: s.end, visual: `Shot ${i + 1}`, why: '' }));
  return usable.slice(0, ANALYSIS.maxBeats).map((b, i, all) => {
    const end = i === all.length - 1 ? round3(duration) : b.end;
    return { ord: i + 1, start: round3(b.start), end, visual: b.visual || `Shot ${i + 1}`, said: saidBetween(words, b.start, end), why: b.why };
  });
}

// ---------------------------------------------------------------- the source file

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'story-analyze-'));
}

async function readHead(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Size, type and length checks shared by the start and the worker. Throws ValidationError (422) with the customer's message. */
async function checkFile(file, { bytes } = {}) {
  const size = bytes ?? (await stat(file)).size;
  if (size > ANALYSIS.maxBytes) throw new ValidationError(REFERENCE_MESSAGES.tooBig, { field: 'source' });
  if (!matchesMagic('video/mp4', await readHead(file))) throw new ValidationError(REFERENCE_MESSAGES.notVideo, { field: 'source' });
  const info = await probe(file);
  if (!info.hasVideo || !info.duration) throw new ValidationError(REFERENCE_MESSAGES.notVideo, { field: 'source' });
  if (info.duration > ANALYSIS.maxSeconds) throw new ValidationError(REFERENCE_MESSAGES.tooLong, { field: 'source' });
  return { ...info, bytes: size };
}

/**
 * An upload's storage key from its URL, when it is one of this project's uploads (.mp4 or .mov) in our own storage
 * (the mock store, or our Blob store's host); else null.
 */
export function uploadKey(projectId, url, { mock = isMock() } = {}) {
  if (typeof url !== 'string') return null;
  let key = null;
  if (mock && url.startsWith(MOCK_STORAGE_PREFIX)) {
    key = url.slice(MOCK_STORAGE_PREFIX.length);
  } else if (!mock) {
    const host = ownBlobHost();
    try {
      const u = new URL(url);
      if (host && u.protocol === 'https:' && u.hostname.toLowerCase() === host && !u.port) key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch {
      key = null;
    }
  }
  if (!key || key.includes('..') || !key.startsWith(UPLOAD_PREFIX(projectId)) || !VIDEO_EXTENSION.test(key)) return null;
  return key;
}

/** Makes a local copy of a stored file to check or read; -> { file, cleanup }. Mock files are read in place. */
async function localCopy(url, { timeoutMs, maxBytes = ANALYSIS.maxBytes } = {}) {
  const local = localPathFor(url);
  if (local) return { file: local, cleanup: async () => {} };
  if (isMock()) throw new ValidationError(REFERENCE_MESSAGES.upload, { field: 'source' });
  const dir = await tempDir();
  const file = path.join(dir, 'source.mp4');
  try {
    await downloadToFile(url, { dest: file, maxBytes, provider: 'storage', timeoutMs });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    if (/larger than/i.test(err?.message || '')) throw new ValidationError(REFERENCE_MESSAGES.tooBig, { field: 'source' });
    throw err;
  }
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Real mode: the size of a Blob upload, and proof it is in our store (head() uses our token). */
async function blobSize(url) {
  const { head } = await import('@vercel/blob');
  const info = await head(url);
  return info?.size ?? null;
}

const isBlobUrl = (url) => {
  try {
    const host = ownBlobHost();
    return Boolean(host) && new URL(url).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
};

/**
 * Deletes an uploaded source file. Browser uploads always land in Vercel Blob (lib/story/client.js uploadReference),
 * whatever backend lib/providers/storage.js writes to, so a Blob URL is deleted through Blob itself.
 */
async function deleteUpload({ url, key }) {
  const ms = ANALYSIS.storageMs;
  if (!isMock() && isBlobUrl(url)) {
    const { del } = await import('@vercel/blob');
    await withinMs(del(url, { abortSignal: AbortSignal.timeout(ms) }), ms + 1000, 'deleting the upload');
  } else if (key) {
    await withinMs(deleteObject({ key }), ms, 'deleting the upload');
  }
}

/**
 * Checks an upload source and returns what the job needs: { assetId, url, key, deleteAfter, info }.
 * `{ url }` is a file just uploaded for this project (story-uploads/<projectId>/...): it becomes a 'reference_video'
 * asset, deleted after the analysis. `{ assetId }` is one of the customer's assets.
 */
async function resolveUpload({ userId, projectId, source }) {
  if (source.assetId !== undefined) {
    if (typeof source.assetId !== 'string' || !source.assetId) throw new ValidationError(REFERENCE_MESSAGES.source, { field: 'source' });
    const [asset] = await storyDb().select('story_assets', { id: source.assetId, user_id: userId });
    if (!asset) throw new NotFoundError('That video could not be found.');
    if (!SOURCE_KINDS.includes(asset.kind)) throw new ValidationError(REFERENCE_MESSAGES.notVideo, { field: 'source' });
    if (asset.bytes > ANALYSIS.maxBytes) throw new ValidationError(REFERENCE_MESSAGES.tooBig, { field: 'source' });
    const copy = await localCopy(asset.url, { timeoutMs: 40_000 });
    try {
      const info = await checkFile(copy.file);
      const deleteAfter = asset.kind === 'reference_video' && !asset.in_brand_kit;
      return { assetId: asset.id, url: asset.url, key: deleteAfter ? asset.storage_key : null, deleteAfter, info };
    } finally {
      await copy.cleanup();
    }
  }
  const key = uploadKey(projectId, source.url);
  if (!key) throw new ValidationError(REFERENCE_MESSAGES.upload, { field: 'source' });
  try {
    return await registerUpload({ userId, source, key });
  } catch (err) {
    // A refused upload is this project's own file and is never used: remove it now (a missing one is no error).
    if (err instanceof ValidationError && err.message !== REFERENCE_MESSAGES.upload) {
      await deleteUpload({ url: source.url, key }).catch((e) => console.error('[story] could not delete a refused upload', key, e?.message));
    }
    throw err;
  }
}

/** Size, type and length of a fresh upload, then its 'reference_video' asset row. */
async function registerUpload({ userId, source, key }) {
  let bytes;
  if (!isMock()) {
    bytes = await blobSize(source.url).catch(() => null);
    if (bytes === null) throw new ValidationError(REFERENCE_MESSAGES.upload, { field: 'source' });
    if (bytes > ANALYSIS.maxBytes) throw new ValidationError(REFERENCE_MESSAGES.tooBig, { field: 'source' });
  } else {
    const local = localPathFor(source.url);
    const found = local ? await stat(local).catch(() => null) : null;
    if (!found?.isFile()) throw new ValidationError(REFERENCE_MESSAGES.upload, { field: 'source' });
    bytes = found.size;
    if (bytes > ANALYSIS.maxBytes) throw new ValidationError(REFERENCE_MESSAGES.tooBig, { field: 'source' });
  }
  const copy = await localCopy(source.url, { timeoutMs: 40_000 });
  let info;
  try {
    info = await checkFile(copy.file, { bytes });
  } finally {
    await copy.cleanup();
  }
  const [asset] = await storyDb().insert('story_assets', {
    user_id: userId,
    kind: 'reference_video',
    name: clean(source.name || path.basename(key), 120) || 'Reference video',
    url: source.url,
    storage_key: key,
    mime: /\.mov$/i.test(key) ? 'video/quicktime' : 'video/mp4',
    bytes,
    duration_seconds: info.duration,
  });
  return { assetId: asset.id, url: source.url, key, deleteAfter: true, info };
}

// ---------------------------------------------------------------- view

/** What the screen gets. The transcript stays on the server; each beat carries its thumbnail. */
export function referenceView(ref) {
  if (!ref) return null;
  const thumbs = new Map((Array.isArray(ref.frames) ? ref.frames : []).map((f) => [f.ord, f.url]));
  return {
    id: ref.id,
    status: ref.status,
    error: ref.status === 'failed' ? ref.error || MESSAGES.failed : null,
    source_type: ref.source_type,
    source_url: ref.source_url,
    platform: ref.platform,
    duration: ref.duration_seconds,
    beats: (Array.isArray(ref.beat_sheet) ? ref.beat_sheet : []).map((b) => ({ ...b, thumb: thumbs.get(b.ord) || null })),
    hook: ref.hook,
    structure: ref.structure,
    mood: ref.mood,
    mode: ref.suggested_mode,
    shots: Array.isArray(ref.cut_list) ? ref.cut_list.length : 0,
    rights_confirmed_at: ref.rights_confirmed_at,
    created_at: ref.created_at,
  };
}

async function currentReference(project) {
  if (!project.reference_id) return null;
  const [ref] = await storyDb().select('story_references', { id: project.reference_id, project_id: project.id });
  return ref || null;
}

/** The project's reference (the view), or null when it has none. */
export async function getReference({ userId, projectId }) {
  const project = await getProject({ userId, id: projectId });
  return referenceView(await currentReference(project));
}

/**
 * Removes a replaced reference and its stored thumbnails (best effort: retention catches anything left). A duplicated
 * project's reference shares the original's thumbnail files, so a key another of the owner's references still uses
 * is kept.
 */
async function dropReference(ref, userId) {
  let keys = (Array.isArray(ref.frames) ? ref.frames : []).map((f) => f.key).filter(Boolean);
  if (keys.length) {
    const projects = await storyDb().select('story_projects', { user_id: userId }, { columns: ['id'], order: 'id', limit: 5000 });
    const others = await storyDb().select('story_references', { project_id: projects.map((p) => p.id) }, { columns: ['id', 'frames'], order: 'id', limit: 5000 });
    const shared = new Set(others.filter((o) => o.id !== ref.id).flatMap((o) => (Array.isArray(o.frames) ? o.frames : []).map((f) => f.key)));
    keys = keys.filter((k) => !shared.has(k));
  }
  if (keys.length) await deleteObjects({ keys }).catch((err) => console.error('[story] could not delete old reference frames', ref.id, err?.message));
  await storyDb().remove('story_references', { id: ref.id, project_id: ref.project_id }).catch((err) => console.error('[story] could not remove old reference', ref.id, err?.message));
}

// ---------------------------------------------------------------- start

/**
 * Checks the source and the rights box, takes the daily count, stores the reference and queues the analyze job.
 * source: { type: 'upload', url } (a file just uploaded for this project) | { type: 'upload', assetId } |
 *         { type: 'link', url } (instagram.com, tiktok.com, facebook.com, fb.watch; www. and m. too).
 * Every refusal is a 422 before anything is counted, stored or queued. 409 while an analysis is running.
 * -> the reference view (status 'pending')
 */
export async function startAnalysis({ userId, projectId, source, rights, user }) {
  const project = await getProject({ userId, id: projectId });
  const type = source && typeof source === 'object' ? source.type : null;
  if (type !== 'upload' && type !== 'link') throw new ValidationError(REFERENCE_MESSAGES.source, { field: 'source' });
  if (type === 'link' && !referenceLinkHost(source.url)) throw new ValidationError(REFERENCE_MESSAGES.link, { field: 'source' });
  if (rights !== true) throw new ValidationError(REFERENCE_MESSAGES.rights, { field: 'rights' });

  const old = await currentReference(project);
  if (old?.status === 'pending') throw new ConflictError(MESSAGES.busy, { code: 'analysis_busy' });

  const upload = type === 'upload' ? await resolveUpload({ userId, projectId, source }) : null;
  // A fresh upload that is not going to be analysed: its file and asset row go.
  const dropAsset = async () => {
    if (!upload?.deleteAfter || source.assetId !== undefined) return;
    await deleteUpload({ url: upload.url, key: upload.key }).catch(() => {});
    await storyDb().remove('story_assets', { id: upload.assetId, user_id: userId }).catch(() => {});
  };

  let receipt;
  try {
    receipt = await assertAllowed({ userId, action: 'reference_analysis', user });
  } catch (err) {
    await dropAsset();
    throw err;
  }

  const db = storyDb();
  let ref = null;
  let claimed = false;
  try {
    [ref] = await db.insert('story_references', {
      project_id: project.id,
      source_type: type,
      source_url: type === 'link' ? source.url.trim() : null,
      asset_id: upload?.assetId ?? null,
      file_url: upload?.url ?? null,
      storage_key: upload?.key ?? null,
      duration_seconds: upload?.info.duration ?? null,
      status: 'pending',
      rights_confirmed: true,
      rights_confirmed_at: new Date().toISOString(),
      rights_statement: RIGHTS_STATEMENT,
    });
    // Compare and set: only one start can move the project from its old reference to a new one.
    const moved = await db.update('story_projects', { id: project.id, user_id: userId, reference_id: old?.id ?? null }, { reference_id: ref.id });
    if (!moved.length) throw new ConflictError(MESSAGES.busy, { code: 'analysis_busy' });
    claimed = true;
    const job = await enqueue({
      projectId: project.id,
      kind: 'analyze',
      payload: {
        referenceId: ref.id,
        receipt,
        source: type === 'link'
          ? { type, url: source.url.trim() }
          : { type, url: upload.url, assetId: upload.assetId, key: upload.key, deleteAfter: upload.deleteAfter },
      },
    });
    [ref] = await db.update('story_references', { id: ref.id }, { job_id: job.id });
  } catch (err) {
    if (claimed) await db.update('story_projects', { id: project.id, reference_id: ref.id }, { reference_id: old?.id ?? null }).catch(() => {});
    if (ref) await db.remove('story_references', { id: ref.id }).catch(() => {});
    await dropAsset();
    await releaseAllowance(receipt).catch(() => {});
    throw err;
  }
  if (old) await dropReference(old, userId).catch((err) => console.error('[story] could not drop the old reference', old.id, err?.message));
  await kickWorker(ANALYZE_WORKER_PATH);
  return referenceView(ref);
}

// ---------------------------------------------------------------- the job

/** Writes the paid-call marker before a paid provider call. A failed write stops the run before the call. */
async function markPaid(ref) {
  if (ref.paid) return;
  await storyDb().update('story_references', { id: ref.id, provider_started_at: null }, { provider_started_at: new Date().toISOString() });
  ref.paid = true;
}

/** Time a paid call may take, inside the window; a call is not started with less than its minimum. */
function budget(kind, deadline) {
  const ms = Math.min(ANALYSIS.timeouts[kind], deadline - Date.now() - ANALYSIS.reserve[kind]);
  if (ms < ANALYSIS.minTimeouts[kind]) throw new ProviderError('failed', MESSAGES.slow);
  return ms;
}

/** Customer errors raised while checking a file become provider failures with the same words (final, not retried). */
function asFailure(err) {
  if (err instanceof ValidationError) return new ProviderError('failed', err.message);
  return err;
}

async function analyse(job, ref, dir, deadline) {
  const p = job.payload || {};
  const src = p.source || {};
  let file;
  let audioFile = null;
  let platform = null;
  if (src.type === 'link') {
    await markPaid(ref);
    const fetched = await fetchReference(src.url, { timeoutMs: budget('fetch', deadline) });
    ref.cleanups.push(() => fetched.cleanup?.());
    file = fetched.filePath;
    audioFile = fetched.audioPath || null;
    platform = fetched.platform;
  } else {
    const copy = await localCopy(src.url, { timeoutMs: Math.max(10_000, Math.min(ANALYSIS.uploadDownloadMs, deadline - Date.now() - 150_000)) })
      .catch((err) => { throw err instanceof ValidationError ? err : new ProviderError('failed', REFERENCE_MESSAGES.upload, { cause: err }); });
    ref.cleanups.push(copy.cleanup);
    file = copy.file;
  }

  const info = await checkFile(file).catch((err) => { throw asFailure(err); });
  const duration = info.duration;
  const shots = shotsFromCuts(mergeCuts(await detectCuts(file)), duration);
  const frames = await extractFrames(file, framePlan(shots), dir);

  let transcript = { text: '', words: [] };
  const speech = audioFile || info.hasAudio ? await speechAudio(audioFile || file, dir) : null;
  if (speech) {
    await markPaid(ref);
    const out = await transcribe({ filePath: speech, timeoutMs: budget('stt', deadline) });
    transcript = { text: clean(out.text, 20_000), words: (out.words || []).map((w) => ({ w: String(w.w), start: Number(w.start), end: Number(w.end) })) };
  }

  await markPaid(ref);
  const answer = await completeJSON({
    tier: 'fast',
    name: 'story_analysis',
    system: ANALYSIS_SYSTEM,
    messages: [buildAnalysisMessage({
      duration,
      shots: shots.map((s) => ({ ...s, said: saidBetween(transcript.words, s.start, s.end) })),
      transcript,
      frames: frames.map((f) => ({ shot: f.shot, t: f.t, data: f.data.toString('base64') })),
    })],
    schema: ANALYSIS_SCHEMA,
    maxTokens: 6000,
    timeoutMs: budget('llm', deadline),
  });
  const beats = normaliseBeats(answer?.beats, { shots, duration, words: transcript.words });

  // One thumbnail per beat: the frame nearest the middle of the beat. Every other frame stays in the temp folder.
  // Stored in parallel under one signal, so storage after the paid model call ends inside the window.
  const signal = AbortSignal.timeout(Math.max(1000, Math.min(ANALYSIS.storageMs, deadline - Date.now())));
  const picks = beats.map((b) => {
    const mid = (b.start + b.end) / 2;
    return { b, frame: frames.reduce((best, f) => (!best || Math.abs(f.t - mid) < Math.abs(best.t - mid) ? f : best), null) };
  }).filter((p) => p.frame);
  const stored = await Promise.all(picks.map(({ b, frame }) => putObject({ key: `story/${job.project_id}/reference/${ref.id}/beat-${b.ord}.jpg`, body: frame.data, signal })
    .then((o) => ({ ord: b.ord, url: o.url, key: o.key }))));
  const kept = stored.sort((a, b) => a.ord - b.ord);
  return {
    duration: round3(duration),
    platform,
    cuts: shots,
    transcript,
    beats,
    frames: kept,
    hook: clean(answer?.hook, 400) || null,
    structure: clean(answer?.structure, 600) || null,
    mood: clean(answer?.musicMood, 200) || null,
    mode: answer?.mode === 'talking' ? 'talking' : 'narrated',
  };
}

/** Deletes the uploaded source (not a brand kit clip) and forgets it on the row. Logged, never thrown. */
async function deleteSource(job, ref) {
  const src = job.payload?.source || {};
  if (src.type !== 'upload' || !src.deleteAfter) return;
  try {
    await deleteUpload({ url: src.url, key: src.key });
    if (src.assetId) await storyDb().remove('story_assets', { id: src.assetId, user_id: job.user_id });
    await storyDb().update('story_references', { id: ref.id }, { file_url: null, storage_key: null, asset_id: null });
  } catch (err) {
    console.error('[story] could not delete a reference source; retention will', job.id, err?.message);
  }
}

export const analyzeHandler = {
  sync: true,

  run: async (job) => {
    const deadline = Date.now() + ANALYSIS.windowMs;
    const [row] = await storyDb().select('story_references', { id: job.payload?.referenceId, project_id: job.project_id });
    // A reference that was replaced or already finished is left alone, and nothing is called.
    if (!row || row.status !== 'pending' || (row.job_id && row.job_id !== job.id)) return { skipped: true };
    const ref = { id: row.id, paid: false, cleanups: [] };
    const dir = await tempDir();
    try {
      // A paid call already started for this reference (a run that died and came back): never call anything again.
      if (row.provider_started_at) throw new ProviderError('failed', MESSAGES.failed);
      return await analyse(job, ref, dir, deadline);
    } catch (err) {
      // Once a paid call may have started, nothing is retried: a rate limit is a final failure here.
      if (ref.paid && err instanceof ProviderError && err.code === 'rate_limited') {
        throw new ProviderError('failed', SAFE_MESSAGES.rate_limited, { cause: err.cause });
      }
      throw err;
    } finally {
      for (const fn of ref.cleanups) await Promise.resolve().then(fn).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await deleteSource(job, ref);
    }
  },

  onDone: async (job, result) => {
    if (!result || result.skipped) return;
    const written = await storyDb().update('story_references', { id: job.payload.referenceId, status: 'pending' }, {
      status: 'ready',
      error: null,
      duration_seconds: result.duration,
      platform: result.platform ?? null,
      cut_list: result.cuts,
      transcript: result.transcript,
      beat_sheet: result.beats,
      frames: result.frames,
      hook: result.hook,
      structure: result.structure,
      mood: result.mood,
      suggested_mode: result.mode,
    });
    if (!written.length) {
      // Applied before (a second onDone) or the reference is gone: only a gone one leaves files to remove.
      const [row] = await storyDb().select('story_references', { id: job.payload.referenceId });
      if (!row) await deleteObjects({ keys: (result.frames || []).map((f) => f.key) }).catch(() => {});
    }
    await settleJob(job);
  },

  // Database only (runner contract). The first onFail to flip the row gives the count back, and only when no
  // paid call had started.
  onFail: async (job, { blocked, error }) => {
    const message = blocked ? MESSAGES.blocked : !error || error === SAFE_MESSAGES.failed ? MESSAGES.failed : error;
    const rows = await storyDb().update('story_references', { id: job.payload?.referenceId, status: 'pending' }, { status: 'failed', error: message });
    if (rows.length && !rows[0].provider_started_at) await releaseAllowance(job.payload?.receipt);
  },
};

registerHandler('analyze', analyzeHandler);

// ---------------------------------------------------------------- actions

// GET /api/story/projects/[id]/analyze -> { reference }   (null when the project has none)
registerAction('analyze', {
  method: 'GET',
  handler: async ({ userId, projectId }) => ({ reference: await getReference({ userId, projectId }) }),
});

// POST /api/story/projects/[id]/analyze { source, rights: true } -> { reference }
registerAction('analyze', {
  method: 'POST',
  handler: async ({ userId, user, projectId, body }) => ({
    reference: await startAnalysis({ userId, projectId, source: body.source, rights: body.rights, user }),
  }),
});

export { ownBlobHost };
