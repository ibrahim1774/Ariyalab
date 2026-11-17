import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { randomUUID } from 'node:crypto';

import { HoldClosedError, HoldExceededError, holdCredits, releaseHold } from '../credits.js';
import { getPricing } from '../pricing.js';
import { ProviderError } from '../providers/errors.js';
import { downloadToFile } from '../providers/http.js';
import { localPathFor, putObject } from '../providers/storage.js';
import { registerAction } from './actions.js';
import { checkExpected, checkedAudioExt, narratorLines, parseSilence, resolveAudioPlan, sliceUrl, validExpected } from './audio.js';
import { audioInputArgs } from './audioProbe.js';
import { imageInputArgs, imageMime } from './mediaArgs.js';
import {
  CAPTION_FONT_FILE, buildCaptionEvents, captionFilterAvailable, captionPngs, toAss, unsupportedCharacters, wordsFromSegments, wordsFromShotLines,
} from './captions.js';
import { CHECK_MESSAGES, run as runChecks, ffmpegPath, probe, runFfmpeg, wordsOfTexts } from './checks.js';
import { storyDb } from './db.js';
import { renderFilename } from './filenames.js';
import { ConflictError, ValidationError } from './errors.js';
import { assertAllowed } from './limits.js';
import { getProject, assertNotExpired } from './projects.js';
import { enqueue, registerHandler, settleJob } from './runner.js';
import { RENDER_WORKER_PATH, deadlineSignal, kickWorker } from './workers.js';

/*
 * The finished video (Task 20): clips + narration + music -> one mp4 with
 * burned-in captions, checked, stored and versioned in story_renders.
 *
 *   startRender({ userId, projectId, user, expectedCredits? }) -> { render, charged }   POST /api/story/projects/[id]/render
 *     render is the public row (publicRender): { id, version, status, url, warnings, created_at, finished_at, error }
 *
 * Money (owner decision 2026-11-16; renderPrice): the first pricing.included.render renders of a project that
 * FINISHED (status 'done') are free; every start after that costs pricing.renderRegen credits. The price is decided
 * at start: the row is inserted with its hold id and price (hold_id, cost_credits), then the credits are held and
 * the job is queued carrying the hold (holdId / costCredits), so the runner releases it when the job fails (a
 * deadline abort, the sweep of a killed run) and onDone settles it (settleJob, once: keyed on the job) when the video
 * is stored. A failed render never counts and never charges. A hold that fails (402 insufficient_credits) removes
 * the row again, so no version is used; any later error releases the hold and fails the row.
 * expectedCredits (optional, the price on the button): a different price is 409 quote_changed { credits } and
 * nothing is held. A paid plan is required (limits.js 'render'), and the per-project 24 h cap applies after
 * recoverStalledRender has ended dead starts. A project renders one video at a time:
 * the queued story_renders row is the lock (unique index
 * story_renders_one_active, migration 20261114001300), so a second start is
 * 409 render_busy until the first ends done or failed. Every render is a new
 * version (1, 2, ...); older versions stay listed.
 *
 * A start is refused (409 audio_not_ready) while a narration or music job is
 * queued or running, when a narrated script has narrator lines and no
 * narration, or when the plan wants music and there is no track: a render
 * never quietly makes a video without its voice or music.
 *
 * The render job ('render', a one-shot worker kind) runs only in
 * pages/api/story/render-worker.js (maxDuration 300). It is never run twice:
 * any failure inside the run is final, and the sweep fails a run older than
 * 330 s ("The render stopped. Try again."). /status ends rows a dead request or
 * a dead job left behind (recoverStalledRender).
 *
 * Inputs are frozen in the row's `settings` at start (what the customer
 * pressed): shots (scene, clip url, seconds, footage fit and trim, inset),
 * the narration (url, checked extension, line timings), the narrator lines and
 * script words, the music, captions on/style, aspect and mode. A file that is
 * gone at run time fails the render: "Something changed while the video was
 * being made. Make it again."
 *
 * Pipeline (ffmpeg, cwd = a temp dir, relative names inside filter args; every
 * input is a local file read with `-protocol_whitelist file`, and a customer's
 * audio also with audioInputArgs(ext), so nothing is read as a playlist):
 *   1. narration: each scene's lines are placed at the start of that scene's
 *      first shot (planNarration). A scene whose speech is longer than its shots
 *      is sped up (atempo, at most 1.15); past that it runs on into the next
 *      scene (warning narration_overrun naming the scene), and speech past the
 *      video's end is a warning too, never a silent cut. A pause of more than
 *      3 s after a scene's narration is a narration_gap warning. -> voice.wav
 *   2. each shot -> seg<i>.mp4: fitted to the target size (footage: contain by
 *      default; cover crops), 30 fps, the last frame repeated when the clip is
 *      short, trimmed to the shot's seconds (a footage trim is clamped to the
 *      clip); an inset is overlaid in a rounded white frame (mask made once,
 *      alphamerge); the shot's captions are burned (ASS with the bundled font;
 *      without the ass filter, PNG lines drawn by sharp and overlaid with
 *      enable='between(t,a,b)', captions.format 'png'); the
 *      sound is the clip's own in talking mode. In talking mode each clip's
 *      speech is found with silencedetect: captions are spread inside it, and a
 *      line still speaking at the end of its shot is a line_cut warning.
 *      The source is deleted once its last segment is made.
 *   3. concat demuxer (stream copy) -> joined.mp4, segments deleted.
 *      Talking: the joined sound is the voice -> voice.wav.
 *   4. music: started 4 s in (when the track is at least 8 s), looped with a
 *      crossfade until the video ends, high-passed at 40 Hz -> music.wav.
 *   5. mix: voice + music ducked under it (sidechaincompress), two-pass
 *      loudnorm to -14 LUFS -> mix.m4a; mux -> final.mp4 (x264 capped at 8 Mb/s).
 *   6. checks (lib/story/checks.js): loudness on the mix, silence on the voice
 *      stem, words heard. The mix is made once more only for loudness, or for
 *      words when there is music to lower; the words are heard again only when
 *      they failed. The checks get the time left before the deadline less an
 *      upload reserve (40 s); under 15 s the words are not checked.
 *   7. putObject (deadline signal, tried twice), then onDone writes the row.
 */

