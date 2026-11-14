/*
 * Background music on Google Lyria through the Gemini API.
 *
 *   generateMusic({ prompt, seconds }) -> { buffer, mime }
 *
 * Up to 30 s uses the clip model, which always returns a 30 s clip; longer
 * requests use the song model with the length asked for in the prompt. The
 * render step trims or loops the track to the video, so `seconds` is a target,
 * not a guarantee.
 */

import { readFile } from 'node:fs/promises';

import { MODEL_IDS, PROVIDER_CONFIG } from './config.js';
import { ProviderError, isContentRefusal, requireEnv } from './errors.js';
import { requestJson } from './http.js';
import { fixturePath, isMock } from './mock.js';

const PROVIDER = 'lyria';

function findAudio(body) {
  for (const step of Array.isArray(body?.steps) ? body.steps : []) {
    if (step?.type !== 'model_output') continue;
    for (const part of Array.isArray(step.content) ? step.content : []) {
      if (part?.type === 'audio' && part.data) return part;
    }
  }
  return null;
}

export async function generateMusic({ prompt, seconds = 30 }) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new ProviderError('failed', 'A music description is required.');
  if (isMock()) return { buffer: await readFile(fixturePath('music.mp3')), mime: 'audio/mpeg' };
  const cfg = PROVIDER_CONFIG.lyria;
  const key = requireEnv(cfg.env, PROVIDER);
  const long = Number(seconds) > cfg.clipSeconds;
  const body = await requestJson(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': cfg.apiRevision },
    body: JSON.stringify({
      model: long ? MODEL_IDS.music.song : MODEL_IDS.music.clip,
      input: long ? `${clean}\nInstrumental, about ${Math.round(Number(seconds))} seconds long.` : `${clean}\nInstrumental.`,
      response_format: { type: 'audio' },
    }),
  }, { provider: PROVIDER, timeoutMs: 5 * 60 * 1000 });
  const audio = findAudio(body);
  if (!audio) {
    const detail = JSON.stringify(body).slice(0, 1000);
    throw new ProviderError(isContentRefusal(detail) ? 'blocked' : 'failed', undefined, { cause: new Error(detail), provider: PROVIDER });
  }
  return { buffer: Buffer.from(audio.data, 'base64'), mime: audio.mime_type || 'audio/mpeg' };
}
