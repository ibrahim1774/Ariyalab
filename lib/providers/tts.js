/*
 * Narration voices on Fish Audio.
 *
 *   listVoices()                   -> [{ id, name, gender, sampleUrl }]  (curated, from config)
 *   synthesize({ voiceId, text })  -> { buffer, mime }
 *   cloneVoice({ sampleUrl, name }) -> { voiceId }
 */

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { MODEL_IDS, PROVIDER_CONFIG } from './config.js';
import { ProviderError, requireEnv } from './errors.js';
import { downloadToFile, requestBuffer, requestJson } from './http.js';
import { MOCK_URLS, fixturePath, isMock, nextMockNumber } from './mock.js';

const PROVIDER = 'fish';

export function listVoices() {
  return PROVIDER_CONFIG.fish.voices.map(({ id, name, gender, sampleUrl }) => ({
    id,
    name,
    gender,
    sampleUrl: isMock() ? MOCK_URLS.voice : sampleUrl,
  }));
}

export async function synthesize({ voiceId, text }) {
  const clean = String(text || '').trim();
  if (!clean) throw new ProviderError('failed', 'There is no text to read.');
  if (isMock()) return { buffer: await readFile(fixturePath('voice.mp3')), mime: 'audio/mpeg' };
  const cfg = PROVIDER_CONFIG.fish;
  const key = requireEnv(cfg.env, PROVIDER);
  const { buffer } = await requestBuffer(cfg.ttsUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model: MODEL_IDS.tts },
    body: JSON.stringify({
      text: clean,
      reference_id: voiceId,
      format: 'mp3',
      mp3_bitrate: cfg.mp3Bitrate,
      latency: 'normal',
    }),
  }, { provider: PROVIDER, timeoutMs: 3 * 60 * 1000 });
  if (buffer.length === 0) throw new ProviderError('failed', undefined, { cause: new Error('Empty TTS response'), provider: PROVIDER });
  return { buffer, mime: 'audio/mpeg' };
}

export async function cloneVoice({ sampleUrl, name }) {
  if (isMock()) return { voiceId: `mock-voice-${nextMockNumber('voice')}` };
  const cfg = PROVIDER_CONFIG.fish;
  const key = requireEnv(cfg.env, PROVIDER);
  const { filePath, contentType } = await downloadToFile(sampleUrl, { maxBytes: cfg.maxSampleBytes, provider: PROVIDER });
  try {
    const form = new FormData();
    form.append('type', 'tts');
    form.append('title', String(name || 'My voice').slice(0, 100));
    form.append('train_mode', 'fast');
    form.append('visibility', 'private');
    form.append('voices', new Blob([await readFile(filePath)], { type: contentType || 'audio/mpeg' }), 'sample');
    const body = await requestJson(cfg.modelUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    }, { provider: PROVIDER, timeoutMs: 3 * 60 * 1000 });
    if (!body?._id) throw new ProviderError('failed', undefined, { cause: new Error('No model id from Fish'), provider: PROVIDER });
    return { voiceId: body._id };
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
}