export const RENDER_SIZES = Object.freeze({ '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] });
export const FPS = 30;
export const TARGET_LUFS = -14;
export const MUSIC_START_SECONDS = 4;
export const MUSIC_HIGHPASS_HZ = 40;
export const MAX_TEMPO = 1.15;
// A pause after a scene's narration longer than this is a narration_gap warning (narrated mode only).
export const GAP_WARN_SECONDS = 3;
// The music bed sits this far under the voice before ducking.
const MUSIC_GAIN_DB = -10;
// A queued render with no job after this long was left by a dead request.
export const STALE_START_MS = 30_000;
// Work dirs older than this were left by a killed run.
const STALE_DIR_MS = 10 * 60_000;
// How long a render may run when the worker passes no deadline.
const RENDER_WINDOW_MS = 280_000;
const IMAGE_KINDS = ['logo', 'product_photo', 'mascot', 'image'];
const VIDEO_KINDS = ['video_clip', 'screen_recording'];
const VOICE_TRACK_KINDS = ['voice_track', 'audio'];
const MUSIC_TRACK_KINDS = ['music', 'audio'];
const DEFAULT_INSET = { x: 0.5, y: 0.3, w: 0.45 };
// Speech in a clip (talking mode), as Task 19 cuts narration.
const SPEECH_DB = -35;
const SPEECH_MIN_SILENCE = 0.25;
// Time budget inside a run (see renderVideo): what the upload keeps, and the least a transcription is worth.
// captionsPng: draw captions as PNG overlays even when ffmpeg has the ass filter (tests of the fallback).
const DEFAULT_BUDGET = Object.freeze({ uploadReserveMs: 40_000, minTranscribeMs: 15_000, maxTranscribeMs: 120_000, captionsPng: false });
let budget = { ...DEFAULT_BUDGET };
/** Tests only: change the time budget; call with no argument to restore it. */
export function _configureRender(patch) {
  budget = { ...DEFAULT_BUDGET, ...(patch || {}) };
}

export const RENDER_MESSAGES = Object.freeze({
  changed: 'Something changed while the video was being made. Make it again.',
  stopped: 'The render stopped. Try again.',
  failed: 'The video could not be made. Try again.',
  late: 'The video took too long to make. Try again.',
  voice: 'Your voice recording could not be read. Upload it again as an mp3, wav or m4a file.',
  music: 'Your music track could not be read. Upload it again as an mp3, wav or m4a file.',
  footage: 'One of your clips has no picture. Pick another clip for that shot.',
  inset: 'One of your picture-in-picture files could not be read. Pick another file for that shot.',
  upload: 'The finished video could not be saved. Try again.',
});
const OWN_MESSAGES = new Set(Object.values(RENDER_MESSAGES));
const TOO_LONG = Object.freeze({ code: 'narration_overrun', message: 'The narration is longer than the video, so its last words are cut off. Shorten the script or add a shot.' });
const WORDS_UNCHECKED = CHECK_MESSAGES.words_unchecked;
const CAPTIONS_MISSING = { code: 'captions_missing', message: 'The captions could not be added to this video.' };

const busy = () => new ConflictError('Your video is already being made. Wait for it to finish, then make it again.', { code: 'render_busy' });
const notReady = (message) => new ConflictError(message, { code: 'audio_not_ready' });
const fail = (key) => new ProviderError('failed', RENDER_MESSAGES[key]);

/** [width, height] for a project aspect. */
export function renderTargetSize(aspect) {
  return RENDER_SIZES[aspect] || RENDER_SIZES['9:16'];
}

/** A shot the render can use: a generated shot with its clip, or a footage shot with its asset. */
export function renderable(shot) {
  if (shot.source === 'footage') return Boolean(shot.footage_asset_id);
  return shot.status === 'ready' && Boolean(shot.clip_url);
}

/** The public view of a story_renders row (no job ids, storage keys or frozen settings). */
export function publicRender(row) {
  if (!row) return null;
  const ended = row.status === 'done' || row.status === 'failed';
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    url: row.status === 'done' ? row.file_url || null : null,
    duration_seconds: row.status === 'done' ? row.duration_seconds ?? null : null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    created_at: row.created_at,
    finished_at: ended ? row.updated_at : null,
    error: row.status === 'failed' ? row.error || RENDER_MESSAGES.failed : null,
  };
}

/**
 * The price of the project's next render: { credits }. Free while fewer than pricing.included.render renders of the
 * project finished (failed ones never count), else pricing.renderRegen.
 */
export async function renderPrice(project) {
  const pricing = await getPricing();
  const included = Number(pricing.included?.render ?? 0);
  const done = await storyDb().select('story_renders', { project_id: project.id, status: 'done' }, { columns: ['id'], limit: Math.max(included, 0) + 1 });
  return { credits: done.length < included ? 0 : Number(pricing.renderRegen) || 0 };
}

const isClosedHold = (err) => err instanceof HoldClosedError || err instanceof HoldExceededError || /hold_not_found|hold_closed/.test(err?.message || '');
const releaseQuietly = (holdId, part) => releaseHold({ holdId, ...(part || {}) }).catch((e) => {
  if (!isClosedHold(e)) console.error('[story] render hold release failed', holdId, e?.message);
});

let deps = { enqueue, holdCredits };
/** Tests replace the queue and the hold call. Call with no argument to restore the real ones. */
export function _setRenderDeps(patch = {}) {
  deps = { enqueue: patch.enqueue || enqueue, holdCredits: patch.holdCredits || holdCredits };
}

const isUniqueViolation = (err, name) => String(err?.message || '').includes(name) || String(err?.details || '').includes(name);

async function ownedAssets(userId, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await storyDb().select('story_assets', { id: list, user_id: userId });
  return new Map(rows.map((a) => [a.id, a]));
}

async function latestScenes(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  return row?.scenes || [];
}

/** The extension of a file we stored (generated narration or music), from its key or url. */
function ownAudioExt(keyOrUrl) {
  const ext = path.extname(String(keyOrUrl || '').split('?')[0]).slice(1).toLowerCase();
  return ['mp3', 'wav', 'm4a'].includes(ext) ? ext : null;
}

/** 409 audio_not_ready when the voice or the music is missing or still being made (see the header). */
async function assertAudioReady(project, plan, scenes, assets) {
  const busyJobs = await storyDb().select('story_jobs', { project_id: project.id, kind: ['narration', 'music'], status: ['queued', 'running'] }, { columns: ['id'], limit: 1 });
  if (busyJobs.length) throw notReady('Your voice or music is still being made. Wait for it to finish, then make your video.');
  if (project.mode !== 'talking' && narratorLines(scenes).length && !project.narration_url) {
    throw notReady('Your script has narration but no voice yet. Make the narration on Voice and sound first.');
  }
  if (plan.music.type === 'generated' && !project.music_url) throw notReady('Your music is not made yet. Make it on Voice and sound, or pick no music.');
  if (plan.music.type === 'upload' && !assets.get(plan.music.assetId)) throw notReady('Your music track could not be found. Pick it again on Voice and sound.');
}

/** The inputs of a render, frozen at start (see the header). */
async function renderSettings(project, shots, plan, scenes, asset) {
  const [width, height] = renderTargetSize(project.aspect);
  const talking = project.mode === 'talking';

  let narration = null;
  if (!talking && project.narration_url) {
    const own = plan.voiceTrackAssetId && !project.narration_key ? asset(plan.voiceTrackAssetId) : null;
    if (own && !VOICE_TRACK_KINDS.includes(own.kind)) throw new ValidationError(RENDER_MESSAGES.voice, { field: 'voiceTrackAssetId' });
    const ext = own ? checkedAudioExt(own) : ownAudioExt(project.narration_key || project.narration_url);
    if (!ext) throw new ValidationError(RENDER_MESSAGES.voice, { field: 'voiceTrackAssetId' });
    // customer: the customer's own recording (forced demuxer); otherwise our own generated track (a plain file).
    narration = { url: project.narration_url, ext, customer: Boolean(own) || !project.narration_key };
  }
  let music = null;
  if (plan.music.type === 'generated' && project.music_url) {
    music = { url: project.music_url, ext: ownAudioExt(project.music_key || project.music_url), customer: false };
  } else if (plan.music.type === 'upload' && asset(plan.music.assetId)) {
    const track = asset(plan.music.assetId);
    if (!MUSIC_TRACK_KINDS.includes(track.kind)) throw new ValidationError(RENDER_MESSAGES.music, { field: 'music.assetId' });
    music = { url: track.url, ext: checkedAudioExt(track), customer: true };
  }
  if (music && !music.ext) throw new ValidationError(RENDER_MESSAGES.music, { field: 'music.assetId' });

  const lines = talking ? [] : narratorLines(scenes);
  return {
    aspect: RENDER_SIZES[project.aspect] ? project.aspect : '9:16',
    width,
    height,
    mode: talking ? 'talking' : 'narrated',
    captions: { on: plan.captions.on !== false, style: plan.captions.style },
    music: Boolean(music),
    musicUrl: music?.url || null,
    musicExt: music?.ext || null,
    musicCustomer: music ? music.customer : null,
    narrationUrl: narration?.url || null,
    narrationExt: narration?.ext || null,
    narrationCustomer: narration ? narration.customer : null,
    narrationSegments: narration ? project.narration_segments || null : null,
    lines,
    // The words the finished video must say, as the script was when the render started.
    scriptWords: talking ? wordsOfTexts(shots.map((s) => s.line)) : narration ? wordsOfTexts(lines.map((l) => l.text)) : [],
    sceneTitles: Object.fromEntries((Array.isArray(scenes) ? scenes : []).map((s) => [s.id, String(s.title || '')])),
    totalSeconds: shots.reduce((n, s) => n + Number(s.seconds), 0),
    shots: shots.map((s) => {
      const footage = s.source === 'footage' ? asset(s.footage_asset_id) : null;
      if (s.source === 'footage' && (!footage || !VIDEO_KINDS.includes(footage.kind))) {
        throw new ValidationError('A footage shot needs one of your video clips. Pick a clip for it.', { field: 'footage_asset_id', shotId: s.id });
      }
      const inset = s.inset_asset_id ? asset(s.inset_asset_id) : null;
      if (s.inset_asset_id && (!inset || ![...IMAGE_KINDS, ...VIDEO_KINDS].includes(inset.kind))) {
        throw new ValidationError('An inset must be one of your pictures or clips. Pick another one.', { field: 'inset_asset_id', shotId: s.id });
      }
      return {
        id: s.id,
        ord: s.ord,
        sceneId: s.scene_id || null,
        seconds: Number(s.seconds),
        source: s.source,
        url: footage ? footage.url : s.clip_url,
        // A customer's own video is opened with a forced demuxer (N9); our generated clips are plain files.
        customer: Boolean(footage),
        trimStart: footage ? Math.max(0, Number(s.footage?.trimStart) || 0) : 0,
        // Footage is fitted (letterboxed) unless the customer asked for it to fill the frame (design 264).
        fit: footage ? (s.footage?.fit === 'cover' ? 'cover' : 'contain') : 'cover',
        line: s.line || null,
        inset: inset ? { url: inset.url, image: IMAGE_KINDS.includes(inset.kind), mime: inset.mime || null, customer: true, ...DEFAULT_INSET, ...pickInset(s.inset) } : null,
      };
    }),
  };
}

function pickInset(raw) {
  const out = {};
  for (const k of ['x', 'y', 'w']) {
    const v = Number(raw?.[k]);
    if (Number.isFinite(v) && v > 0 && v < 1) out[k] = v;
  }
  return out;
}

/**
 * Ends queued renders a dead request left without a job, and rows whose job already ended. Runs on start, /status
 * and the stale-hold sweeper. A row with no job older than STALE_START_MS: when a render job was queued for it (the
 * request died before linking it) it is linked; otherwise it is failed and its hold released. A row whose job failed
 * needs no release here: the runner released the job's hold share before it marked the job applied.
 */
export async function recoverStalledRender(projectId) {
  const rows = await storyDb().select('story_renders', { project_id: projectId, status: ['queued', 'running'] });
  for (const row of rows) {
    if (!row.job_id) {
      if (Date.now() - Date.parse(row.created_at) > STALE_START_MS) {
        const jobs = await storyDb().select('story_jobs', { project_id: projectId, kind: 'render' }, { columns: ['id', 'payload'], order: '-created_at', limit: 50 });
        const queued = jobs.find((j) => j.payload?.renderId === row.id);
        if (queued) {
          await storyDb().update('story_renders', { id: row.id, job_id: null }, { job_id: queued.id });
          continue;
        }
        const [ended] = await storyDb().update('story_renders', { id: row.id, status: row.status, job_id: null }, { status: 'failed', error: 'The render did not start. Try again.' });
        if (ended && row.hold_id) await releaseQuietly(row.hold_id);
      }
      continue;
    }
    const [job] = await storyDb().select('story_jobs', { id: row.job_id }, { columns: ['id', 'status', 'error', 'applied_at'] });
    if (!job || ((job.status === 'failed' || job.status === 'blocked') && job.applied_at)) {
      await storyDb().update('story_renders', { id: row.id, status: row.status }, { status: 'failed', error: renderError(job?.error) });
    }
  }
}

const renderError = (error) => (OWN_MESSAGES.has(error) ? error : RENDER_MESSAGES.stopped);

/** Queues a new render version of the project. -> { render (the public row), charged (credits held) }. */
export async function startRender({ userId, projectId, user, expectedCredits }) {
  validExpected(expectedCredits);
  const project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  // Recovery first, so a render a dead request left behind no longer counts against the cap.
  await recoverStalledRender(projectId);
  await assertAllowed({ userId, action: 'render', projectId, user });
  const shots = await storyDb().select('story_shots', { project_id: projectId }, { order: 'ord' });
  const waiting = shots.filter((s) => !renderable(s));
  if (!shots.length || waiting.length) {
    throw new ConflictError('Every shot needs its clip before the video can be made.', { code: 'shots_not_ready', shotIds: waiting.map((s) => s.id) });
  }
  const plan = resolveAudioPlan(project);
  const scenes = await latestScenes(projectId);
  const assets = await ownedAssets(project.user_id, [
    ...shots.flatMap((s) => [s.source === 'footage' ? s.footage_asset_id : null, s.inset_asset_id]),
    plan.music.type === 'upload' ? plan.music.assetId : null,
    plan.voiceTrackAssetId,
  ]);
  await assertAudioReady(project, plan, scenes, assets);
  const settings = await renderSettings(project, shots, plan, scenes, (id) => (id ? assets.get(id) || null : null));
  const { credits } = await renderPrice(project);
  checkExpected(expectedCredits, credits);
  const holdId = credits > 0 ? randomUUID() : null;

  // The row is the lock (story_renders_one_active) and names its hold before the hold exists, so a request killed
  // from here on leaves a row recoverStalledRender ends (failed, hold released).
  let row = null;
  for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
    const [last] = await storyDb().select('story_renders', { project_id: projectId }, { columns: ['version'], order: '-version', limit: 1 });
    try {
      [row] = await storyDb().insert('story_renders', {
        project_id: projectId, version: (last?.version || 0) + 1, status: 'queued', settings, hold_id: holdId, cost_credits: credits,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'story_renders_one_active')) throw busy();
      if (!isUniqueViolation(err, 'story_renders_version_unique')) throw err;
    }
  }
  if (!row) throw busy();

  if (holdId) {
    try {
      await deps.holdCredits({ userId: project.user_id, currency: 'video', amount: credits, projectId, holdId });
    } catch (err) {
      // Nothing was held (402 insufficient_credits): the start never happened, so it leaves no version behind.
      await storyDb().remove('story_renders', { id: row.id, status: 'queued', job_id: null })
        .catch((e) => console.error('[story] could not remove a render row after its hold failed', row.id, e?.message));
      throw err;
    }
  }

  let job;
  try {
    job = await deps.enqueue({ projectId, kind: 'render', payload: { renderId: row.id }, holdId, costCredits: holdId ? credits : null });
  } catch (err) {
    if (holdId) await releaseQuietly(holdId);
    await storyDb().update('story_renders', { id: row.id }, { status: 'failed', error: 'The render did not start. Try again.' }).catch(() => {});
    throw err;
  }
  const [linked] = await storyDb().update('story_renders', { id: row.id }, { job_id: job.id });
  await kickWorker(RENDER_WORKER_PATH);
  return { render: publicRender(linked || { ...row, job_id: job.id }), charged: credits };
}

