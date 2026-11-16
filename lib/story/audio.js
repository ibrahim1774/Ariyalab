import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { holdCredits, releaseHold } from '../credits.js';
import { screenText } from '../moderation.js';
import { getPricing } from '../pricing.js';
import { ProviderError } from '../providers/errors.js';
import { downloadToFile } from '../providers/http.js';
import { localPathFor } from '../providers/storage.js';
import { listVoices } from '../providers/tts.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { assertAllowed } from './limits.js';
import { getProject, STEPS, assertNotExpired } from './projects.js';
import { registerAction } from './actions.js';
import { enqueue } from './runner.js';
import { AUDIO_LIMITS } from './voiceRules.js';
import { AUDIO_WORKER_PATH, kickWorker } from './workers.js';
import { audioInputArgs } from './audioProbe.js';
import { runFfmpeg as runChecked } from './checks.js';

/*
 * The "Voice and sound" step (spec 7.3 step 9): the audio plan, the narration
 * voice track and the background music. Both tracks are runner jobs (kinds
 * 'narration' and 'music', handlers in lib/story/audioJobs.js).
 *
 * The audio plan lives in story_projects.audio_plan:
 *
 *   {
 *     mode: 'narrated' | 'talking',          follows story_projects.mode; not set here
 *     voiceId,                               a preset voice (lib/providers/config.js) or one of the customer's own
 *     voiceTrackAssetId,                     the customer's own recording; when set, narration skips the voice model
 *     music: { type: 'generated' | 'upload' | 'none', prompt, assetId },
 *     captions: { on, style: 'serif_accent' | 'bold_pop' | 'clean' },   (burned in by the render task)
 *   }
 *
 * Narration is ONE synthesize call over every narrator line (each ended with a
 * full stop and separated by a blank line). The track is then cut into one
 * segment per line, at the silences ffmpeg finds (-35 dB, at least 0.25 s). If
 * the number of silences does not match the number of lines, the track is
 * split in proportion to each line's character count instead. The segments
 * are timings in the one track, not separate files:
 *
 *   story_projects.narration_segments: [{ sceneId, lineIndex, text, start, end }]   (seconds)
 *   story_projects.narration_seconds, narration_url, narration_key
 *
 * Money (lib/pricing.js is the only source of numbers), in audioAttemptCost:
 *   - the first pricing.included.narration / .music generations of a project are
 *     free (story_projects.narrations_used / music_used count them); after that
 *     each one costs pricing.narrationRegen / pricing.musicRegen, held up front
 *     and settled by the runner when the track is stored (released if the job
 *     fails);
 *   - a retry (`retry: true`, Try again after the last attempt FAILED) never
 *     charges twice: it costs what the failed attempt cost (a failed paid
 *     attempt was refunded, so its retry holds the price again; a failed free
 *     attempt is retried free, up to FREE_RETRIES times, then at the regen
 *     price). It does not use up a generation. A blocked attempt cannot be
 *     retried, and neither can one that did not fail;
 *   - the customer's own voice track costs nothing and uses up no generation.
 * narration_generate and music_generate need a paid plan (lib/story/limits.js).
 *
 * Starting a generation: claim (story_audio_claim, under the project row lock:
 * one claim and one job per kind at a time; it also counts the try), then hold,
 * then queue. Any error in between gives the hold back and un-counts the try.
 * A claim older than STALE_CLAIM_MS with no job was left by a request that
 * died: recoverStalledAudio releases its hold and un-counts it; every start
 * runs it first.
 */

export const MUSIC_TYPES = Object.freeze(['generated', 'upload', 'none']);
export const CAPTION_STYLES = Object.freeze(['serif_accent', 'bold_pop', 'clean']);
export const MUSIC_SUFFIX = 'full from the first second, no soft intro';
export const MAX_MUSIC_PROMPT = 300;
export const DEFAULT_MUSIC_PROMPT = 'Gentle instrumental background music';
// ffmpeg silencedetect settings for cutting the narration into lines.
export const SILENCE_DB = -35;
export const SILENCE_MIN_SECONDS = 0.25;
export const FREE_RETRIES = 3;
export const STALE_CLAIM_MS = 30_000;
const MIN_SPAN_SECONDS = 0.05;
const KINDS = Object.freeze(['narration', 'music']);
const COUNTER = { narration: 'narrations_used', music: 'music_used' };
const INCLUDED = { narration: 'narration', music: 'music' };
const REGEN = { narration: 'narrationRegen', music: 'musicRegen' };
const VOICE_TRACK_KINDS = ['voice_track', 'audio'];
const MUSIC_TRACK_KINDS = ['music', 'audio'];
// A download must end well inside the worker's 300 s window.
const DOWNLOAD_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

