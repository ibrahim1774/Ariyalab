import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { transcribe } from '../providers/stt.js';

/*
 * Quality checks on a finished render (Task 20), and the ffmpeg helpers the
 * render shares with them.
 *
 *   run({ renderPath, scriptWords, timeoutMs }) -> { ok, failures: [{ code, message }], measures }
 *     measures: { lufs, longestSilence, coverage, duration }
 *
 * Three checks, all on the final mixed audio (what the customer hears):
 *   words     the audio is transcribed (lib/providers/stt.js; mock fixture in
 *             tests) and at least WORD_COVERAGE_MIN of the script words must be
 *             in it. Skipped when there are no script words. A transcription that
 *             fails is not a failure: it is reported as `words_unchecked`, which
 *             the render saves as a warning without retrying the mix.
 *   silence   no stretch quieter than SILENCE_DB lasting more than
 *             SILENCE_MAX_SECONDS, in narrated and talking videos alike. Music
 *             counts as sound: this catches dead air, not pauses under music.
 *   loudness  integrated loudness (ffmpeg ebur128) inside LOUDNESS_RANGE.
 *
 * The render retries its mix once when a check fails, then saves what still
 * fails as warnings on the story_renders row.
 */

export const WORD_COVERAGE_MIN = 0.95;
export const SILENCE_MAX_SECONDS = 0.6;
export const SILENCE_DB = -50;
export const LOUDNESS_RANGE = Object.freeze([-15, -13]);

export const CHECK_MESSAGES = Object.freeze({
  words: (c) => `Some of the script could not be heard clearly in the finished video (${Math.round(c * 100)}% of the words were found).`,
  words_unchecked: 'The words in the finished video could not be checked this time.',
  silence: (s) => `The finished video has a silent gap of ${s.toFixed(1)} seconds.`,
  loudness: (l) => `The finished video's volume is ${Number.isFinite(l) ? `${l.toFixed(1)} LUFS` : 'unknown'}, outside the usual range.`,
});
const MESSAGES = CHECK_MESSAGES;

// ---------------------------------------------------------------- ffmpeg

let binary = null;
/** The bundled ffmpeg (@ffmpeg-installer/ffmpeg), or `ffmpeg` on the path. */
export async function ffmpegPath() {
  if (!binary) {
    binary = import('@ffmpeg-installer/ffmpeg')
      .then((mod) => (mod.default || mod).path || 'ffmpeg')
      .catch(() => 'ffmpeg');
  }
  return binary;
}

/**
 * Runs ffmpeg and resolves with { code, stderr }. With `check`, a non-zero
 * exit rejects with the last stderr lines. `signal` and `timeoutMs` kill it.
 */
export async function runFfmpeg(args, { cwd, signal, timeoutMs = 240_000, check = true } = {}) {
  const bin = await ffmpegPath();
  if (signal?.aborted) throw new Error('ffmpeg: aborted before start');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostats', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let killed = null;
    const kill = (why) => { killed = why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => kill('timed out'), timeoutMs);
    const onAbort = () => kill('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.on('error', (err) => { done(); reject(err); });
    child.on('close', (code) => {
      done();
      if (killed) return reject(new Error(`ffmpeg ${killed}`));
      if (check && code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
      return resolve({ code, stderr });
    });
  });
}

/** Seconds from ffmpeg's "Duration: hh:mm:ss.cc" line, or NaN. */
export function parseDuration(stderr) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr));
  return d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : NaN;
}

/** -> { duration, hasAudio, hasVideo } of a media file. */
export async function probe(file, { cwd, signal } = {}) {
  const { stderr } = await runFfmpeg(['-i', file], { cwd, signal, check: false, timeoutMs: 30_000 });
  return {
    duration: parseDuration(stderr),
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
    hasVideo: /Stream #\d+:\d+.*: Video:/.test(stderr),
  };
}

// ---------------------------------------------------------------- words