// ---------------------------------------------------------------- narration placement

/**
 * Where each scene's narration goes on the video's timeline (pure).
 *   segments  [{ sceneId, lineIndex, text, start, end }] in the narration track
 *   shots     [{ sceneId, seconds }] in order
 * -> { groups: [{ sceneId, from, to, at, tempo, length }], segments (placed: start/end on the video), warnings }
 * A scene's lines start with its first shot (or right after the scene before, when that one ran on); speech
 * longer than the scene's shots is sped up to MAX_TEMPO and then runs on. Segments of a scene with no shots join
 * the group before them.
 */
export function planNarration({ segments = [], shots = [], totalSeconds, titles = {} }) {
  const T = Number.isFinite(totalSeconds) ? totalSeconds : shots.reduce((n, s) => n + s.seconds, 0);
  const span = new Map();
  let t = 0;
  for (const s of shots) {
    const id = s.sceneId ?? null;
    if (!span.has(id)) span.set(id, { start: t, end: t + s.seconds });
    else span.get(id).end = t + s.seconds;
    t += s.seconds;
  }
  const groups = [];
  for (const seg of segments) {
    const known = span.has(seg.sceneId);
    const last = groups[groups.length - 1];
    if (last && (last.sceneId === seg.sceneId || !known)) last.segments.push(seg);
    else groups.push({ sceneId: known ? seg.sceneId : null, segments: [seg] });
  }
  const warnings = [];
  const placed = [];
  let prevEnd = 0;
  let prevId = null;
  const name = (id) => (titles[id] ? `"${titles[id]}"` : 'one scene');
  const out = groups.map((g) => {
    const from = Math.min(...g.segments.map((x) => x.start));
    const to = Math.max(...g.segments.map((x) => x.end));
    const speech = Math.max(0, to - from);
    const scene = span.get(g.sceneId) || { start: prevEnd, end: T };
    const at = Math.max(scene.start, prevEnd);
    const room = scene.end - at;
    const tempo = speech > room + 1e-9 ? (room > 0 ? Math.min(MAX_TEMPO, speech / room) : MAX_TEMPO) : 1;
    const length = speech / tempo;
    if (at + length > scene.end + 0.05) {
      // A scene pushed late by the one before is not its own fault: say which scene ran on (N4).
      const late = at > scene.start + 0.05 && speech / MAX_TEMPO <= scene.end - scene.start + 0.05;
      warnings.push({
        code: 'narration_overrun',
        message: late
          ? `The narration for ${name(prevId)} runs on past its shots, so the narration for ${name(g.sceneId)} starts late and runs past its own.`
          : `The narration for ${name(g.sceneId)} is longer than its shots, so it runs on past them.`,
      });
    }
    prevId = g.sceneId;
    for (const seg of g.segments) placed.push({ ...seg, start: at + (seg.start - from) / tempo, end: at + (seg.end - from) / tempo });
    prevEnd = at + length;
    return { sceneId: g.sceneId, from, to, at, tempo, length };
  });
  if (prevEnd > T + 0.05) warnings.push(TOO_LONG);
  // A long pause after a scene's narration (to the next scene's, or to the end): said, not remixed (round 3, R2).
  out.forEach((g, i) => {
    const next = i + 1 < out.length ? out[i + 1].at : T;
    if (next - (g.at + g.length) > GAP_WARN_SECONDS) {
      warnings.push({ code: 'narration_gap', message: `The narration for ${name(g.sceneId)} ends well before its shots do, so there is a long pause. Lengthen the line or shorten the shots.` });
    }
  });
  return { groups: out, segments: placed, warnings };
}

