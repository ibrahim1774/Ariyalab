/*
 * Speech to text with word timestamps.
 *
 *   transcribe({ filePath, timeoutMs? }) -> { text, words: [{ w, start, end }] }  (seconds)
 *
 * timeoutMs (optional) bounds the whole call, the Replicate fallback included.
 *
 * Groq whisper-large-v3-turbo is the default whenever GROQ_API_KEY is set.
 * Replicate WhisperX (REPLICATE_API_TOKEN) is the fallback when Groq is not
 * configured, or when Groq fails (config, rate limit or any other failure).
 * Customer audio is sent to Replicate as a file input (uploaded by the SDK to
 * Replicate's own file store), never to public storage.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import Replicate from 'replicate';

import { MODEL_IDS, PROVIDER_CONFIG } from './config.js';
import { ProviderError, configError, requireEnv } from './errors.js';
import { requestJson } from './http.js';
import { isMock } from './mock.js';

// Matches the three tone bursts in tests/fixtures/voice.mp3.
const MOCK_TRANSCRIPT = {
  text: 'Once upon a time, a baker dreamed big.',
  words: [
    { w: 'Once', start: 0.05, end: 0.35 },
    { w: 'upon', start: 0.4, end: 0.7 },
    { w: 'a', start: 0.75, end: 0.85 },
    { w: 'time,', start: 0.9, end: 1.35 },
    { w: 'a', start: 1.8, end: 1.9 },
    { w: 'baker', start: 1.95, end: 2.75 },
    { w: 'dreamed', start: 3.2, end: 3.6 },
    { w: 'big.', start: 3.65, end: 3.95 },
  ],
};

function audioMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'audio/webm' }[ext]
    || 'application/octet-stream';
}

function msLeft(deadline, fallback) {
  if (!deadline) return fallback;
  return Math.min(fallback ?? Infinity, Math.max(1000, deadline - Date.now()));
}

async function viaGroq(filePath, deadline) {
  const cfg = PROVIDER_CONFIG.groq;
  const key = requireEnv(cfg.env, 'groq');
  const { size } = await stat(filePath);
  if (size > cfg.maxBytes) {
    throw new ProviderError('failed', undefined, { cause: new Error(`Audio ${size} bytes exceeds Groq limit`), provider: 'groq' });
  }
  const form = new FormData();
  form.append('file', new Blob([await readFile(filePath)], { type: audioMime(filePath) }), path.basename(filePath));
  form.append('model', MODEL_IDS.stt.groq);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const body = await requestJson(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  }, { provider: 'groq', timeoutMs: msLeft(deadline, 5 * 60 * 1000) });
  const words = (Array.isArray(body?.words) ? body.words : [])
    .filter((x) => x && typeof x.word === 'string')
    .map((x) => ({ w: x.word.trim(), start: Number(x.start), end: Number(x.end) }))
    .filter((x) => x.w);
  return { text: String(body?.text || '').trim(), words };
}

/** WhisperX can leave a word without times; fill from neighbours/segment. */
function wordsFromSegments(segments) {
  const words = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const list = Array.isArray(seg?.words) ? seg.words : [];
    list.forEach((x, i) => {
      if (!x || typeof x.word !== 'string' || !x.word.trim()) return;
      const prevEnd = words.length ? words[words.length - 1].end : Number(seg.start) || 0;
      const nextStart = list.slice(i + 1).find((n) => Number.isFinite(n?.start))?.start;
      const start = Number.isFinite(x.start) ? x.start : prevEnd;
      let end = Number.isFinite(x.end) ? x.end : (Number.isFinite(nextStart) ? nextStart : Number(seg.end));
      if (!Number.isFinite(end) || end < start) end = start;
      words.push({ w: x.word.trim(), start, end });
    });
  }
  return words;
}

async function viaReplicate(filePath, deadline) {
  const auth = requireEnv(PROVIDER_CONFIG.replicate.env, 'replicate');
  const { size } = await stat(filePath);
  if (size > PROVIDER_CONFIG.replicate.maxBytes) {
    throw new ProviderError('failed', 'That audio file is too large to transcribe.', {
      cause: { message: `Audio ${size} bytes exceeds the Replicate cap` }, provider: 'replicate',
    });
  }
  const replicate = new Replicate({ auth });
  let output;
  try {
    output = await replicate.run(MODEL_IDS.stt.replicate, {
      input: { audio_file: await readFile(filePath), align_output: true },
      ...(deadline ? { signal: AbortSignal.timeout(msLeft(deadline)) } : {}),
    });
  } catch (err) {
    const status = err?.response?.status;
    throw new ProviderError(status === 429 ? 'rate_limited' : 'failed', undefined, { cause: err, provider: 'replicate' });
  }
  const segments = output?.segments;
  const text = (Array.isArray(segments) ? segments : []).map((s) => String(s?.text || '').trim()).filter(Boolean).join(' ');
  return { text, words: wordsFromSegments(segments) };
}

async function assertReadable(filePath) {
  const info = await stat(String(filePath || '')).catch(() => null);
  if (!info?.isFile()) {
    throw new ProviderError('failed', undefined, { cause: { message: `Audio file not found: ${filePath}` } });
  }
}

export async function transcribe({ filePath, timeoutMs }) {
  await assertReadable(filePath);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
  if (isMock()) return { text: MOCK_TRANSCRIPT.text, words: MOCK_TRANSCRIPT.words.map((x) => ({ ...x })) };
  const hasGroq = Boolean(process.env[PROVIDER_CONFIG.groq.env]);
  const hasReplicate = Boolean(process.env[PROVIDER_CONFIG.replicate.env]);
  if (!hasGroq && !hasReplicate) throw configError(PROVIDER_CONFIG.groq.env, 'groq');
  if (hasGroq) {
    try {
      return await viaGroq(filePath, deadline);
    } catch (err) {
      const retryable = err instanceof ProviderError && err.code !== 'blocked';
      if (!retryable || !hasReplicate) throw err;
      console.warn('[stt] Groq failed, falling back to Replicate:', err.code, err.cause?.message || '');
    }
  }
  return viaReplicate(filePath, deadline);
}
