/*
 * Stills and cast sheets on kie.ai Nano Banana (same model and body shape as
 * pages/api/glow-up.js, which keeps its own inline call).
 *
 *   submitImage({ prompt, refs, aspect, size })  -> { provider, taskId }
 *   getImage({ provider, taskId })               -> { status, url, error }
 */

import { MODEL_IDS, PROVIDER_CONFIG } from './config.js';
import { ProviderError } from './errors.js';
import { fetchKieTask, submitKieTask } from './kieTasks.js';
import { MOCK_URLS, isMock, mockTaskId, pollMockTask } from './mock.js';

/** Pure: the kie createTask body for an image. */
export function buildImageRequest({ prompt, refs = [], aspect, size }) {
  const cfg = PROVIDER_CONFIG.image;
  return {
    model: MODEL_IDS.image,
    input: {
      prompt: String(prompt || '').trim(),
      image_input: (Array.isArray(refs) ? refs : []).filter(Boolean).slice(0, cfg.maxRefs),
      aspect_ratio: aspect || cfg.defaultAspect,
      resolution: size || cfg.defaultSize,
      output_format: cfg.outputFormat,
    },
  };
}

export async function submitImage(args) {
  const request = buildImageRequest(args);
  if (!request.input.prompt) throw new ProviderError('failed', 'An image description is required.');
  if (isMock()) return { provider: 'mock', taskId: mockTaskId('image', args.prompt) };
  return submitKieTask(request);
}

export async function getImage({ provider, taskId }) {
  if (provider === 'mock') return pollMockTask(taskId, MOCK_URLS.still);
  if (provider !== 'kie') throw new ProviderError('failed', undefined, { cause: new Error(`provider=${provider}`) });
  const { status, url, error, transient } = await fetchKieTask(taskId);
  return transient === undefined ? { status, url, error } : { status, url, error, transient };
}