// ---------------------------------------------------------------- local files

/** Local copies of the run's inputs: each url downloaded once, deleted after its last use. */
function fileStore(dir, signal) {
  const files = new Map();
  let n = 0;
  return {
    async get(url, uses = 1) {
      if (files.has(url)) return files.get(url).path;
      const local = localPathFor(url);
      let p;
      if (local) {
        if (!existsSync(local)) throw fail('changed');
        p = local;
      } else {
        n += 1;
        const dest = path.join(dir, `in${n}`);
        try {
          ({ filePath: p } = await downloadToFile(url, { maxBytes: 500 * 1024 * 1024, dest, provider: 'storage', signal }));
        } catch (err) {
          if (signal?.aborted) throw fail('late');
          throw fail('changed');
        }
      }
      files.set(url, { path: p, uses, ours: !local });
      return p;
    },
    async done(url) {
      const f = files.get(url);
      if (!f) return;
      f.uses -= 1;
      if (f.uses <= 0) {
        files.delete(url);
        if (f.ours) await rm(f.path, { force: true });
      }
    },
  };
}

/** Removes work dirs a killed run left behind (older than 10 minutes). */
async function removeStaleDirs() {
  const tmp = os.tmpdir();
  const names = await readdir(tmp).catch(() => []);
  await Promise.all(names.filter((n) => n.startsWith('story-render-') || n.startsWith('story-checks-')).map(async (n) => {
    const p = path.join(tmp, n);
    const info = await stat(p).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_DIR_MS) await rm(p, { recursive: true, force: true }).catch(() => {});
  }));
}

const FILE_ONLY = ['-protocol_whitelist', 'file'];
// A customer's video (mp4 or mov, checked on upload by kind) is opened with the mov demuxer forced, so a playlist
// saved under a video name is never read as a playlist (its file:// entries would pass the file whitelist).
const CUSTOMER_VIDEO = [...FILE_ONLY, '-f', 'mov'];
/** How to open a frozen audio input: a customer's upload forces its demuxer; ours is a plain local file. */
const audioArgs = (ext, customer) => (customer === false ? FILE_ONLY : audioInputArgs(ext));
/** How to open a shot's video input. */
const videoArgs = (customer) => (customer ? CUSTOMER_VIDEO : FILE_ONLY);
/**
 * How to open an inset picture: always a customer's upload, so the image demuxer its type promised is forced (a playlist
 * saved as a .png is never read as a playlist). The type is the one registered on upload, else the file's extension; a
 * picture of neither kind is not used (the inset message).
 */
function insetImageArgs(inset) {
  const mime = imageMime(inset.mime, inset.url);
  if (!mime) throw fail('inset');
  return imageInputArgs(mime);
}

// ---------------------------------------------------------------- video

const fitFilter = (fit, w, h) => (fit === 'contain'
  ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);

/** Alpha mask for a rounded rectangle of radius R on a W x H frame (geq expression). */
const roundedMask = (r) => `if(lte(hypot(max(max(${r}-X,X-(W-1-${r})),0),max(max(${r}-Y,Y-(H-1-${r})),0)),${r}),255,0)`;

// An inset is at most this share of the frame's height, so a tall picture never covers the whole frame.
const INSET_MAX_HEIGHT = 0.4;
const even = (n) => Math.max(16, Math.round(n / 2) * 2);

