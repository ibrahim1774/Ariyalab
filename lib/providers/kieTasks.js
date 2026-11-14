/*
 * Shared kie.ai task helpers for image.js and video.js: error wrapping for
 * the lib/kie.js client and mapping of task records / callbacks onto the
 * provider result shape { status, url, error }.
 */

import { createKieTask, getKieTask } from '../kie.js';
import { PROVIDER_CONFIG } from './config.js';
import { ProviderError, SAFE_MESSAGES, isContentRefusal, requireEnv } from './errors.js';

const PROVIDER = 'kie';

/** Runs a lib/kie.js call, mapping its plain Errors onto ProviderError. */
async function callKie(fn) {
  requireEnv(PROVIDER_CONFIG.kie.env, PROVIDER);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const code = err?.kieCode;
    if (err?.status === 429 || code === 429) throw new ProviderError('rate_limited', undefined, { cause: err, provider: PROVIDER });
    if ((code === 400 || code === 422) && isContentRefusal(err?.message)) {
      throw new ProviderError('blocked', undefined, { cause: err, provider: PROVIDER });
    }
    throw new ProviderError('failed', undefined, { cause: err, provider: PROVIDER });
  }
}

export async function submitKieTask(request) {
  const { taskId, raw } = await callKie(() => createKieTask(request));
  if (!taskId) throw new ProviderError('failed', undefined, { cause: new Error(`No taskId: ${JSON.stringify(raw)}`), provider: PROVIDER });
  return { provider: PROVIDER, taskId };
}

export async function fetchKieTask(taskId) {
  return mapKieRecord(await callKie(() => getKieTask(taskId)));
}

function firstResultUrl(resultJson) {
  if (!resultJson) return null;
  let parsed = resultJson;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return (
    (Array.isArray(parsed?.resultUrls) ? parsed.resultUrls[0] : null) ||
    parsed?.videoUrl ||
    parsed?.video_url ||
    parsed?.url ||
    null
  );
}

/**
 * Maps a kie recordInfo `data` object (also the callback `data` object).
 * -> { status: 'pending'|'done'|'failed'|'blocked', url, error, detail? }
 * `error` is customer-safe; `detail` carries kie's raw failCode/failMsg.
 */
export function mapKieRecord(record) {
  const state = String(record?.state || '').toLowerCase();
  if (state === 'success') {
    const url = firstResultUrl(record.resultJson);
    if (url) return { status: 'done', url, error: null };
    return { status: 'failed', url: null, error: SAFE_MESSAGES.failed, detail: 'success without result url' };
  }
  if (state === 'fail' || state === 'failed' || state === 'error') {
    const detail = `${record.failCode || ''} ${record.failMsg || ''}`.trim();
    if (isContentRefusal(detail)) return { status: 'blocked', url: null, error: SAFE_MESSAGES.blocked, detail };
    return { status: 'failed', url: null, error: SAFE_MESSAGES.failed, detail };
  }
  return { status: 'pending', url: null, error: null };
}

/** Parses a kie callback body (object or JSON string). -> { taskId, status, url, error } */
export function parseKieCallback(body) {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed || {};
  let mapped = mapKieRecord(data);
  if (mapped.status === 'pending' && parsed?.code && parsed.code !== 200) {
    mapped = mapKieRecord({ ...data, state: 'fail', failMsg: data.failMsg || parsed.msg });
  }
  return { taskId: data.taskId || null, status: mapped.status, url: mapped.url, error: mapped.error };
}
