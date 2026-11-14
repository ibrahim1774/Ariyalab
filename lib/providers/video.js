/*
 * Video clips. Every quality runs on kie.ai: economy on Seedance 2.0 Mini,
 * the rest on Kling 3.0 (see QUALITY_MAP in config.js).
 *
 *   submitClip({ quality, imageUrl, prompt, seconds, aspect, elements, callbackUrl })
 *     -> { provider, taskId }
 *   getClip({ provider, taskId })  -> { status, url, error }
 *   parseCallback(provider, body)  -> { taskId, status, url, error }
 *
 * elements = [{ name, description, imageUrls: [2-4 urls] }] become Kling
 * character elements (refer to them as @name in the prompt). Economy has no
 * element support: Seedance cannot combine a first frame with reference
 * images, so the still (imageUrl) carries the characters and elements are
 * ignored.
 */

import { PROVIDER_CONFIG, QUALITY_MAP } from './config.js';
import { ProviderError } from './errors.js';
import { fetchKieTask, parseKieCallback, submitKieTask } from './kieTasks.js';
import { MOCK_URLS, isMock, mockTaskId, pollMockTask } from './mock.js';
import { buildKlingInput } from '../kie.js';

export const QUALITIES = ['economy', 'standard', 'pro_narrated', 'pro_talking'];

function qualityConfig(quality) {
  const q = QUALITY_MAP[quality];
  if (!q) throw new ProviderError('failed', 'Unknown quality level.', { cause: new Error(`quality=${quality}`) });
  return q;
}

/** Generated seconds for a quality: rounded up, then clamped to the model's range. */
export function clampSeconds(quality, seconds) {
  const { family } = qualityConfig(quality);
  const { minSeconds, maxSeconds } = PROVIDER_CONFIG[family];
  const n = Math.ceil(Number(seconds));
  if (!Number.isFinite(n)) return minSeconds;
  return Math.max(minSeconds, Math.min(maxSeconds, n));
}

function klingElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return undefined;
  const lim = PROVIDER_CONFIG.kling;
  if (elements.length > lim.maxElements) {
    throw new ProviderError('failed', `A shot can use at most ${lim.maxElements} characters.`);
  }
  for (const e of elements) {
    const n = Array.isArray(e?.imageUrls) ? e.imageUrls.length : 0;
    if (!e?.name || n < lim.minElementImages || n > lim.maxElementImages) {
      throw new ProviderError(
        'failed',
        `Each character needs ${lim.minElementImages} to ${lim.maxElementImages} reference images.`,
      );
    }
  }
  return elements;
}

/** Pure: the kie createTask body for a clip. */
export function buildClipRequest({ quality, imageUrl, prompt, seconds, aspect = '9:16', elements, callbackUrl }) {
  const q = qualityConfig(quality);
  const duration = clampSeconds(quality, seconds);
  let input;
  if (q.family === 'seedance') {
    input = {
      prompt: (prompt || '').trim() || 'natural motion',
      ...(imageUrl ? { first_frame_url: imageUrl } : {}),
      resolution: q.resolution,
      duration: String(duration),
      aspect_ratio: aspect,
      generate_audio: q.sound,
    };
  } else {
    input = buildKlingInput({
      imageUrl,
      prompt: String(prompt || '').slice(0, PROVIDER_CONFIG.kling.maxPromptChars),
      duration,
      mode: q.mode,
      sound: q.sound,
      aspectRatio: aspect,
      elements: klingElements(elements),
    });
  }
  const request = { model: q.model, input };
  if (callbackUrl) request.callBackUrl = callbackUrl;
  return request;
}

export async function submitClip(args) {
  const request = buildClipRequest(args);
  if (isMock()) return { provider: 'mock', taskId: mockTaskId('clip', args.prompt) };
  const { provider, taskId } = await submitKieTask({
    model: request.model,
    input: request.input,
    callBackUrl: request.callBackUrl,
  });
  return { provider, taskId };
}

export async function getClip({ provider, taskId }) {
  if (provider === 'mock') return pollMockTask(taskId, MOCK_URLS.clip);
  if (provider !== 'kie') throw new ProviderError('failed', undefined, { cause: new Error(`provider=${provider}`) });
  const { status, url, error } = await fetchKieTask(taskId);
  return { status, url, error };
}

export function parseCallback(provider, body) {
  if (provider === 'kie' || provider === 'mock') {
    const out = parseKieCallback(body);
    if (provider === 'mock' && out.status === 'done' && !out.url) out.url = MOCK_URLS.clip;
    return out;
  }
  throw new ProviderError('failed', undefined, { cause: new Error(`Unknown callback provider ${provider}`) });
}