/** The inset's size inside its frame, and its rounded mask (made once per size). -> { w, h, border, mask } */
async function insetLayout({ inset, src, settings, dir, signal, masks }) {
  const info = await probe(src, { cwd: dir, signal, inputArgs: inset.image ? insetImageArgs(inset) : videoArgs(inset.customer !== false) });
  if (!info.hasVideo) throw fail('inset');
  // A picture is decoded once here: a file that only looks like one (a playlist, text) opens but never yields a frame,
  // and the looped input in the segment would wait for one for ever.
  if (inset.image) {
    try {
      const decoded = await runFfmpeg(['-v', 'error', '-y', ...insetImageArgs(inset), '-i', src, '-frames:v', '1', '-f', 'null', '-'], { cwd: dir, signal, timeoutMs: 30_000 });
      if (String(decoded?.stderr || '').trim()) throw new Error('not a picture');
    } catch (err) {
      if (signal?.aborted) throw err;
      throw fail('inset');
    }
  }
  const boxW = even(settings.width * inset.w);
  const boxH = even(settings.height * INSET_MAX_HEIGHT);
  const k = info.width && info.height ? Math.min(boxW / info.width, boxH / info.height) : 1;
  const w = info.width ? even(info.width * k) : boxW;
  const h = info.height ? even(info.height * k) : boxH;
  const border = Math.max(2, Math.round(Math.min(settings.width, settings.height) / 180));
  const radius = Math.round(Math.min(w, h) / 12);
  const W = w + 2 * border;
  const H = h + 2 * border;
  const name = `mask${W}x${H}.png`;
  if (!masks.has(name)) {
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1`, '-vf', `format=gray,geq=lum='${roundedMask(radius)}'`, '-frames:v', '1', name], { cwd: dir, signal });
    masks.add(name);
  }
  return { w, h, border, mask: name, hasVideo: info.hasVideo };
}

/** The clip's speech (talking mode): -> { window: [start, end] | null, runsOver } in seconds of the shot. */
async function clipSpeech({ src, shot, dir, signal }) {
  const info = await probe(src, { cwd: dir, signal, inputArgs: videoArgs(shot.customer) });
  if (!info.hasAudio) return { window: null, runsOver: false };
  const { stderr } = await runFfmpeg([
    ...videoArgs(shot.customer), ...(shot.trimStart ? ['-ss', String(shot.trimStart)] : []), '-i', src,
    '-vn', '-af', `silencedetect=noise=${SPEECH_DB}dB:d=${SPEECH_MIN_SILENCE}`, '-f', 'null', '-',
  ], { cwd: dir, signal, check: false, timeoutMs: 60_000 });
  let spans;
  try {
    const parsed = parseSilence(stderr);
    const length = parsed.duration - shot.trimStart;
    spans = parsed.spans.map(([a, b]) => [a, Math.min(b, length)]).filter(([a, b]) => b > a);
  } catch {
    return { window: null, runsOver: false };
  }
  // One stretch of sound over (nearly) the whole clip is music or ambience, not a line: no reliable speech window.
  const available = Math.max(0, (Number.isFinite(info.duration) ? info.duration : shot.seconds) - shot.trimStart);
  if (spans.length === 1 && spans[0][0] < 0.15 && spans[0][1] > available - 0.15) return { window: null, runsOver: false };
  const inside = spans.filter(([a]) => a < shot.seconds - 0.05);
  if (!inside.length) return { window: null, runsOver: false };
  const lastEnd = inside[inside.length - 1][1];
  return { window: [inside[0][0], Math.min(shot.seconds, lastEnd)], runsOver: lastEnd > shot.seconds + 0.1 };
}

/** One normalised segment per shot (step 2). */
async function renderSegment({ shot, index, settings, dir, signal, src, insetSrc, assFile, pngs = [], masks }) {
  const { width: W, height: H } = settings;
  const secs = shot.seconds;
  const info = await probe(src, { cwd: dir, signal, inputArgs: videoArgs(shot.customer) });
  if (!info.hasVideo) throw fail('footage');
  // A trim past the clip's end would leave nothing: clamped so the shot still gets its seconds when it can.
  const trim = Number.isFinite(info.duration) ? Math.max(0, Math.min(shot.trimStart, info.duration - Math.min(secs, info.duration))) : 0;
  const args = ['-y', ...videoArgs(shot.customer)];
  if (trim) args.push('-ss', String(trim));
  args.push('-i', src);
  let next = 1;
  let inset = null;
  if (shot.inset && insetSrc) {
    inset = await insetLayout({ inset: shot.inset, src: insetSrc, settings, dir, signal, masks });
    args.push(...(shot.inset.image ? ['-loop', '1', ...insetImageArgs(shot.inset)] : ['-stream_loop', '-1', ...videoArgs(shot.inset.customer !== false)]), '-i', insetSrc);
    args.push('-loop', '1', ...FILE_ONLY, '-i', inset.mask);
    inset.input = next;
    next += 2;
  }
  const pngInput = next;
  for (const p of pngs) args.push('-loop', '1', ...FILE_ONLY, '-i', p.file);
  next += pngs.length;
  const native = settings.mode === 'talking' && info.hasAudio;
  let silentInput = null;
  if (!native) {
    args.push('-f', 'lavfi', '-t', String(secs), '-i', 'anullsrc=r=48000:cl=stereo');
    silentInput = next;
    next += 1;
  }

  const graph = [`[0:v]${fitFilter(shot.fit, W, H)},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=${secs},trim=duration=${secs},setpts=PTS-STARTPTS[base]`];
  let v = 'base';
  if (inset) {
    const { w, h, border } = inset;
    graph.push(`[${inset.input}:v]scale=${w}:${h},setsar=1,pad=iw+${2 * border}:ih+${2 * border}:${border}:${border}:color=white,format=rgba[ip]`);
    graph.push(`[${inset.input + 1}:v]format=gray[im]`);
    graph.push('[ip][im]alphamerge[ins]');
    graph.push(`[base][ins]overlay=x='main_w*${shot.inset.x}-overlay_w/2':y='main_h*${shot.inset.y}-overlay_h/2':shortest=1[ov]`);
    v = 'ov';
  }
  if (assFile) {
    graph.push(`[${v}]ass=${assFile}:fontsdir=fonts[cap]`);
    v = 'cap';
  }
  pngs.forEach((p, k) => {
    graph.push(`[${v}][${pngInput + k}:v]overlay=x=${p.x}:y=${p.y}:shortest=1:enable='between(t,${p.start},${p.end})'[p${k}]`);
    v = `p${k}`;
  });
  graph.push(`[${v}]format=yuv420p[vout]`);
  graph.push(native
    ? `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${secs},asetpts=PTS-STARTPTS[aout]`
    : `[${silentInput}:a]atrim=0:${secs},asetpts=PTS-STARTPTS[aout]`);

  const out = `seg${index}.mp4`;
  await runFfmpeg([
    ...args,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-t', String(secs), out,
  ], { cwd: dir, signal });
  return out;
}

// ---------------------------------------------------------------- captions

/** Writes one shot's ASS file from events in the shot's own time. -> file name | null */
async function writeShotAss({ events, index, settings, dir }) {
  if (!events.length) return null;
  const name = `cap${index}.ass`;
  await writeFile(path.join(dir, name), toAss(events, { style: settings.captions.style, width: settings.width, height: settings.height }));
  return name;
}

/** The shot's events, from the whole video's events (narrated), in the shot's own time. */
function eventsOfShot(events, start, seconds) {
  const end = start + seconds;
  return events
    .filter((e) => e.start >= start - 1e-6 && e.end <= end + 1e-6)
    .map((e) => ({
      ...e,
      start: Math.max(0, e.start - start),
      end: Math.min(seconds, e.end - start),
      timings: (e.timings || []).map((x) => ({ ...x, start: Math.max(0, x.start - start), end: Math.min(seconds, x.end - start) })),
    }));
}

/** The narration's placement and caption words (narrated mode). */
async function placeNarration({ settings, file, dir, signal }) {
  let segments = Array.isArray(settings.narrationSegments) ? settings.narrationSegments : null;
  if (!segments && settings.lines?.length) {
    // The narration was stored uncut (Task 19): cut it now, from the frozen narrator lines.
    // Our own generated track is a plain file; only a customer's recording gets the forced demuxer (round 3, R1).
    const cut = await sliceUrl({
      url: settings.narrationUrl, lines: settings.lines, ext: settings.narrationExt, signal, forced: settings.narrationCustomer !== false,
    }).catch(() => null);
    segments = cut?.segments || null;
  }
  if (!segments) {
    const info = await probe(file, { cwd: dir, signal, inputArgs: audioArgs(settings.narrationExt, settings.narrationCustomer) });
    const length = Number.isFinite(info.duration) ? info.duration : settings.totalSeconds;
    const warnings = length > settings.totalSeconds + 0.05 ? [TOO_LONG] : [];
    return { groups: [{ sceneId: null, from: 0, to: length, at: 0, tempo: 1, length }], segments: [], warnings, uncut: true };
  }
  return planNarration({ segments, shots: settings.shots, totalSeconds: settings.totalSeconds, titles: settings.sceneTitles || {} });
}

// ---------------------------------------------------------------- audio

/** The placed narration as one stem on the video's timeline -> voice.wav. */
async function buildVoiceStem({ settings, file, plan, dir, signal }) {
  const T = settings.totalSeconds;
  const k = plan.groups.length;
  const graph = [`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=${k}${plan.groups.map((_, i) => `[s${i}]`).join('')}`];
  const parts = [];
  let cursor = 0;
  plan.groups.forEach((g, i) => {
    const gap = g.at - cursor;
    if (gap > 0.001) {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${gap.toFixed(4)}[z${i}]`);
      parts.push(`[z${i}]`);
    }
    graph.push(`[s${i}]atrim=${g.from.toFixed(4)}:${g.to.toFixed(4)},asetpts=PTS-STARTPTS${g.tempo !== 1 ? `,atempo=${g.tempo.toFixed(4)}` : ''}[g${i}]`);
    parts.push(`[g${i}]`);
    cursor = g.at + g.length;
  });
  graph.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1,apad,atrim=0:${T}[out]`);
  await runFfmpeg([
    '-y', ...audioArgs(settings.narrationExt, settings.narrationCustomer), '-i', file,
    '-filter_complex', graph.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', 'voice.wav',
  ], { cwd: dir, signal }).catch((err) => {
    if (signal?.aborted) throw fail('late');
    console.error('[story] render: narration could not be read', err?.message);
    throw fail('voice');
  });
}

/** The music bed for the whole video: started 4 s in, looped with a crossfade, high-passed -> music.wav. -> skip */
async function buildMusicBed({ settings, file, dir, signal }) {
  const T = settings.totalSeconds;
  const info = await probe(file, { cwd: dir, signal, inputArgs: audioArgs(settings.musicExt, settings.musicCustomer) });
  if (!info.hasAudio || !Number.isFinite(info.duration) || info.duration <= 0) throw fail('music');
  const D = info.duration;
  const skip = D >= 2 * MUSIC_START_SECONDS ? MUSIC_START_SECONDS : 0;
  const piece = D - skip;
  const head = `[0:a]atrim=${skip}:${D.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const graph = [];
  if (piece >= T) {
    graph.push(`${head}[m]`);
  } else {
    // Copies of the track, each joined to the last with a short crossfade, until the video is covered.
    const fade = Math.min(1, piece / 4);
    const copies = Math.ceil((T - fade) / (piece - fade)) + 1;
    graph.push(`${head},asplit=${copies}${Array.from({ length: copies }, (_, i) => `[c${i}]`).join('')}`);
    let last = 'c0';
    for (let i = 1; i < copies; i += 1) {
      graph.push(`[${last}][c${i}]acrossfade=d=${fade.toFixed(3)}[x${i}]`);
      last = `x${i}`;
    }
    graph.push(`[${last}]anull[m]`);
  }
  graph.push(`[m]highpass=f=${MUSIC_HIGHPASS_HZ},apad,atrim=0:${T}[out]`);
  await runFfmpeg([
    '-y', ...audioArgs(settings.musicExt, settings.musicCustomer), '-i', file,
    '-filter_complex', graph.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', 'music.wav',
  ], { cwd: dir, signal }).catch((err) => {
    if (signal?.aborted) throw fail('late');
    console.error('[story] render: music could not be read', err?.message);
    throw fail('music');
  });
  return skip;
}

