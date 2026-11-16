import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProviderError } from '../providers/errors.js';
import { downloadToFile } from '../providers/http.js';
import { localPathFor, putObject } from '../providers/storage.js';
import { registerAction } from './actions.js';
import { narratorLines, resolveAudioPlan, sliceUrl } from './audio.js';
import {
  CAPTION_FONT_FILE, buildCaptionEvents, captionFilterAvailable, toAss, wordsFromSegments, wordsFromShotLines,
} from './captions.js';
import { CHECK_MESSAGES, run as runChecks, ffmpegPath, probe, runFfmpeg, wordsOfTexts } from './checks.js';
import { storyDb } from './db.js';
import { ConflictError } from './errors.js';
import { assertAllowed } from './limits.js';
import { getProject } from './projects.js';
import { enqueue, registerHandler } from './runner.js';
import { RENDER_WORKER_PATH, deadlineSignal, kickWorker } from './workers.js';

/*
 * The finished video (Task 20): clips + narration + music -> one mp4 with
 * burned-in captions, checked, stored and versioned in story_renders.
 *
 *   startRender({ userId, projectId, user }) -> { render }   POST /api/story/projects/[id]/render
 *
 * Rendering never charges credits: no hold, no ledger row (a paid plan is
 * still required, limits.js 'render'). A project renders one video at a time:
 * the queued story_renders row is the lock (unique index
 * story_renders_one_active, migration 20261114001300), so a second start is
 * 409 render_busy until the first ends done or failed. Every render is a new
 * version (1, 2, ...); older versions stay listed.
 *
 * The render job ('render', a worker kind) runs only in
 * pages/api/story/render-worker.js (maxDuration 300). A crash is handled by the
 * runner's sweep: a render running for more than 10 minutes is queued again
 * once, then failed, and onFail marks the row failed.
 *
 * Inputs are frozen in the row's `settings` at start (what the customer
 * pressed): shots with their clip urls and seconds, the narration and its line
 * timings, the music, captions on/style, aspect and mode. The job renders from
 * those settings and adds `captions.format` and `checks` when it is done.
 *
 * Pipeline (ffmpeg, cwd = a temp dir, relative names inside filter args):
 *   1. each shot -> seg<i>.mp4: scaled and cropped to the target size (footage
 *      may be fitted instead), 30 fps, padded by repeating the last frame when
 *      the clip is short, trimmed to the shot's seconds; an inset is overlaid in
 *      a rounded white frame; the shot's captions are burned (ASS, bundled
 *      font); the audio is the clip's own sound in talking mode, silence otherwise.
 *   2. concat demuxer (stream copy) -> joined.mp4.
 *   3. mix -> mix.m4a: voice (narration, or the clips' own sound) + music
 *      (high-passed at 40 Hz, started 4 s into the track when it is long enough,
 *      ducked under the voice with sidechaincompress), then two-pass loudnorm to
 *      -14 LUFS.
 *   4. mux -> final.mp4, checks (lib/story/checks.js). On a failed check the mix
 *      is made once more (loudness target corrected, music 3 dB lower), then
 *      whatever still fails is saved as warnings.
 *      The checks get only the time left before the deadline less an upload
 *      reserve (40 s): the transcription is bounded by it, skipped (warning
 *      words_unchecked) under 15 s, and the second mix is made only when it fits.
 *      Captions that were asked for and could not be burned add the warning
 *      captions_missing.
 *   5. putObject (abort signal from the worker's deadline), then onDone writes the row.
 *
 * Narration timing: the narration track plays from 0 s across the whole video
 * (shots are not re-timed to it), so its segments are caption times as they are.
 */