let deps = { enqueue, holdCredits };
/** Tests replace the queue and the hold call. Call with no argument to restore the real ones. */
export function _setAudioDeps(patch = {}) {
  deps = { enqueue: patch.enqueue || enqueue, holdCredits: patch.holdCredits || holdCredits };
}

// ---------------------------------------------------------------- script lines

/** The narrator lines of a script, in order: [{ sceneId, lineIndex, text }]. */
export function narratorLines(scenes = []) {
  const out = [];
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    (scene.lines || []).forEach((line, lineIndex) => {
      const text = String(line?.text ?? '').trim();
      if (line?.speaker === 'narrator' && text) out.push({ sceneId: scene.id, lineIndex, text });
    });
  }
  return out;
}

/** The text sent to the voice model: every line ends in a full stop (or ! or ?) and a blank line separates them. */
export function narrationText(lines) {
  return lines.map((l) => (/[.!?…]["')\]]*$/.test(l.text) ? l.text : `${l.text}.`)).join('\n\n');
}

const linesSig = (lines) => createHash('sha1').update(JSON.stringify(lines.map((l) => [l.sceneId, l.lineIndex, l.text]))).digest('hex').slice(0, 16);

async function latestScenes(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  return row?.scenes || [];
}

// ---------------------------------------------------------------- slicing

// One ffmpeg helper for the story code (lib/story/checks.js); this module only needs its exit code and stderr.
const runFfmpeg = (args, { timeoutMs = 60_000, signal } = {}) => runChecked(args, { check: false, timeoutMs, signal });

// The server-checked extension of an uploaded audio asset (lib/story/voices.js registerAudio stores the mime from it).
const CHECKED_AUDIO_EXT = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a' });
/** 'mp3' | 'wav' | 'm4a' for an uploaded audio asset whose type the server checked, else null (never trust a name). */
export function checkedAudioExt(asset) {
  // Exactly the value registerAudio stores: no case folding, no parameters.
  const mime = asset?.mime;
  return typeof mime === 'string' && Object.hasOwn(CHECKED_AUDIO_EXT, mime) ? CHECKED_AUDIO_EXT[mime] : null;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** The stretches of speech between silences, from ffmpeg's silencedetect output. -> { duration, spans: [[start, end]] } */
export function parseSilence(stderr) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!d) throw new Error('ffmpeg did not report a duration');
  const duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const spans = [];
  let cursor = 0;
  let silenceStart = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') {
      silenceStart = t;
      if (t - cursor >= MIN_SPAN_SECONDS) spans.push([cursor, t]);
    } else if (silenceStart !== null) {
      cursor = t;
      silenceStart = null;
    }
  }
  if (silenceStart === null && duration - cursor >= MIN_SPAN_SECONDS) spans.push([cursor, duration]);
  return { duration, spans };
}

/**
 * Cuts a narration track into one segment per line.
 *   filePath  the audio file
 *   lines     [{ sceneId, lineIndex, text }] in speaking order
 * -> { segments: [{ sceneId, lineIndex, text, start, end }], duration, method: 'silence' | 'longest_silences' | 'proportional' }
 * 'silence': the stretches of speech between silences (-35 dB, 0.25 s) are the
 * lines, when there are exactly as many of them as lines. With more stretches
 * than lines, the N-1 longest silences separate the lines ('longest_silences').
 * Fewer stretches than lines is 'proportional': from the first sound to the last, split by character count.
 */