/** Loudnorm's measured values (pass 1), or null when the audio is silent. */
function parseLoudnormJson(stderr) {
  const text = String(stderr);
  const end = text.lastIndexOf('}');
  const start = text.lastIndexOf('{', end);
  if (start < 0 || end < 0) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const nums = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].map((k) => Number(j[k]));
    return nums.every(Number.isFinite) ? { I: nums[0], TP: nums[1], LRA: nums[2], thresh: nums[3], offset: nums[4] } : null;
  } catch {
    return null;
  }
}

/** Two-pass loudnorm mix of voice.wav and music.wav (what exists) -> mix.m4a. */
async function makeMix({ settings, dir, signal, targetLufs, musicGainDb, hasVoice, hasMusic }) {
  const T = settings.totalSeconds;
  const inputs = [];
  const graph = [];
  if (hasVoice) inputs.push(...FILE_ONLY, '-i', 'voice.wav');
  if (hasMusic) inputs.push(...FILE_ONLY, '-i', 'music.wav');
  const m = hasVoice ? 1 : 0;
  const fmt = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  if (hasVoice && hasMusic) {
    graph.push(`[0:a]${fmt},asplit=2[v1][vsc]`);
    graph.push(`[${m}:a]${fmt},volume=${musicGainDb}dB[mus]`);
    graph.push('[mus][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[duck]');
    graph.push('[v1][duck]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mix]');
  } else if (hasVoice) {
    graph.push(`[0:a]${fmt}[mix]`);
  } else {
    graph.push(`[${m}:a]${fmt},volume=${musicGainDb}dB[mix]`);
  }
  const base = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
  const pass1 = await runFfmpeg(['-y', ...inputs, '-filter_complex', [...graph, `[mix]${base}:print_format=json[out]`].join(';'), '-map', '[out]', '-f', 'null', '-'], { cwd: dir, signal });
  const l = parseLoudnormJson(pass1.stderr);
  const second = l
    ? `${base}:measured_I=${l.I}:measured_TP=${l.TP}:measured_LRA=${l.LRA}:measured_thresh=${l.thresh}:offset=${l.offset}:linear=true`
    : base;
  await runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', [...graph, `[mix]${second},aresample=48000,atrim=0:${T}[out]`].join(';'),
    '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(T), 'mix.m4a',
  ], { cwd: dir, signal });
}

async function mux({ settings, dir, signal, audio }) {
  await runFfmpeg([
    '-y', ...FILE_ONLY, '-i', 'joined.mp4', ...(audio ? [...FILE_ONLY, '-i', 'mix.m4a'] : []),
    '-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0', '-c', 'copy',
    '-movflags', '+faststart', '-t', String(settings.totalSeconds), 'final.mp4',
  ], { cwd: dir, signal });
}