export const RENDER_SIZES = Object.freeze({ '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] });
export const FPS = 30;
export const TARGET_LUFS = -14;
export const MUSIC_START_SECONDS = 4;
export const MUSIC_HIGHPASS_HZ = 40;
// The music bed sits this far under the voice before ducking.
const MUSIC_GAIN_DB = -10;
// A queued render with no job after this long was left by a dead request.
export const STALE_START_MS = 30_000;
// How long a render may run when the worker passes no deadline.
const RENDER_WINDOW_MS = 280_000;
const IMAGE_KINDS = ['logo', 'product_photo', 'mascot', 'image'];
const DEFAULT_INSET = { x: 0.5, y: 0.3, w: 0.45 };
const RETRYABLE = new Set(['words', 'silence', 'loudness']);
// Time budget inside a run (see renderVideo): what the upload keeps, and the least a transcription is worth.
const DEFAULT_BUDGET = Object.freeze({ uploadReserveMs: 40_000, minTranscribeMs: 15_000, maxTranscribeMs: 120_000 });
let budget = { ...DEFAULT_BUDGET };
/** Tests only: change the time budget; call with no argument to restore it. */
export function _configureRender(patch) {
  budget = { ...DEFAULT_BUDGET, ...(patch || {}) };
}
const WORDS_UNCHECKED = CHECK_MESSAGES.words_unchecked;
const CAPTIONS_MISSING = { code: 'captions_missing', message: 'The captions could not be added to this video.' };

const busy = () => new ConflictError('Your video is already being made. Wait for it to finish, then make it again.', { code: 'render_busy' });

/** [width, height] for a project aspect. */
export function renderTargetSize(aspect) {
  return RENDER_SIZES[aspect] || RENDER_SIZES['9:16'];
}

/** A shot the render can use: a generated shot with its clip, or a footage shot with its asset. */
export function renderable(shot) {
  if (shot.source === 'footage') return Boolean(shot.footage_asset_id);
  return shot.status === 'ready' && Boolean(shot.clip_url);
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

/** The inputs of a render, frozen at start (see the header). */
async function renderSettings(project, shots) {
  const plan = resolveAudioPlan(project);
  const [width, height] = renderTargetSize(project.aspect);
  const assets = await ownedAssets(project.user_id, [
    ...shots.flatMap((s) => [s.source === 'footage' ? s.footage_asset_id : null, s.inset_asset_id]),
    plan.music.type === 'upload' ? plan.music.assetId : null,
  ]);
  const asset = (id) => (id ? assets.get(id) || null : null);
  let musicUrl = null;
  if (plan.music.type === 'generated') musicUrl = project.music_url || null;
  if (plan.music.type === 'upload') musicUrl = asset(plan.music.assetId)?.url || null;
  const talking = project.mode === 'talking';
  return {
    aspect: RENDER_SIZES[project.aspect] ? project.aspect : '9:16',
    width,
    height,
    mode: talking ? 'talking' : 'narrated',
    captions: { on: plan.captions.on !== false, style: plan.captions.style },
    music: Boolean(musicUrl),
    musicUrl,
    narrationUrl: talking ? null : project.narration_url || null,
    narrationSegments: talking ? null : project.narration_segments || null,
    totalSeconds: shots.reduce((n, s) => n + Number(s.seconds), 0),
    shots: shots.map((s) => {
      const footage = s.source === 'footage' ? asset(s.footage_asset_id) : null;
      const inset = asset(s.inset_asset_id);
      return {
        id: s.id,
        ord: s.ord,
        seconds: Number(s.seconds),
        source: s.source,
        url: footage ? footage.url : s.clip_url,
        trimStart: footage ? Math.max(0, Number(s.footage?.trimStart) || 0) : 0,
        fit: footage && s.footage?.fit === 'contain' ? 'contain' : 'cover',
        line: s.line || null,
        inset: inset ? { url: inset.url, image: IMAGE_KINDS.includes(inset.kind), ...DEFAULT_INSET, ...pickInset(s.inset) } : null,
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

/** Ends queued renders a dead request left without a job, and rows whose job already ended. */
export async function recoverStalledRender(projectId) {
  const rows = await storyDb().select('story_renders', { project_id: projectId, status: ['queued', 'running'] });
  for (const row of rows) {
    if (!row.job_id) {
      if (Date.now() - Date.parse(row.created_at) > STALE_START_MS) {
        await storyDb().update('story_renders', { id: row.id, status: row.status, job_id: null }, { status: 'failed', error: 'The render did not start. Try again.' });
      }
      continue;
    }
    const [job] = await storyDb().select('story_jobs', { id: row.job_id }, { columns: ['id', 'status', 'error', 'applied_at'] });
    if (!job || ((job.status === 'failed' || job.status === 'blocked') && job.applied_at)) {
      await storyDb().update('story_renders', { id: row.id, status: row.status }, { status: 'failed', error: job?.error || 'The render stopped. Try again.' });
    }
  }
}

/** Queues a new render version of the project. -> { render } (the story_renders row). */
export async function startRender({ userId, projectId, user }) {
  const project = await getProject({ userId, id: projectId });
  await assertAllowed({ userId, action: 'render', projectId, user });
  await recoverStalledRender(projectId);
  const shots = await storyDb().select('story_shots', { project_id: projectId }, { order: 'ord' });
  const waiting = shots.filter((s) => !renderable(s));
  if (!shots.length || waiting.length) {
    throw new ConflictError('Every shot needs its clip before the video can be made.', { code: 'shots_not_ready', shotIds: waiting.map((s) => s.id) });
  }
  const settings = await renderSettings(project, shots);

  let row = null;
  for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
    const [last] = await storyDb().select('story_renders', { project_id: projectId }, { columns: ['version'], order: '-version', limit: 1 });
    try {
      [row] = await storyDb().insert('story_renders', { project_id: projectId, version: (last?.version || 0) + 1, status: 'queued', settings });
    } catch (err) {
      if (isUniqueViolation(err, 'story_renders_one_active')) throw busy();
      if (!isUniqueViolation(err, 'story_renders_version_unique')) throw err;
    }
  }
  if (!row) throw busy();

  let job;
  try {
    job = await enqueue({ projectId, kind: 'render', payload: { renderId: row.id } });
  } catch (err) {
    await storyDb().update('story_renders', { id: row.id }, { status: 'failed', error: 'The render did not start. Try again.' }).catch(() => {});
    throw err;
  }
  const [linked] = await storyDb().update('story_renders', { id: row.id }, { job_id: job.id });
  await kickWorker(RENDER_WORKER_PATH);
  return { render: linked || { ...row, job_id: job.id } };
}

// ---------------------------------------------------------------- the render itself

async function localCopy(url, dir, name, signal) {
  const local = localPathFor(url);
  if (local) return local;
  const { filePath } = await downloadToFile(url, { maxBytes: 500 * 1024 * 1024, dest: path.join(dir, name), provider: 'storage', signal });
  return filePath;
}

const fitFilter = (fit, w, h) => (fit === 'contain'
  ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);

/** Alpha mask for a rounded rectangle of radius R on a W x H frame (geq expression). */
const roundedMask = (r) => `if(lte(hypot(max(max(${r}-X,X-(W-1-${r})),0),max(max(${r}-Y,Y-(H-1-${r})),0)),${r}),255,0)`;

// An inset is at most this share of the frame's height, so a tall picture never covers the whole frame.
const INSET_MAX_HEIGHT = 0.4;

function insetChain(inset, width, height, input) {
  const even = (n) => Math.max(16, Math.round(n / 2) * 2);
  const w = even(width * inset.w);
  const h = even(height * INSET_MAX_HEIGHT);
  const border = Math.max(2, Math.round(Math.min(width, height) / 180));
  const radius = Math.round(Math.min(w, h) / 12);
  return `[${input}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=iw+${2 * border}:ih+${2 * border}:${border}:${border}:color=white,format=rgba,`
    + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedMask(radius)}'[ins]`;
}

/** One normalised segment per shot (step 1). */
async function renderSegment({ shot, index, settings, dir, signal, assFile }) {
  const { width: W, height: H } = settings;
  const secs = shot.seconds;
  const src = await localCopy(shot.url, dir, `src${index}`, signal);
  const info = await probe(src, { cwd: dir, signal });
  const args = ['-y'];
  if (shot.trimStart) args.push('-ss', String(shot.trimStart));
  args.push('-i', src);
  let next = 1;
  let insetInput = null;
  if (shot.inset) {
    const insetSrc = await localCopy(shot.inset.url, dir, `inset${index}`, signal);
    args.push(...(shot.inset.image ? ['-loop', '1'] : ['-stream_loop', '-1']), '-i', insetSrc);
    insetInput = next;
    next += 1;
  }
  const native = settings.mode === 'talking' && info.hasAudio;
  let silentInput = null;
  if (!native) {
    args.push('-f', 'lavfi', '-t', String(secs), '-i', 'anullsrc=r=48000:cl=stereo');
    silentInput = next;
    next += 1;
  }

  const graph = [`[0:v]${fitFilter(shot.fit, W, H)},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=${secs},trim=duration=${secs},setpts=PTS-STARTPTS[base]`];
  let v = 'base';
  if (insetInput !== null) {
    graph.push(insetChain(shot.inset, W, H, insetInput));
    graph.push(`[base][ins]overlay=x='main_w*${shot.inset.x}-overlay_w/2':y='main_h*${shot.inset.y}-overlay_h/2':shortest=1[ov]`);
    v = 'ov';
  }
  if (assFile) {
    graph.push(`[${v}]ass=${assFile}:fontsdir=fonts[cap]`);
    v = 'cap';
  }
  graph.push(`[${v}]format=yuv420p[vout]`);
  graph.push(native
    ? `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${secs},asetpts=PTS-STARTPTS[aout]`
    : `[${silentInput}:a]atrim=0:${secs},asetpts=PTS-STARTPTS[aout]`);

  const out = `seg${index}.mp4`;
  await runFfmpeg([
    ...args,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-t', String(secs), out,
  ], { cwd: dir, signal });
  return out;
}

/** The caption words for the video (narration segments, or the shot lines in talking mode). */
async function captionWords(settings, projectId) {
  if (settings.mode === 'talking') return wordsFromShotLines(settings.shots);
  let segments = settings.narrationSegments;
  if (!Array.isArray(segments) && settings.narrationUrl) {
    // The narration was stored uncut (Task 19): cut it now, from the latest script's narrator lines.
    const cut = await sliceUrl({ url: settings.narrationUrl, lines: narratorLines(await latestScenes(projectId)) }).catch(() => null);
    segments = cut?.segments || null;
  }
  return wordsFromSegments(segments || []);
}

/** Per-shot ASS files (captions never cross a cut, so each shot's events are its own). -> [fileName|null] */
async function writeCaptionFiles({ settings, projectId, dir }) {
  const none = settings.shots.map(() => null);
  if (!settings.captions.on) return { files: none, format: null, missing: false };
  if (!(await captionFilterAvailable(await ffmpegPath()))) return { files: none, format: 'none', missing: true };
  const words = await captionWords(settings, projectId);
  if (!words.length) {
    // Nothing to show is expected only when the video says nothing (no narration, no shot lines).
    const spoken = settings.mode === 'talking' ? settings.shots.some((s) => s.line) : Boolean(settings.narrationUrl);
    return { files: none, format: 'ass', missing: spoken };
  }
  const cuts = [];
  let at = 0;
  for (const s of settings.shots) { at += s.seconds; cuts.push(at); }
  const { events } = buildCaptionEvents({ words, cuts: cuts.slice(0, -1), style: settings.captions.style, width: settings.width, height: settings.height });
  await mkdir(path.join(dir, 'fonts'), { recursive: true });
  await copyFile(path.join(process.cwd(), 'public', 'fonts', CAPTION_FONT_FILE), path.join(dir, 'fonts', CAPTION_FONT_FILE));
  const files = [];
  let start = 0;
  for (const [i, s] of settings.shots.entries()) {
    const end = start + s.seconds;
    const mine = events
      .filter((e) => e.start >= start - 1e-6 && e.end <= end + 1e-6)
      .map((e) => ({ ...e, start: Math.max(0, e.start - start), end: Math.min(s.seconds, e.end - start) }));
    if (mine.length) {
      const name = `cap${i}.ass`;
      await writeFile(path.join(dir, name), toAss(mine, { style: settings.captions.style, width: settings.width, height: settings.height }));
      files.push(name);
    } else {
      files.push(null);
    }
    start = end;
  }
  return { files, format: 'ass', missing: false };
}

/** The mix filter graph up to [mix] (step 3). -> { inputs: [args], graph: [filters] } */
async function mixGraph({ settings, dir, signal, musicGainDb }) {
  const T = settings.totalSeconds;
  const inputs = ['-i', 'joined.mp4'];
  const graph = [];
  const voices = [];
  let n = 1;
  if (settings.mode === 'talking') {
    graph.push('[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bed]');
    voices.push('bed');
  } else if (settings.narrationUrl) {
    inputs.push('-i', await localCopy(settings.narrationUrl, dir, 'narration', signal));
    graph.push(`[${n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${T}[nar]`);
    voices.push('nar');
    n += 1;
  }
  let music = null;
  if (settings.musicUrl) {
    const file = await localCopy(settings.musicUrl, dir, 'music', signal);
    const { duration } = await probe(file, { cwd: dir, signal });
    const skip = Number.isFinite(duration) && duration >= T + MUSIC_START_SECONDS ? MUSIC_START_SECONDS : 0;
    inputs.push(...(skip ? ['-ss', String(skip)] : []), '-i', file);
    graph.push(`[${n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,highpass=f=${MUSIC_HIGHPASS_HZ},volume=${musicGainDb}dB,apad,atrim=0:${T}[mus]`);
    music = { skip };
    n += 1;
  }
  if (!voices.length && !music) {
    graph.push('[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[mix]');
    return { inputs, graph, musicStart: null };
  }
  if (!music) {
    graph.push(`[${voices[0]}]anull[mix]`);
    return { inputs, graph, musicStart: null };
  }
  if (!voices.length) {
    graph.push('[mus]anull[mix]');
    return { inputs, graph, musicStart: music.skip };
  }
  graph.push(`[${voices[0]}]asplit=2[v1][vsc]`);
  graph.push('[mus][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[duck]');
  graph.push('[v1][duck]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mix]');
  return { inputs, graph, musicStart: music.skip };
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

/** Two-pass loudnorm mix -> mix.m4a. */
async function makeMix({ settings, dir, signal, targetLufs, musicGainDb }) {
  const T = settings.totalSeconds;
  const { inputs, graph, musicStart } = await mixGraph({ settings, dir, signal, musicGainDb });
  const base = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
  const pass1 = await runFfmpeg(['-y', ...inputs, '-filter_complex', [...graph, `[mix]${base}:print_format=json[out]`].join(';'), '-map', '[out]', '-f', 'null', '-'], { cwd: dir, signal });
  const m = parseLoudnormJson(pass1.stderr);
  const second = m
    ? `${base}:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true`
    : base;
  await runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', [...graph, `[mix]${second},aresample=48000,atrim=0:${T}[out]`].join(';'),
    '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(T), 'mix.m4a',
  ], { cwd: dir, signal });
  return { musicStart };
}

async function mux({ settings, dir, signal }) {
  await runFfmpeg([
    '-y', '-i', 'joined.mp4', '-i', 'mix.m4a', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
    '-movflags', '+faststart', '-t', String(settings.totalSeconds), 'final.mp4',
  ], { cwd: dir, signal });
}

/** The words the finished video must say (checks): narrator lines, or the shot lines in talking mode. */
async function scriptWordsFor(settings, projectId) {
  if (settings.mode === 'talking') return wordsOfTexts(settings.shots.map((s) => s.line));
  if (!settings.narrationUrl) return [];
  return wordsOfTexts(narratorLines(await latestScenes(projectId)).map((l) => l.text));
}

/**
 * Renders the frozen settings into dir/final.mp4 (steps 1 to 4).
 * -> { file, duration, warnings, captionsFormat, checks, musicStart }
 */
export async function renderVideo({ settings, projectId, dir, signal, deadline = Date.now() + RENDER_WINDOW_MS }) {
  const { files: assFiles, format, missing } = await writeCaptionFiles({ settings, projectId, dir });
  const segments = [];
  for (const [index, shot] of settings.shots.entries()) {
    segments.push(await renderSegment({ shot, index, settings, dir, signal, assFile: assFiles[index] }));
  }
  await writeFile(path.join(dir, 'list.txt'), segments.map((s) => `file '${s}'`).join('\n'));
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4'], { cwd: dir, signal });

  const scriptWords = await scriptWordsFor(settings, projectId);
  let targetLufs = TARGET_LUFS;
  let musicGainDb = MUSIC_GAIN_DB;
  let result = null;
  let musicStart = null;
  // The upload must keep its reserve: the transcription gets what is left before it (at most 2 minutes), the words
  // are not checked when that is under 15 s, and the mix is made again only when a second pass fits.
  const left = () => deadline - Date.now() - budget.uploadReserveMs;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    ({ musicStart } = await makeMix({ settings, dir, signal, targetLufs, musicGainDb }));
    await mux({ settings, dir, signal });
    const transcribeMs = Math.min(budget.maxTranscribeMs, left());
    const checkWords = transcribeMs >= budget.minTranscribeMs;
    result = await runChecks({ renderPath: path.join(dir, 'final.mp4'), scriptWords: checkWords ? scriptWords : [], timeoutMs: Math.max(1000, transcribeMs), signal });
    if (!checkWords && scriptWords.length) result.failures.push({ code: 'words_unchecked', message: WORDS_UNCHECKED });
    const retry = result.failures.some((f) => RETRYABLE.has(f.code));
    const fits = left() > (Date.now() - started) * 1.2;
    if (!retry || attempt === 2 || !fits) {
      result.retried = attempt === 2;
      break;
    }
    // One more mix: aim off by what the first one missed, and keep the music further down.
    if (Number.isFinite(result.measures.lufs)) targetLufs = Math.min(-10, Math.max(-18, TARGET_LUFS + (TARGET_LUFS - result.measures.lufs)));
    musicGainDb -= 3;
  }
  const { duration } = await probe('final.mp4', { cwd: dir, signal });
  return {
    file: path.join(dir, 'final.mp4'),
    duration,
    warnings: missing ? [...result.failures, CAPTIONS_MISSING] : result.failures,
    captionsFormat: format,
    musicStart,
    checks: { ok: result.ok, retried: result.retried, ...result.measures },
  };
}

// ---------------------------------------------------------------- job handler

async function renderRow(job) {
  const id = job.payload?.renderId;
  const [row] = id ? await storyDb().select('story_renders', { id, project_id: job.project_id }) : [];
  return row || null;
}

export const renderHandler = {
  sync: true,

  run: async (job, { deadline } = {}) => {
    const row = await renderRow(job);
    if (!row) throw new ProviderError('failed', 'This render could not be found.');
    if (row.status === 'done' && row.storage_key) {
      return { url: row.file_url, key: row.storage_key, duration: row.duration_seconds, warnings: row.warnings, settings: row.settings };
    }
    // A row that already ended (failed by recovery, or replaced) is never rendered: the project may have a newer
    // render running, and two at once is what the lock is for.
    const [mine] = await storyDb().update('story_renders', { id: row.id, status: ['queued', 'running'] }, { status: 'running', job_id: job.id, error: null });
    if (!mine) return { skipped: true };
    const signal = deadlineSignal(deadline, RENDER_WINDOW_MS);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'story-render-'));
    try {
      const out = await renderVideo({
        settings: row.settings, projectId: job.project_id, dir, signal, deadline: Number.isFinite(deadline) ? deadline : Date.now() + RENDER_WINDOW_MS,
      });
      const { size } = await stat(out.file);
      const stored = await putObject({
        key: `story/${job.project_id}/render/v${row.version}-${job.id}.mp4`,
        body: createReadStream(out.file),
        contentLength: size,
        signal,
      });
      return {
        url: stored.url,
        key: stored.key,
        duration: Math.round(out.duration * 1000) / 1000,
        warnings: out.warnings,
        settings: { ...row.settings, captions: { ...row.settings.captions, format: out.captionsFormat }, musicStart: out.musicStart, checks: out.checks },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  onDone: async (job, result) => {
    const id = job.payload?.renderId;
    if (!id || result?.skipped) return;
    // Set, not add (onDone may run twice); a row that already ended failed stays failed.
    await storyDb().update('story_renders', { id, project_id: job.project_id, status: ['queued', 'running', 'done'] }, {
      status: 'done',
      file_url: result.url,
      storage_key: result.key,
      duration_seconds: result.duration ?? null,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      settings: result.settings || {},
      error: null,
    });
    const [project] = await storyDb().select('story_projects', { id: job.project_id }, { columns: ['id', 'step'] });
    if (project && project.step === 'review') await storyDb().update('story_projects', { id: project.id, step: 'review' }, { step: 'done', status: 'finished' });
  },

  // Database only (runner contract): the row says what happened; the next start makes a new version.
  onFail: async (job, { error } = {}) => {
    const id = job.payload?.renderId;
    if (!id) return;
    await storyDb().update('story_renders', { id, project_id: job.project_id, status: ['queued', 'running'] }, {
      status: 'failed',
      error: error || 'The video could not be made. Try again.',
    });
  },
};

registerHandler('render', renderHandler);

// ---------------------------------------------------------------- HTTP

// POST /api/story/projects/[id]/render  {} -> { render }   (409 render_busy, 409 shots_not_ready, 402 plan_required)
export const renderAction = async ({ userId, user, projectId }) => startRender({ userId, projectId, user });
registerAction('render', { method: 'POST', handler: renderAction });