/** Lower case, letters and digits only ("Time," -> "time"). */
export const normalizeWord = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The normalised words of some texts. */
export const wordsOfTexts = (texts) => texts.flatMap((t) => String(t || '').split(/\s+/)).map(normalizeWord).filter(Boolean);

/** The words a narrated video says: its narrator lines (cast lines are never voiced in a narrated video). */
export function scriptWordsOf(scenes = [], mode = 'narrated') {
  const lines = (Array.isArray(scenes) ? scenes : []).flatMap((s) => s.lines || []);
  return wordsOfTexts(lines.filter((l) => (mode === 'talking' ? l.speaker !== 'narrator' : l.speaker === 'narrator')).map((l) => l.text));
}

/** Share of script words (as a multiset) found in the transcript words. 1 when there are none. */
export function wordCoverage(scriptWords = [], transcriptWords = []) {
  if (!scriptWords.length) return 1;
  const bag = new Map();
  for (const x of transcriptWords) {
    const k = normalizeWord(x?.w ?? x);
    if (k) bag.set(k, (bag.get(k) || 0) + 1);
  }
  let found = 0;
  for (const w of scriptWords) {
    const k = normalizeWord(w);
    if (bag.get(k) > 0) {
      found += 1;
      bag.set(k, bag.get(k) - 1);
    }
  }
  return found / scriptWords.length;
}

// ---------------------------------------------------------------- measures

/** The longest silence in ffmpeg silencedetect output; a silence still open at the end runs to `duration`. */
export function longestSilence(stderr, duration) {
  let longest = 0;
  let open = null;
  for (const line of String(stderr).split('\n')) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (e) {
      longest = Math.max(longest, Number(e[2]));
      open = null;
    }
  }
  if (open !== null && Number.isFinite(duration)) longest = Math.max(longest, duration - open);
  return longest;
}

/** Integrated loudness from the ebur128 summary, or NaN. */
export function integratedLoudness(stderr) {
  const text = String(stderr);
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const m = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  return m ? Number(m[1]) : NaN;
}

/** -> { lufs, longestSilence, duration } of the audio in a file. */
export async function measureAudio(file, { cwd, signal } = {}) {
  const { stderr } = await runFfmpeg(
    ['-i', file, '-vn', '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MAX_SECONDS},ebur128`, '-f', 'null', '-'],
    { cwd, signal, timeoutMs: 120_000 },
  );
  const duration = parseDuration(stderr);
  return { lufs: integratedLoudness(stderr), longestSilence: longestSilence(stderr, duration), duration };
}

// ---------------------------------------------------------------- run

/** The three checks (see the header). */
export async function run({ renderPath, scriptWords = [], timeoutMs = 120_000, signal } = {}) {
  const failures = [];
  const measured = await measureAudio(renderPath, { signal });
  const measures = { lufs: measured.lufs, longestSilence: measured.longestSilence, duration: measured.duration, coverage: null };

  if (scriptWords.length) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'story-checks-'));
    try {
      const wav = path.join(dir, 'speech.wav');
      await runFfmpeg(['-y', '-i', renderPath, '-vn', '-ac', '1', '-ar', '16000', wav], { signal, timeoutMs: 60_000 });
      const { words } = await transcribe({ filePath: wav, timeoutMs });
      measures.coverage = Math.round(wordCoverage(scriptWords, words) * 1000) / 1000;
      if (measures.coverage < WORD_COVERAGE_MIN) failures.push({ code: 'words', message: MESSAGES.words(measures.coverage) });
    } catch (err) {
      console.error('[story] render check: transcription failed', err?.message || err);
      failures.push({ code: 'words_unchecked', message: MESSAGES.words_unchecked });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (measures.longestSilence > SILENCE_MAX_SECONDS) failures.push({ code: 'silence', message: MESSAGES.silence(measures.longestSilence) });
  const [lo, hi] = LOUDNESS_RANGE;
  if (!(measures.lufs >= lo && measures.lufs <= hi)) failures.push({ code: 'loudness', message: MESSAGES.loudness(measures.lufs) });

  return { ok: failures.length === 0, failures, measures };
}