// ---------------------------------------------------------------- the render

/**
 * Renders the frozen settings into dir/final.mp4 (the pipeline in the header).
 * -> { file, duration, warnings, captionsFormat, checks, musicStart, narrationPlan }
 */
export async function renderVideo({ settings, dir, signal, deadline = Date.now() + RENDER_WINDOW_MS }) {
  const T = settings.totalSeconds;
  const warnings = [];
  const store = fileStore(dir, signal);

  // Captions: is the filter there, and is the font in place.
  const captionsOn = settings.captions.on;
  const hasAss = captionsOn && !budget.captionsPng && (await captionFilterAvailable(await ffmpegPath()));
  // Captions are drawn either way: ASS when ffmpeg has libass, PNG overlays (sharp) when it does not.
  const canBurn = captionsOn;
  let captionsFormat = captionsOn ? (hasAss ? 'ass' : 'png') : null;
  const fontPath = path.join(process.cwd(), 'public', 'fonts', CAPTION_FONT_FILE);
  if (hasAss) {
    await mkdir(path.join(dir, 'fonts'), { recursive: true });
    await copyFile(fontPath, path.join(dir, 'fonts', CAPTION_FONT_FILE));
  }
  let captionTexts = [];
  let captionsShown = 0;

  // 1. Narration, placed scene by scene.
  let narrationPlan = null;
  let narrationEvents = [];
  if (settings.mode !== 'talking' && settings.narrationUrl) {
    const file = await store.get(settings.narrationUrl);
    const info = await probe(file, { cwd: dir, signal, inputArgs: audioArgs(settings.narrationExt, settings.narrationCustomer) });
    if (!info.hasAudio) throw fail('voice');
    narrationPlan = await placeNarration({ settings, file, dir, signal });
    warnings.push(...narrationPlan.warnings);
    await buildVoiceStem({ settings, file, plan: narrationPlan, dir, signal });
    await store.done(settings.narrationUrl);
    if (canBurn && narrationPlan.segments.length) {
      const cuts = [];
      let at = 0;
      for (const s of settings.shots) { at += s.seconds; cuts.push(at); }
      ({ events: narrationEvents } = buildCaptionEvents({
        words: wordsFromSegments(narrationPlan.segments), cuts: cuts.slice(0, -1), end: T,
        style: settings.captions.style, width: settings.width, height: settings.height,
      }));
      captionTexts = narrationEvents.map((e) => e.text);
    }
  }

  // 2. Segments.
  const uses = new Map();
  for (const s of settings.shots) {
    uses.set(s.url, (uses.get(s.url) || 0) + 1);
    if (s.inset) uses.set(s.inset.url, (uses.get(s.inset.url) || 0) + 1);
  }
  const masks = new Set();
  const segments = [];
  // The stretches of speech (video time) a pause inside of is always a silence failure (checks.failingSilence).
  const speechSpans = narrationPlan ? narrationPlan.groups.map((g) => [g.at, g.at + g.length]) : [];
  let start = 0;
  for (const [index, shot] of settings.shots.entries()) {
    const src = await store.get(shot.url, uses.get(shot.url));
    const insetSrc = shot.inset ? await store.get(shot.inset.url, uses.get(shot.inset.url)) : null;
    let events = [];
    if (settings.mode === 'talking') {
      const speech = shot.line ? await clipSpeech({ src, shot, dir, signal }) : { window: null, runsOver: false };
      if (speech.window) speechSpans.push([start + speech.window[0], start + speech.window[1]]);
      if (speech.runsOver) {
        warnings.push({ code: 'line_cut', message: `The line in shot ${index + 1} is still being spoken when the shot ends, so its end is cut off.` });
      }
      if (canBurn && shot.line) {
        ({ events } = buildCaptionEvents({
          words: wordsFromShotLines([shot], { windows: [speech.window] }), end: shot.seconds,
          style: settings.captions.style, width: settings.width, height: settings.height,
        }));
        captionTexts.push(...events.map((e) => e.text));
      }
    } else {
      events = eventsOfShot(narrationEvents, start, shot.seconds);
    }
    let assFile = null;
    let pngs = [];
    if (canBurn && events.length && hasAss) assFile = await writeShotAss({ events, index, settings, dir });
    if (canBurn && events.length && !hasAss && captionsFormat === 'png') {
      try {
        pngs = await captionPngs({ events, style: settings.captions.style, width: settings.width, height: settings.height, dir, prefix: `cap${index}_`, fontPath });
      } catch (err) {
        // No sharp (or no text support in it): the video is still made, without captions, and says so.
        console.error('[story] render: caption pictures could not be drawn', err?.message || err);
        captionsFormat = 'none';
        // Some shots may already have their captions: the rest do not, so the video says so (N5).
        if (!warnings.includes(CAPTIONS_MISSING)) warnings.push(CAPTIONS_MISSING);
      }
    }
    if (assFile || pngs.length) captionsShown += 1;
    segments.push(await renderSegment({ shot, index, settings, dir, signal, src, insetSrc, assFile, pngs, masks }));
    await Promise.all(pngs.map((p) => rm(path.join(dir, p.file), { force: true })));
    await store.done(shot.url);
    if (shot.inset) await store.done(shot.inset.url);
    start += shot.seconds;
  }
  await writeFile(path.join(dir, 'list.txt'), segments.map((s) => `file '${s}'`).join('\n'));
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4'], { cwd: dir, signal });
  await Promise.all(segments.map((s) => rm(path.join(dir, s), { force: true })));

  // Captions asked for and not shown, or shown with characters the font does not have.
  const spoken = settings.mode === 'talking' ? settings.shots.some((s) => s.line) : Boolean(settings.narrationUrl);
  if (captionsOn && spoken && !captionsShown && !warnings.includes(CAPTIONS_MISSING)) warnings.push(CAPTIONS_MISSING);
  if (captionTexts.length) {
    const missing = unsupportedCharacters(captionTexts, fontPath);
    if (missing.length) {
      warnings.push({ code: 'captions_missing', message: `Some characters in the captions (${missing.slice(0, 5).join(' ')}) are not in the caption font, so they may not show.` });
    }
  }

  // 3. The voice stem in talking mode is the clips' own sound.
  let hasVoice = Boolean(narrationPlan);
  if (settings.mode === 'talking') {
    await runFfmpeg(['-y', ...FILE_ONLY, '-i', 'joined.mp4', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', 'voice.wav'], { cwd: dir, signal });
    hasVoice = true;
  }

  // 4. Music.
  let musicStart = null;
  if (settings.musicUrl) {
    const file = await store.get(settings.musicUrl);
    musicStart = await buildMusicBed({ settings, file, dir, signal });
    await store.done(settings.musicUrl);
  }
  const hasMusic = musicStart !== null;

  // 5 and 6. Mix, mux, checks; one more mix only when it can help.
  let result = { ok: true, failures: [], measures: { lufs: null, longestSilence: 0, coverage: null, duration: T }, retried: false };
  if (!hasVoice && !hasMusic) {
    // Nothing to hear (a narrated video with no narrator lines and no music): the clips' silent track is kept.
    await mux({ settings, dir, signal, audio: false });
  } else {
    let targetLufs = TARGET_LUFS;
    let musicGainDb = MUSIC_GAIN_DB;
    let coverage = null;
    const left = () => deadline - Date.now() - budget.uploadReserveMs;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = Date.now();
      await makeMix({ settings, dir, signal, targetLufs, musicGainDb, hasVoice, hasMusic });
      await mux({ settings, dir, signal, audio: true });
      const transcribeMs = Math.min(budget.maxTranscribeMs, left());
      const checkWords = settings.scriptWords?.length > 0 && (Number.isFinite(coverage) || transcribeMs >= budget.minTranscribeMs);
      result = await runChecks({
        renderPath: path.join(dir, 'final.mp4'),
        voicePath: hasVoice ? path.join(dir, 'voice.wav') : null,
        speechSpans,
        scriptWords: checkWords ? settings.scriptWords : [],
        reuseCoverage: coverage,
        timeoutMs: Math.max(1000, transcribeMs),
        signal,
      });
      result.retried = attempt === 2;
      if (!checkWords && settings.scriptWords?.length) result.failures.push({ code: 'words_unchecked', message: WORDS_UNCHECKED });
      const failed = new Set(result.failures.map((f) => f.code));
      // Only what a new mix can change: the loudness, or words lost under music that can be lowered.
      const helps = failed.has('loudness') || (failed.has('words') && hasMusic);
      const fits = left() > (Date.now() - started) * 1.2;
      if (!helps || attempt === 2 || !fits) break;
      // The words are heard again only when they failed; otherwise the first hearing stands.
      coverage = failed.has('words') ? null : result.measures.coverage;
      if (Number.isFinite(result.measures.lufs)) targetLufs = Math.min(-10, Math.max(-18, TARGET_LUFS + (TARGET_LUFS - result.measures.lufs)));
      if (hasMusic) musicGainDb -= 3;
    }
  }
  await rm(path.join(dir, 'joined.mp4'), { force: true });
  const { duration } = await probe('final.mp4', { cwd: dir, signal });
  return {
    file: path.join(dir, 'final.mp4'),
    duration,
    warnings: [...warnings, ...result.failures],
    captionsFormat,
    musicStart,
    narrationPlan: narrationPlan ? narrationPlan.groups : null,
    checks: { ok: result.ok, retried: result.retried, ...result.measures },
  };
}

// ---------------------------------------------------------------- job handler

async function renderRow(job) {
  const id = job.payload?.renderId;
  const [row] = id ? await storyDb().select('story_renders', { id, project_id: job.project_id }) : [];
  return row || null;
}

/** putObject, tried twice (a hiccup must not throw away a rendered and checked file). */
async function storeFile({ key, file, signal }) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) break;
    try {
      const { size } = await stat(file);
      return await putObject({ key, body: createReadStream(file), contentLength: size, signal });
    } catch (err) {
      last = err;
      console.error('[story] render: storing the video failed', attempt, err?.message || err);
    }
  }
  throw signal?.aborted ? fail('late') : Object.assign(fail('upload'), { cause: last });
}