export async function sliceNarration({ filePath, lines, ext, signal, forced = true }) {
  if (!Array.isArray(lines) || !lines.length) throw new TypeError('sliceNarration needs the lines');
  // ext: the demuxer is forced from it and only the file protocol is allowed (audioInputArgs), so a customer's
  // file is never read as a playlist. forced: false is for a track we made ourselves (a plain local file).
  const { stderr } = await runFfmpeg([...(forced ? audioInputArgs(ext) : ['-protocol_whitelist', 'file']), '-i', filePath, '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_SECONDS}`, '-f', 'null', '-'], { signal });
  const { duration, spans } = parseSilence(stderr);
  const make = (ranges, method) => ({
    method,
    duration: round3(duration),
    segments: lines.map((l, i) => ({ sceneId: l.sceneId, lineIndex: l.lineIndex, text: l.text, start: round3(ranges[i][0]), end: round3(ranges[i][1]) })),
  });
  if (spans.length === lines.length) return make(spans, 'silence');

  if (spans.length > lines.length) {
    // More pauses than lines: the lines are separated by the longest silences. Cut at the N-1 longest.
    const gaps = spans.slice(1).map((sp, i) => ({ i, size: sp[0] - spans[i][1] }));
    const cuts = new Set(gaps.sort((a, b) => b.size - a.size).slice(0, lines.length - 1).map((g) => g.i));
    const ranges = [[spans[0][0], spans[0][1]]];
    spans.slice(1).forEach((sp, i) => {
      if (cuts.has(i)) ranges.push([sp[0], sp[1]]);
      else ranges[ranges.length - 1][1] = sp[1];
    });
    return make(ranges, 'longest_silences');
  }
  const from = spans.length ? spans[0][0] : 0;
  const to = spans.length ? spans[spans.length - 1][1] : duration;
  const weights = lines.map((l) => Math.max(1, l.text.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let at = from;
  const ranges = weights.map((w) => {
    const start = at;
    at += ((to - from) * w) / total;
    return [start, at];
  });
  ranges[ranges.length - 1][1] = to;
  return make(ranges, 'proportional');
}

/** Slices audio held in memory (a fresh synthesis). */
export async function sliceBuffer({ buffer, ext = 'mp3', lines }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-audio-'));
  try {
    const filePath = path.join(dir, `track.${ext}`);
    await writeFile(filePath, buffer);
    return await sliceNarration({ filePath, lines, ext });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Slices the track at a url (the customer's own recording). Mock-mode urls are read from disk. */
export async function sliceUrl({ url, lines, ext, signal, forced = true }) {
  if (forced) audioInputArgs(ext); // refuses a customer's track whose type the server never checked, before any download
  const local = localPathFor(url);
  if (local) return sliceNarration({ filePath: local, lines, ext, signal, forced });
  // Inside the worker's 300 s window (the default download timeout is 10 minutes): a slow download fails clearly.
  const { filePath } = await downloadToFile(url, { maxBytes: AUDIO_LIMITS.maxBytes, provider: 'storage', timeoutMs: DOWNLOAD_MS, signal })
    .catch((err) => { throw new ProviderError('failed', 'We could not download your recording in time. Upload it again.', { cause: err }); });
  try {
    return await sliceNarration({ filePath, lines, ext, signal, forced });
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- plan

/** The plan a project has before the customer chooses anything. */
export function defaultPlan(project) {
  return {
    mode: project?.mode === 'talking' ? 'talking' : 'narrated',
    voiceId: listVoices()[0]?.id ?? null,
    voiceTrackAssetId: null,
    music: { type: 'generated', prompt: '', assetId: null },
    captions: { on: true, style: 'serif_accent' },
  };
}

/** The project's audio plan with every default filled in (the stored plan is {} until the first save). Render and captions read the plan through this. */
export function resolveAudioPlan(project) {
  const base = defaultPlan(project);
  const stored = isObject(project.audio_plan) ? project.audio_plan : {};
  return {
    ...base,
    ...(stored.voiceId !== undefined ? { voiceId: stored.voiceId } : {}),
    ...(stored.voiceTrackAssetId !== undefined ? { voiceTrackAssetId: stored.voiceTrackAssetId } : {}),
    music: { ...base.music, ...(isObject(stored.music) ? stored.music : {}) },
    captions: { ...base.captions, ...(isObject(stored.captions) ? stored.captions : {}) },
  };
}

async function ownedAsset(userId, assetId, kinds, field, what) {
  const [asset] = UUID.test(String(assetId)) ? await storyDb().select('story_assets', { id: assetId, user_id: userId }) : [];
  if (!asset || !kinds.includes(asset.kind)) throw new ValidationError(`Pick ${what} from your own uploads.`, { field });
  // Only audio whose type the server checked on upload (mp3, wav or m4a) is ever read by ffmpeg.
  if (!checkedAudioExt(asset)) throw new ValidationError(`Upload ${what} again as an mp3, wav or m4a file.`, { field });
  return asset;
}

/** The voices the customer can pick: the presets, then their own cloned voices. */
async function voicesFor(userId) {
  const own = (await storyDb().select('story_voices', { user_id: userId, status: 'ready' }, { order: 'created_at' })).filter((v) => v.provider_voice_id);
  // Their own recording is the preview of a clone.
  const sampleIds = own.map((v) => v.sample_asset_id).filter(Boolean);
  const samples = sampleIds.length ? await storyDb().select('story_assets', { user_id: userId, id: sampleIds }) : [];
  const urlOf = new Map(samples.map((a) => [a.id, a.url]));
  return [
    ...listVoices(),
    ...own.map((v) => ({ id: v.provider_voice_id, name: v.name, gender: null, sampleUrl: urlOf.get(v.sample_asset_id) ?? null, own: true })),
  ];
}

/**
 * A voice id the customer cannot use. One of their own clones that is not ready yet is a 422 (it is theirs, just not
 * usable); anything else, another customer's clone included, is the same 404, so no id can be tested for existing.
 */
async function refuseVoice(userId, voiceId) {
  if (typeof voiceId !== 'string') throw new ValidationError('Pick one of the listed voices.', { field: 'voiceId' });
  const [mine] = UUID.test(voiceId) ? await storyDb().select('story_voices', { id: voiceId, user_id: userId }) : [];
  if (mine) throw new ValidationError('That voice is not ready yet. Wait for it to finish, or pick another.', { field: 'voiceId' });
  throw new NotFoundError('That voice could not be found.');
}

async function bumpStep(project) {
  if (STEPS.indexOf(project.step) < STEPS.indexOf('audio')) {
    await storyDb().update('story_projects', { id: project.id, user_id: project.user_id }, { step: 'audio' });
  }
}

/**
 * Saves part or all of the audio plan (what is not sent stays as it was).
 * The music description is screened. -> { plan } (the whole plan)
 */
export async function setAudioPlan({ userId, projectId, plan }) {
  const project = await getProject({ userId, id: projectId });
  if (!isObject(plan)) throw new ValidationError('Send the voice and sound choices as an object.', { field: 'plan' });
  const bad = Object.keys(plan).find((k) => !['mode', 'voiceId', 'voiceTrackAssetId', 'music', 'captions'].includes(k));
  if (bad) throw new ValidationError(`${bad} cannot be set.`, { field: bad });

  const current = resolveAudioPlan(project);
  const next = { ...current, music: { ...current.music }, captions: { ...current.captions } };
  if ('mode' in plan && plan.mode !== project.mode) {
    throw new ValidationError('Narrated or talking follows the quality you picked, so it is not changed here.', { field: 'mode' });
  }
  if ('voiceId' in plan) {
    if (typeof plan.voiceId !== 'string' || !(await voicesFor(userId)).some((v) => v.id === plan.voiceId)) await refuseVoice(userId, plan.voiceId);
    next.voiceId = plan.voiceId;
  }
  if ('voiceTrackAssetId' in plan) {
    if (plan.voiceTrackAssetId !== null) await ownedAsset(userId, plan.voiceTrackAssetId, VOICE_TRACK_KINDS, 'voiceTrackAssetId', 'a recording');
    next.voiceTrackAssetId = plan.voiceTrackAssetId;
  }
  if ('music' in plan) {
    if (!isObject(plan.music)) throw new ValidationError('Send the music choices as an object.', { field: 'music' });
    const m = plan.music;
    if ('type' in m) {
      if (!MUSIC_TYPES.includes(m.type)) throw new ValidationError('Choose made for you, your own track, or no music.', { field: 'music.type' });
      next.music.type = m.type;
    }
    if ('prompt' in m) {
      const text = m.prompt === null ? '' : m.prompt;
      if (typeof text !== 'string') throw new ValidationError('Describe the music in words.', { field: 'music.prompt' });
      if (text.trim().length > MAX_MUSIC_PROMPT) throw new ValidationError(`Keep the music description to ${MAX_MUSIC_PROMPT} characters or fewer.`, { field: 'music.prompt' });
      next.music.prompt = text.replace(/\s+/g, ' ').trim();
    }
    if ('assetId' in m) next.music.assetId = m.assetId;
    if (next.music.type !== 'upload') next.music.assetId = null;
    if (next.music.type === 'upload') {
      if (!next.music.assetId) throw new ValidationError('Pick the track you uploaded.', { field: 'music.assetId' });
      await ownedAsset(userId, next.music.assetId, MUSIC_TRACK_KINDS, 'music.assetId', 'a track');
    }
  }
  if ('captions' in plan) {
    if (!isObject(plan.captions)) throw new ValidationError('Send the captions choices as an object.', { field: 'captions' });
    const c = plan.captions;
    if ('on' in c) {
      if (typeof c.on !== 'boolean') throw new ValidationError('Captions are on or off.', { field: 'captions.on' });
      next.captions.on = c.on;
    }
    if ('style' in c) {
      if (!CAPTION_STYLES.includes(c.style)) throw new ValidationError('Choose one of the caption styles.', { field: 'captions.style' });
      next.captions.style = c.style;
    }
  }
  if (next.music.prompt && next.music.prompt !== current.music.prompt) await screenText([next.music.prompt]);

  await storyDb().update('story_projects', { id: project.id, user_id: userId }, { audio_plan: next });
  await bumpStep(project);
  return { plan: next };
}

// ---------------------------------------------------------------- money

/**
 * What one attempt costs. The one place the audio price rules live (see the
 * header). used: the project's counter for this kind; jobs: this kind's jobs,
 * oldest first. -> { credits, kind: 'first' | 'regen' | 'retry', counted };
 * a retry that is not allowed throws ConflictError 'retry_not_available'.
 */
export function audioAttemptCost({ kind, used = 0, jobs = [], retry = false, pricing }) {
  const regen = Number(pricing[REGEN[kind]]) || 0;
  if (retry) {
    const last = jobs[jobs.length - 1];
    if (!last || last.status !== 'failed') {
      throw new ConflictError('There is nothing to try again. Make it again instead.', { code: 'retry_not_available' });
    }
    let credits = Number(last.payload?.credits ?? last.cost_credits ?? 0) || 0;
    // Free retries of free attempts are capped; after that a retry costs the regen price.
    if (credits === 0 && jobs.filter((j) => j.payload?.kind === 'retry' && !(Number(j.payload?.credits) > 0)).length >= FREE_RETRIES) {
      credits = regen;
    }
    return { credits, kind: 'retry', counted: false };
  }
  const included = Number(pricing.included?.[INCLUDED[kind]]) || 0;
  return used < included ? { credits: 0, kind: 'first', counted: true } : { credits: regen, kind: 'regen', counted: true };
}

// ---------------------------------------------------------------- starting a generation

const jobsOf = (projectId, kind) => storyDb().select('story_jobs', { project_id: projectId, kind }, { order: ['created_at', 'id'], limit: 500 });

const releaseQuietly = (holdId) => releaseHold({ holdId }).catch((e) => {
  if (!/hold_not_found/.test(e?.message || '')) console.error('[story] audio hold release failed', holdId, e?.message);
});

/**
 * Gives back what a start that died left: a claim older than STALE_CLAIM_MS.
 * With no job of its kind queued from it (the job's payload.claimId), its hold is released and its try
 * un-counted; with a job, only the claim is cleared. -> claims cleared.
 */
export async function recoverStalledAudio(projectId) {
  const [project] = await storyDb().select('story_projects', { id: projectId });
  if (!project) return 0;
  let cleared = 0;
  for (const kind of KINDS) {
    const claim = project.audio_claims?.[kind];
    if (!claim || Date.now() - Date.parse(claim.at) <= STALE_CLAIM_MS) continue;
    // The job carries the id of the claim it was queued from, so no clocks are compared.
    const queued = (await jobsOf(projectId, kind)).some((j) => j.payload?.claimId === claim.id);
    if (!queued && claim.hold_id) {
      try {
        await releaseHold({ holdId: claim.hold_id });
      } catch (err) {
        if (!/hold_not_found/.test(err?.message || '')) {
          console.error('[story] could not release a stalled audio hold', projectId, claim.hold_id, err?.message);
          continue;
        }
      }
    }
    if (await storyDb().rpc('story_audio_unclaim', { p_project: projectId, p_kind: kind, p_claim: claim.id, p_uncount: !queued })) cleared += 1;
  }
  return cleared;
}

/** expected_credits is optional: the price the customer was shown. A different price is 409 quote_changed and nothing is charged. */
function checkExpected(expectedCredits, credits) {
  if (expectedCredits === undefined || expectedCredits === null) return;
  if (expectedCredits !== credits) {
    throw new ConflictError('The price changed. Check the new price and try again.', { code: 'quote_changed', credits });
  }
}

function validExpected(expectedCredits) {
  if (expectedCredits !== undefined && expectedCredits !== null && (!Number.isInteger(expectedCredits) || expectedCredits < 0)) {
    throw new ValidationError('The price must be a whole number of credits.', { field: 'expected_credits' });
  }
}

/** Claims, holds, queues. Any failure after the claim gives the hold back and un-counts the try, then rethrows. */
async function startAudio({ project, kind, cost, payload }) {
  const claimId = randomUUID();
  const holdId = cost.credits > 0 ? randomUUID() : null;
  const [claimed] = await storyDb().rpc('story_audio_claim', {
    p_project: project.id, p_kind: kind, p_claim: claimId, p_hold: holdId, p_counted: cost.counted,
    p_now: new Date().toISOString(), p_used: cost.counted ? project[COUNTER[kind]] : null,
  });
  if (!claimed) throw new ConflictError(`The ${kind} is already being made, or it just changed. Wait for it to finish.`, { code: 'audio_busy' });
  try {
    if (holdId) await deps.holdCredits({ userId: project.user_id, currency: 'video', amount: cost.credits, projectId: project.id, holdId });
    // A claim reset as stalled meanwhile is not ours any more.
    const [mine] = await storyDb().select('story_projects', { id: project.id });
    if (mine?.audio_claims?.[kind]?.id !== claimId) throw new ConflictError('That took too long and was stopped. Try again.', { code: 'audio_busy' });
    await deps.enqueue({
      projectId: project.id,
      kind,
      payload: { kind: cost.kind, credits: cost.credits, claimId, ...payload },
      holdId,
      costCredits: holdId ? cost.credits : null,
    });
  } catch (err) {
    if (holdId) await releaseQuietly(holdId);
    await storyDb().rpc('story_audio_unclaim', { p_project: project.id, p_kind: kind, p_claim: claimId, p_uncount: true })
      .catch((e) => console.error('[story] could not clear an audio claim', project.id, e?.message));
    throw err;
  }
  await storyDb().rpc('story_audio_unclaim', { p_project: project.id, p_kind: kind, p_claim: claimId, p_uncount: false })
    .catch((e) => console.error('[story] could not clear an audio claim', project.id, e?.message));
  await kickWorker(AUDIO_WORKER_PATH); // the cron would find it within a minute; this starts it now (awaited, so it is sent)
}

/**
 * Starts the narration (the voice track, cut into lines). retry: true is Try
 * again after the last attempt failed. With a recording of the customer's own
 * in the plan, no voice model is used and nothing is charged.
 * -> { audio, charged }
 */
export async function generateNarration({ userId, projectId, retry = false, expectedCredits, user }) {
  validExpected(expectedCredits);
  let project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  if (project.mode !== 'narrated') {
    throw new ValidationError('A talking video uses the video’s own voices, so there is no narration to make.', { field: 'mode' });
  }
  const lines = narratorLines(await latestScenes(projectId));
  if (!lines.length) throw new ValidationError('Your script has no narrator lines to read. Add some in the script step.', { field: 'script' });
  const plan = resolveAudioPlan(project);
  const source = plan.voiceTrackAssetId ? 'upload' : 'generated';
  if (source === 'upload') await ownedAsset(userId, plan.voiceTrackAssetId, VOICE_TRACK_KINDS, 'voiceTrackAssetId', 'a recording');
  else if (!(await voicesFor(userId)).some((v) => v.id === plan.voiceId)) throw new ValidationError('Pick a voice first.', { field: 'voiceId' });
  await assertAllowed({ userId, action: 'narration_generate', projectId, user });
  await recoverStalledAudio(projectId);
  project = await getProject({ userId, id: projectId });

  const cost = source === 'upload'
    ? { credits: 0, kind: 'upload', counted: false }
    : await narrationCost({ project, retry, source });
  checkExpected(expectedCredits, cost.credits);
  await startAudio({
    project, kind: 'narration', cost,
    payload: { source, voiceId: source === 'generated' ? plan.voiceId : null, assetId: source === 'upload' ? plan.voiceTrackAssetId : null, text: narrationText(lines), lines, sig: linesSig(lines) },
  });
  await bumpStep(project);
  return { audio: await getAudio({ userId, projectId }), charged: cost.credits };
}

async function narrationCost({ project, retry, source }) {
  const jobs = await jobsOf(project.id, 'narration');
  // A retry uses the source of the attempt that failed; after a switch it is a normal make.
  return audioAttemptCost({ kind: 'narration', used: project.narrations_used, jobs, retry: retry && sameSource(jobs.at(-1), source), pricing: await getPricing() });
}

/** The description sent to the music model: the customer's words (or a default), then the line that is always added. */
export function musicPrompt(plan) {
  const base = String(plan?.music?.prompt || '').trim().replace(/[\s.,;]+$/, '') || DEFAULT_MUSIC_PROMPT;
  return `${base}, ${MUSIC_SUFFIX}`;
}

/** Starts the background music. retry: true is Try again after the last attempt failed. -> { audio, charged } */
export async function generateMusic({ userId, projectId, retry = false, expectedCredits, user }) {
  validExpected(expectedCredits);
  let project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  const plan = resolveAudioPlan(project);
  if (plan.music.type !== 'generated') {
    throw new ValidationError(plan.music.type === 'upload' ? 'Your own track is used as it is, so there is nothing to make.' : 'Music is switched off. Choose "Make music for me" first.', { field: 'music.type' });
  }
  await assertAllowed({ userId, action: 'music_generate', projectId, user });
  await recoverStalledAudio(projectId);
  project = await getProject({ userId, id: projectId });

  const cost = audioAttemptCost({ kind: 'music', used: project.music_used, jobs: await jobsOf(projectId, 'music'), retry, pricing: await getPricing() });
  checkExpected(expectedCredits, cost.credits);
  await startAudio({ project, kind: 'music', cost, payload: { prompt: musicPrompt(plan), seconds: project.seconds + 4 } });
  await bumpStep(project);
  return { audio: await getAudio({ userId, projectId }), charged: cost.credits };
}

// ---------------------------------------------------------------- the view

function trackState({ project, kind, jobs, hasUrl, key }) {
  const claim = project.audio_claims?.[kind];
  let last = jobs.at(-1);
  if (claim && Date.now() - Date.parse(claim.at) <= STALE_CLAIM_MS) return { status: 'pending', error: null, last };
  if (last) {
    if (last.status === 'queued' || last.status === 'running') return { status: 'pending', error: null, last };
    if (last.status === 'done') {
      if (!last.applied_at) return { status: 'pending', error: null, last };
      // Charged but its result could not be applied ("needs attention"): not a track the customer has.
      if (last.error) return { status: 'failed', error: last.error, last };
      return { status: 'ready', error: null, last };
    }
    // A blocked attempt is about specific words: once they changed, the normal flow is back.
    if (last.status === 'blocked' && key !== undefined && (last.payload?.[kind === 'narration' ? 'sig' : 'prompt'] ?? null) !== key) {
      last = null;
      return { status: hasUrl ? 'ready' : 'none', error: null, last };
    }
    return { status: last.status === 'blocked' ? 'blocked' : 'failed', error: last.error || null, last };
  }
  return { status: hasUrl ? 'ready' : 'none', error: null, last };
}

/** A retry must use the source of the attempt that failed; after a switch it is a normal make. */
const sameSource = (job, source) => (job?.payload?.source || 'generated') === source;

function prices({ kind, project, jobs, pricing, last, free }) {
  const included = Number(pricing.included?.[INCLUDED[kind]]) || 0;
  const used = project[COUNTER[kind]];
  let retryCredits = null;
  if (last?.status === 'failed') {
    try {
      retryCredits = free ? 0 : audioAttemptCost({ kind, used, jobs, retry: true, pricing }).credits;
    } catch {
      retryCredits = null;
    }
  }
  return {
    credits: free ? 0 : audioAttemptCost({ kind, used, jobs: [], pricing }).credits,
    retry_credits: retryCredits,
    included,
    used,
    free_left: Math.max(0, included - used),
  };
}

/**
 * Everything the screen needs.
 * -> { plan, voices, applicable: { narration, narrationLines },
 *      narration: { status, url, seconds, segments, error, outdated, source, credits, retry_credits, included, used, free_left },
 *      music: { type, status, url, error, source, credits, retry_credits, included, used, free_left } }
 * status: 'none' | 'pending' | 'ready' | 'failed' | 'blocked'. After a failed
 * or blocked attempt `url` is still the earlier track, if there was one.
 * credits: what a normal make costs now. retry_credits: what Try again costs
 * now, null when there is nothing to try again.
 */
export async function getAudio({ userId, projectId }) {
  const project = await getProject({ userId, id: projectId });
  const [pricing, narrationJobs, musicJobs, scenes, voices] = await Promise.all([
    getPricing(), jobsOf(projectId, 'narration'), jobsOf(projectId, 'music'), latestScenes(projectId), voicesFor(userId),
  ]);
  const plan = resolveAudioPlan(project);
  const lines = narratorLines(scenes);

  // narration
  const nSource = plan.voiceTrackAssetId ? 'upload' : 'generated';
  const n = trackState({ project, kind: 'narration', jobs: narrationJobs, hasUrl: Boolean(project.narration_url), key: linesSig(lines) });
  const lastDone = [...narrationJobs].reverse().find((j) => j.status === 'done' && j.applied_at);
  let outdated = false;
  if (n.status === 'ready' && lastDone) {
    const p = lastDone.payload || {};
    outdated = (p.sig ?? null) !== linesSig(lines)
      || (p.source || 'generated') !== nSource
      || (nSource === 'upload' ? p.assetId !== plan.voiceTrackAssetId : p.voiceId !== plan.voiceId);
  }
  const narration = {
    status: n.status,
    url: project.narration_url || null,
    seconds: project.narration_seconds ?? null,
    segments: project.narration_segments || null,
    error: n.error,
    outdated,
    source: lastDone ? lastDone.payload?.source || 'generated' : nSource,
    ...prices({ kind: 'narration', project, jobs: narrationJobs, pricing, last: n.last && sameSource(n.last, nSource) ? n.last : null, free: nSource === 'upload' }),
  };

  // music
  let music;
  if (plan.music.type === 'upload') {
    const [asset] = plan.music.assetId ? await storyDb().select('story_assets', { id: plan.music.assetId, user_id: userId }) : [];
    music = { status: asset ? 'ready' : 'none', url: asset?.url || null, error: null, source: 'upload', ...prices({ kind: 'music', project, jobs: [], pricing, last: null, free: true }) };
  } else {
    const m = trackState({ project, kind: 'music', jobs: musicJobs, hasUrl: Boolean(project.music_url), key: musicPrompt(plan) });
    music = {
      status: plan.music.type === 'none' ? 'none' : m.status,
      url: plan.music.type === 'none' ? null : project.music_url || null,
      error: m.error,
      source: 'generated',
      ...prices({ kind: 'music', project, jobs: musicJobs, pricing, last: m.last, free: false }),
    };
  }
  music.type = plan.music.type;

  // The customer's own files, so the screen can name them.
  const uploads = { voiceTrack: null, music: null };
  for (const [slot, id] of [['voiceTrack', plan.voiceTrackAssetId], ['music', plan.music.type === 'upload' ? plan.music.assetId : null]]) {
    const [a] = id ? await storyDb().select('story_assets', { id, user_id: userId }) : [];
    if (a) uploads[slot] = { id: a.id, name: a.name, seconds: a.duration_seconds ?? null };
  }

  return {
    plan,
    uploads,
    voices: voices.map(({ id, name, gender, sampleUrl, own }) => ({ id, name, gender, sampleUrl, ...(own ? { own: true } : {}) })),
    applicable: { narration: project.mode === 'narrated', narrationLines: lines.length },
    narration,
    music,
  };
}

// ---------------------------------------------------------------- HTTP actions

// GET   /api/story/projects/[id]/audio      -> { audio }   (the view above)
// POST  /api/story/projects/[id]/audio      { plan }       -> { audio }   save choices (partial plan is merged)
// POST  /api/story/projects/[id]/narration  { retry?, expected_credits? } -> { audio, charged }
// POST  /api/story/projects/[id]/music      { retry?, expected_credits? } -> { audio, charged }
// expected_credits: the price on the button; a different price is 409 quote_changed ({ credits }) and nothing is charged.
// 402 plan_required / insufficient_credits; 409 audio_busy (already being made), retry_not_available or quote_changed; 422 validation.
export const getAudioAction = async ({ userId, projectId }) => ({ audio: await getAudio({ userId, projectId }) });
export const setAudioAction = async ({ userId, projectId, body = {} }) => {
  await setAudioPlan({ userId, projectId, plan: body.plan });
  return { audio: await getAudio({ userId, projectId }) };
};
export const narrationAction = async ({ userId, user, projectId, body = {} }) => generateNarration({ userId, projectId, retry: body.retry === true, expectedCredits: body.expected_credits, user });
export const musicAction = async ({ userId, user, projectId, body = {} }) => generateMusic({ userId, projectId, retry: body.retry === true, expectedCredits: body.expected_credits, user });

registerAction('audio', { method: 'GET', handler: getAudioAction });
registerAction('audio', { method: 'POST', handler: setAudioAction });
registerAction('narration', { method: 'POST', handler: narrationAction });
registerAction('music', { method: 'POST', handler: musicAction });
