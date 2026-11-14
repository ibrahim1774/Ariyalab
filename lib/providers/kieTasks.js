/*
 * Shared kie.ai task helpers for image.js and video.js: the story pipeline's
 * kie calls (endpoint, paths and timeout from PROVIDER_CONFIG.kie) and the
 * mapping of task records / callbacks onto { status, url, error }.
 *
 * lib/kie.js keeps its own client for the legacy tools; only its pure
 * helpers (buildKlingInput, kieResultUrl) are shared.
 */

import { kieResultUrl } from '../kie.js';
import { PROVIDER_CONFIG } from './config.js';
import { ProviderError, SAFE_MESSAGES, isContentRefusal, requireEnv, toProviderError } from './errors.js';

const PROVIDER = 'kie';

/** One kie API call. kie reports errors inside HTTP 200 bodies via `code`. */
async function kieCall(pathAndQuery, { method = 'GET', body, submit = false } = {}) {
  const cfg = PROVIDER_CONFIG.kie;
  const key = requireEnv(cfg.env, PROVIDER);
  let res;
  let text;
  try {
    res = await fetch(`${cfg.baseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw toProviderError(err, PROVIDER);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { code: res.status, msg: text.slice(0, 500) };
  }
  const code = res.status === 429 ? 429 : data?.code;
  if (res.ok && code === 200) return data.data;
  const cause = { status: res.status, code, message: String(data?.msg || '').slice(0, 1000) };
  // On createTask, a server-side HTTP error does not prove that no task was made, whatever
  // its body says: checked before the rate-limit and refusal branches (a refused request
  // may be re-submitted; this one never is).
  if (submit && res.status >= 500) {
    const err = new ProviderError('failed', undefined, { cause, provider: PROVIDER });
    err.ambiguous = true;
    throw err;
  }
  if (code === 429) throw new ProviderError('rate_limited', undefined, { cause, provider: PROVIDER });
  if ((code === 400 || code === 422) && isContentRefusal(data?.msg)) {
    throw new ProviderError('blocked', undefined, { cause, provider: PROVIDER });
  }
  const err = new ProviderError('failed', undefined, { cause, provider: PROVIDER });
  // On createTask, a server-side body code does not prove that no task was made either.
  if (submit && Number(code) >= 500) err.ambiguous = true;
  throw err;
}

/** request = { model, input, callBackUrl? } -> { provider: 'kie', taskId } */
export async function submitKieTask({ model, input, callBackUrl }) {
  const data = await kieCall(PROVIDER_CONFIG.kie.createPath, {
    method: 'POST',
    body: { model, ...(callBackUrl ? { callBackUrl } : {}), input },
    submit: true,
  });
  if (!data?.taskId) {
    // An accepted answer without a task id (or an unparsable one): a task may exist.
    const err = new ProviderError('failed', undefined, { cause: { message: `No taskId: ${JSON.stringify(data)}` }, provider: PROVIDER });
    err.ambiguous = true;
    throw err;
  }
  return { provider: PROVIDER, taskId: data.taskId };
}

export async function fetchKieTask(taskId) {
  const data = await kieCall(`${PROVIDER_CONFIG.kie.recordPath}?taskId=${encodeURIComponent(taskId)}`);
  return mapKieRecord(data);
}

/**
 * Maps a kie recordInfo `data` object (also the callback `data` object).
 * -> { status: 'pending'|'done'|'failed'|'blocked', url, error, detail? }
 * `error` is customer-safe; `detail` carries kie's raw failCode/failMsg.
 */
export function mapKieRecord(record) {
  const state = String(record?.state || '').toLowerCase();
  if (state === 'success') {
    const url = kieResultUrl(record.resultJson);
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