export const renderHandler = {
  sync: true,

  run: async (job, { deadline } = {}) => {
    const row = await renderRow(job);
    if (!row) throw fail('changed');
    if (row.status === 'done' && row.storage_key) {
      return { url: row.file_url, key: row.storage_key, duration: row.duration_seconds, warnings: row.warnings, settings: row.settings };
    }
    // A row that already ended (failed by recovery, or replaced) is never rendered: the project may have a newer
    // render running, and two at once is what the lock is for.
    const [mine] = await storyDb().update('story_renders', { id: row.id, status: ['queued', 'running'] }, { status: 'running', job_id: job.id, error: null });
    if (!mine) return { skipped: true };
    await removeStaleDirs();
    const end = Number.isFinite(deadline) ? deadline : Date.now() + RENDER_WINDOW_MS;
    const signal = deadlineSignal(end, RENDER_WINDOW_MS);
    // The stored file is named after the title (a Blob host saves a download under it). Read before the expensive
    // render; a failed read falls back to a plain name, so it can never throw away a finished video.
    const title = await storyDb().select('story_projects', { id: job.project_id }, { columns: ['title'] }).then((r) => r[0]?.title, () => null);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'story-render-'));
    try {
      const out = await renderVideo({ settings: row.settings, dir, signal, deadline: end });
      const stored = await storeFile({ key: `story/${job.project_id}/render/${job.id}/${renderFilename(title, row.version)}`, file: out.file, signal });
      return {
        url: stored.url,
        key: stored.key,
        duration: Math.round(out.duration * 1000) / 1000,
        warnings: out.warnings,
        settings: {
          ...row.settings,
          captions: { ...row.settings.captions, format: out.captionsFormat },
          musicStart: out.musicStart,
          narrationPlan: out.narrationPlan,
          checks: out.checks,
        },
      };
    } catch (err) {
      // A run cut off by its deadline is final (one-shot kind): say so plainly.
      if (signal.aborted && !(err instanceof ProviderError)) throw fail('late');
      if (!(err instanceof ProviderError)) console.error('[story] render failed', job.id, err?.message || err);
      throw err instanceof ProviderError ? err : fail('failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  // Settles the render's hold only when its row is (now) done; a row that already ended failed gives the job's share
  // back instead (same ref as the runner's failure release, so it is never released twice). settleJob is keyed on
  // the job, so a repeated onDone charges once.
  onDone: async (job, result) => {
    const id = job.payload?.renderId;
    if (!id) return;
    const giveBack = () => (job.hold_id && job.cost_credits > 0
      ? releaseQuietly(job.hold_id, { amount: job.cost_credits, ref: `job:${job.id}` })
      : null);
    if (result?.skipped) {
      await giveBack();
      return;
    }
    // Set, not add (onDone may run twice); a row that already ended failed stays failed.
    const [written] = await storyDb().update('story_renders', { id, project_id: job.project_id, status: ['queued', 'running', 'done'] }, {
      status: 'done',
      file_url: result.url,
      storage_key: result.key,
      duration_seconds: result.duration ?? null,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      settings: result.settings || {},
      error: null,
    });
    if (!written) {
      await giveBack();
      return;
    }
    const [project] = await storyDb().select('story_projects', { id: job.project_id }, { columns: ['id', 'step'] });
    if (project && project.step === 'review') await storyDb().update('story_projects', { id: project.id, step: 'review' }, { step: 'done', status: 'finished' });
    await settleJob(job);
  },

  // Database only (runner contract): the row says what happened; the next start makes a new version.
  onFail: async (job, { error } = {}) => {
    const id = job.payload?.renderId;
    if (!id) return;
    const failed = { status: 'failed', error: renderError(error) };
    await storyDb().update('story_renders', { id, project_id: job.project_id, status: ['queued', 'running'] }, failed);
    // onDone wrote the row done, then gave up and the runner deleted the stored file (giveUpDone): that row has no
    // video, so it must not count as the included free render nor be offered for download.
    const key = job.result?.key;
    if (key) await storyDb().update('story_renders', { id, project_id: job.project_id, status: 'done', storage_key: key }, failed);
  },
};

registerHandler('render', renderHandler);

// ---------------------------------------------------------------- HTTP

// POST /api/story/projects/[id]/render  { expected_credits? } -> { render (public row), charged }
//   409 render_busy, 409 shots_not_ready, 409 audio_not_ready, 409 quote_changed { credits } (nothing held),
//   422 (an inset or footage that is not usable), 402 plan_required, 402 insufficient_credits
export const renderAction = async ({ userId, user, projectId, body = {} }) => startRender({ userId, projectId, user, expectedCredits: body.expected_credits });
registerAction('render', { method: 'POST', handler: renderAction });
