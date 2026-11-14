import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { releaseHold } from '../credits.js';
import { getPricing } from '../pricing.js';
import { ProviderError, SAFE_MESSAGES } from '../providers/errors.js';
import { isMock } from '../providers/mock.js';
import { mirrorUrl } from '../providers/storage.js';
import { parseCallback } from '../providers/video.js';
import { storyDb } from './db.js';

/*
 * The job runner. Every paid or slow step (images, clips, narration, music,
 * analysis, render) is a story_jobs row that moves through
 *
 *   queued --claim--> running --submit--> running (provider task) --poll/callback--> done
 *                                                                               \-> failed | blocked
 *                        \-- sync run(job) ---------------------------------------> done | failed | blocked
 *   running --rate_limited / retryable failure (attempts < 2) / timeout--> queued (run_after later)
 *
 * Later tasks add a job kind with registerHandler(kind, handler) in a module
 * imported by lib/story/handlers.js (the runner loads that file on first use):
 *
 *   async kinds  { submit(job) -> { provider, taskId }, poll(job) -> { status, url, error }, onDone, onFail }
 *   sync kinds   { sync: true, run(job) -> result, onDone, onFail }
 *
 *   onDone(job, result)                      exactly once per job, after the job is 'done'. For media the
 *                                            result is { url, key } of OUR stored copy.
 *   onFail(job, { blocked, error, final })   once, when the job fails for good or is blocked (final: true).
 *                                            Never for a retry.
 *
 * Every transition out of 'running' is a conditional update on
 * (id, status 'running', started_at): only the caller whose update returns
 * the row acts on it, so a callback, a poll and the sweeper racing on one job
 * produce one outcome. started_at is set by each claim, so it also names the
 * try: a late result for an earlier try matches nothing.
 *
 * Credits: the runner never prices anything. When a job carries hold_id and
 * cost_credits, a final failure or block releases that share of the hold
 * (ref job:<id>, idempotent) before onFail. On success the handler's onDone
 * settles it. A retry keeps the hold.
 *
 * Times: every function takes `now` (Date, ISO string or ms) so tests drive
 * the clock; the default is the current time.
 */

export const JOB_KINDS = Object.freeze([
  'analyze', 'script', 'cast_image', 'still', 'clip', 'narration', 'music', 'voice_clone', 'render',
]);
export const SUBMITS_PER_TICK = 15; // kie allows 20 new tasks per 10 seconds
export const POLLS_PER_TICK = 20;
export const MAX_ATTEMPTS = 2; // one retry
export const RETRY_BACKOFF_SECONDS = [30, 120]; // by attempt number; with MAX_ATTEMPTS 2 only 30 s is used
export const RATE_LIMIT_DELAY_SECONDS = 10;
export const NO_HANDLER_DELAY_SECONDS = 60;
export const POLL_INTERVAL_SECONDS = 15;
export const STUCK_AFTER_MINUTES = 10;
export const SWEEP_LIMIT = 50;
const DEFAULT_RETENTION_DAYS = 30;

const ASYNC_RESULT = new Set(['pending', 'done', 'failed', 'blocked']);
const DEFAULT_EXT = {
  analyze: 'json', script: 'json', cast_image: 'png', still: 'png', clip: 'mp4',
  narration: 'mp3', music: 'mp3', voice_clone: 'mp3', render: 'mp4',
};
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'aac']);

const log = (...args) => console.error('[story-runner]', ...args);

// ------------------------------------------------------------------ handlers

const handlers = new Map();

export function registerHandler(kind, handler) {
  if (!JOB_KINDS.includes(kind)) throw new Error(`registerHandler: unknown job kind ${kind}`);
  if (!handler || typeof handler !== 'object') throw new TypeError('registerHandler: handler must be an object');
  if (handler.sync) {
    if (typeof handler.run !== 'function') throw new TypeError(`registerHandler(${kind}): a sync handler needs run(job)`);
  } else if (typeof handler.submit !== 'function' || typeof handler.poll !== 'function') {
    throw new TypeError(`registerHandler(${kind}): an async handler needs submit(job) and poll(job)`);
  }
  for (const name of ['onDone', 'onFail']) {
    if (handler[name] !== undefined && typeof handler[name] !== 'function') {
      throw new TypeError(`registerHandler(${kind}): ${name} must be a function`);
    }
  }
  handlers.set(kind, handler);
}

export function unregisterHandler(kind) {
  handlers.delete(kind);
}

/** Tests only. */
export function _resetHandlers() {
  handlers.clear();
}

let handlersLoaded = null;
// The handler modules import this file, so they are loaded lazily, once.
function loadHandlers() {
  if (!handlersLoaded) {
    handlersLoaded = import('./handlers.js').catch((err) => {
      handlersLoaded = null;
      throw err;
    });
  }
  return handlersLoaded;
}

// ------------------------------------------------------------------ helpers

function toDate(now) {
  const d = now === undefined || now === null ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError('runner: bad now');
  return d;
}
const iso = (d) => d.toISOString();
const plus = (d, seconds) => new Date(d.getTime() + seconds * 1000);
const ms = (value) => (value ? new Date(value).getTime() : NaN);

function errorCode(err) {
  const code = err?.code;
  return code === 'blocked' || code === 'failed' || code === 'rate_limited' || code === 'config' ? code : 'failed';
}

/** A message that is safe to show: ProviderError messages are; anything else becomes the generic one. */
function safeMessage(err, code = errorCode(err)) {
  if (err instanceof ProviderError && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return SAFE_MESSAGES[code] || SAFE_MESSAGES.failed;
}

const tryMatch = (job) => ({ id: job.id, status: 'running', started_at: job.started_at });

function mediaKey(job, url) {
  let ext = '';
  try {
    ext = path.extname(new URL(url, 'http://local').pathname).slice(1).toLowerCase();
  } catch {
    ext = '';
  }
  if (!MEDIA_EXT.has(ext)) ext = DEFAULT_EXT[job.kind] || 'bin';
  const owner = job.project_id || `account-${job.user_id}`;
  return `story/${owner}/${job.kind}/${job.id}.${ext}`;
}

async function retentionDays() {
  try {
    const days = (await getPricing()).retentionDays;
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/** Sets story_projects.files_expire_at the first time a file is stored for a project. */
async function noteFileStored(projectId, now) {
  if (!projectId) return;
  const days = await retentionDays();
  await storyDb().update(
    'story_projects',
    { id: projectId, files_expire_at: null },
    { files_expire_at: iso(plus(now, days * 86400)) }
  );
}

// ------------------------------------------------------------------ transitions

/** Puts a running job back in the queue. keepAttempt false gives the attempt back (rate limits). */
async function requeue(job, { now, delaySeconds, error, keepAttempt }) {
  const patch = {
    status: 'queued',
    run_after: iso(plus(now, delaySeconds)),
    provider: null,
    provider_task_id: null,
    locked_until: null,
    started_at: null,
  };
  if (!keepAttempt) patch.attempts = Math.max(0, (job.attempts || 0) - 1);
  if (error !== undefined) patch.error = error;
  const rows = await storyDb().update('story_jobs', tryMatch(job), patch);
  return rows.length > 0;
}

/** Ends a job as 'failed' or 'blocked': releases its hold share, then onFail. Once per job. */
async function finalize(job, { blocked, error }) {
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    status: blocked ? 'blocked' : 'failed',
    error,
    locked_until: null,
  });
  if (rows.length === 0) return false;
  const ended = rows[0];
  if (ended.hold_id && ended.cost_credits > 0) {
    try {
      await releaseHold({ holdId: ended.hold_id, amount: ended.cost_credits, ref: `job:${ended.id}` });
    } catch (err) {
      log(`hold release failed for job ${ended.id} (hold ${ended.hold_id}): ${err?.message || err}`);
    }
  }
  const handler = handlers.get(ended.kind);
  if (handler?.onFail) {
    try {
      await handler.onFail(ended, { blocked: Boolean(blocked), error, final: true });
    } catch (err) {
      log(`onFail threw for job ${ended.id} (${ended.kind}): ${err?.message || err}`);
    }
  }
  return true;
}

/** A retryable failure: re-queue with backoff while attempts < MAX_ATTEMPTS, else fail for good. */
async function retryOrFail(job, { now, error }) {
  if ((job.attempts || 0) < MAX_ATTEMPTS) {
    const backoff = RETRY_BACKOFF_SECONDS[Math.max(0, (job.attempts || 1) - 1)] ?? RETRY_BACKOFF_SECONDS.at(-1);
    const ok = await requeue(job, { now, delaySeconds: backoff, error, keepAttempt: true });
    return ok ? 'retried' : 'lost';
  }
  return (await finalize(job, { blocked: false, error })) ? 'failed' : 'lost';
}

/** Routes an error thrown by submit/run (or a failed result) to the right transition. */
async function handleError(job, err, now) {
  const code = errorCode(err);
  const error = safeMessage(err, code);
  if (code === 'rate_limited') {
    return (await requeue(job, { now, delaySeconds: RATE_LIMIT_DELAY_SECONDS, keepAttempt: false })) ? 'rate_limited' : 'lost';
  }
  if (code === 'blocked') return (await finalize(job, { blocked: true, error })) ? 'blocked' : 'lost';
  if (code === 'config') {
    log(`CONFIG ERROR, job ${job.id} (${job.kind}) failed without retry: ${err?.message || err}. Fix the environment and re-run the step.`);
    return (await finalize(job, { blocked: false, error: SAFE_MESSAGES.failed })) ? 'failed' : 'lost';
  }
  if (!(err instanceof ProviderError)) log(`job ${job.id} (${job.kind}) error: ${err?.stack || err?.message || err}`);
  return retryOrFail(job, { now, error });
}

/**
 * Finishes a running job with a result: mirrors media first (a deterministic
 * key, so a racing duplicate only overwrites the same object), then flips
 * running -> done; only the caller that flips runs onDone.
 */
async function complete(job, value, { now, mirrorFrom = null }) {
  let stored = value ?? {};
  if (mirrorFrom) {
    try {
      const copy = await mirrorUrl({ srcUrl: mirrorFrom, key: mediaKey(job, mirrorFrom) });
      stored = { ...stored, url: copy.url, key: copy.key };
    } catch (err) {
      log(`mirror failed for job ${job.id} (${job.kind}): ${err?.message || err}`);
      return retryOrFail(job, { now, error: 'We could not save the generated file. Please try again.' });
    }
  }
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    status: 'done',
    result: stored,
    error: null,
    locked_until: null,
  });
  if (rows.length === 0) return 'lost';
  const done = rows[0];
  if (stored && typeof stored === 'object' && stored.key) {
    try {
      await noteFileStored(done.project_id, now);
    } catch (err) {
      log(`files_expire_at update failed for project ${done.project_id}: ${err?.message || err}`);
    }
  }
  const handler = handlers.get(done.kind);
  if (handler?.onDone) {
    try {
      await handler.onDone(done, stored);
    } catch (err) {
      log(`onDone threw for job ${done.id} (${done.kind}): ${err?.stack || err?.message || err}`);
      await storyDb().update('story_jobs', { id: done.id }, { error: 'The result could not be applied. Please try again.' });
    }
  }
  return 'done';
}

/** Applies a provider status ({ status, url, error }) from a poll or callback. */
async function applyStatus(job, outcome, now) {
  const status = outcome?.status;
  if (status === 'done') {
    if (!outcome.url) return retryOrFail(job, { now, error: SAFE_MESSAGES.failed });
    return complete(job, {}, { now, mirrorFrom: outcome.url });
  }
  if (status === 'blocked') {
    return (await finalize(job, { blocked: true, error: outcome.error || SAFE_MESSAGES.blocked })) ? 'blocked' : 'lost';
  }
  if (status === 'failed') return retryOrFail(job, { now, error: outcome.error || SAFE_MESSAGES.failed });
  return 'pending';
}

// ------------------------------------------------------------------ steps

async function runClaimed(job, handler, now) {
  if (handler.sync) {
    let value;
    try {
      value = await handler.run(job);
    } catch (err) {
      return handleError(job, err, now);
    }
    // A result with a provider url and no key of ours is media to copy; one with a key is already stored.
    const isObject = value !== null && typeof value === 'object';
    const mirrorFrom = isObject && value.url && !value.key ? value.url : null;
    return complete(job, value, { now, mirrorFrom });
  }
  let task;
  try {
    task = await handler.submit(job);
  } catch (err) {
    return handleError(job, err, now);
  }
  if (!task || !task.provider || !task.taskId) {
    log(`submit for job ${job.id} (${job.kind}) returned no provider task`);
    return retryOrFail(job, { now, error: SAFE_MESSAGES.failed });
  }
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    provider: String(task.provider),
    provider_task_id: String(task.taskId),
    locked_until: iso(plus(now, POLL_INTERVAL_SECONDS)),
  });
  return rows.length ? 'submitted' : 'lost';
}

async function pollOnce(job, handler, now) {
  let outcome;
  try {
    outcome = await handler.poll(job);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'blocked' || code === 'config') return handleError(job, err, now);
    // Network trouble or a rate limit while asking: try again later; the sweeper ends a job that never answers.
    if (!(err instanceof ProviderError)) log(`poll for job ${job.id} (${job.kind}) threw: ${err?.message || err}`);
    outcome = { status: 'pending' };
  }
  if (!ASYNC_RESULT.has(outcome?.status)) {
    log(`poll for job ${job.id} (${job.kind}) returned an unknown status ${outcome?.status}`);
    outcome = { status: 'pending' };
  }
  return { outcome, result: outcome.status === 'pending' ? 'pending' : await applyStatus(job, outcome, now) };
}

function tally(summary, result) {
  if (result === 'done') summary.done += 1;
  else if (result === 'failed' || result === 'blocked') summary.failed += 1;
  else if (result === 'retried' || result === 'rate_limited') summary.retried += 1;
}

// ------------------------------------------------------------------ public API

/**
 * Adds a job. -> the story_jobs row.
 * userId is taken from the project; pass it for account-level jobs (no projectId).
 * holdId + costCredits: the hold share this job releases if it fails for good.
 */
export async function enqueue({ projectId = null, shotId = null, kind, payload = {}, userId, holdId = null, costCredits = null, runAfter = null }) {
  if (!JOB_KINDS.includes(kind)) throw new Error(`enqueue: unknown job kind ${kind}`);
  let owner = userId || null;
  if (projectId) {
    const [project] = await storyDb().select('story_projects', { id: projectId }, { columns: ['id', 'user_id'], limit: 1 });
    if (!project) throw new Error(`enqueue: project ${projectId} not found`);
    if (owner && owner !== project.user_id) throw new Error('enqueue: userId does not own the project');
    owner = project.user_id;
  }
  if (!owner) throw new Error('enqueue: userId is required for a job without a project');
  if (costCredits !== null && (!Number.isInteger(costCredits) || costCredits < 0)) {
    throw new TypeError('enqueue: costCredits must be a non-negative integer');
  }
  const [job] = await storyDb().insert('story_jobs', {
    project_id: projectId,
    user_id: owner,
    shot_id: shotId,
    kind,
    payload: payload ?? {},
    hold_id: holdId,
    cost_credits: costCredits,
    run_after: runAfter ? iso(toDate(runAfter)) : null,
  });
  return job;
}

/**
 * Queued and running jobs of a project (null: the account-level jobs), oldest first.
 * Full rows (payload, provider_task_id, hold_id, cost_credits included): a
 * route must project to the story_jobs_public columns before returning them.
 */
export async function activeJobs(projectId) {
  return storyDb().select(
    'story_jobs',
    { project_id: projectId ?? null, status: ['queued', 'running'] },
    { order: ['created_at', 'id'] }
  );
}

/**
 * One pass for a project: claim due jobs (at most `limit`, and at most the
 * shared submit budget, default 15), submit or run them, then poll running
 * jobs whose locked_until passed (at most 20). Safe to call concurrently.
 * `budget` ({ submits }) lets the cron share one throttle across projects.
 * -> { claimed, submitted, polled, done, failed, retried }
 */
export async function tick({ projectId = null, limit = SUBMITS_PER_TICK, now, budget } = {}) {
  await loadHandlers();
  const at = toDate(now);
  const pool = budget || { submits: SUBMITS_PER_TICK };
  const summary = { claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 };
  const db = storyDb();

  const claimLimit = Math.max(0, Math.min(Number.isInteger(limit) ? limit : SUBMITS_PER_TICK, pool.submits));
  if (claimLimit > 0) {
    const claimed = await db.rpc('story_claim_jobs', { p_project: projectId ?? null, p_limit: claimLimit, p_now: iso(at) });
    pool.submits -= claimed.length;
    summary.claimed = claimed.length;
    let rateLimited = false;
    for (const job of claimed) {
      if (rateLimited) {
        // The provider is busy: give the rest of the batch its attempt back and try again shortly.
        if (await requeue(job, { now: at, delaySeconds: RATE_LIMIT_DELAY_SECONDS, keepAttempt: false })) summary.retried += 1;
        continue;
      }
      const handler = handlers.get(job.kind);
      if (!handler) {
        log(`no handler registered for job kind ${job.kind} (job ${job.id}); re-queued`);
        await requeue(job, { now: at, delaySeconds: NO_HANDLER_DELAY_SECONDS, keepAttempt: false });
        continue;
      }
      const result = await runClaimed(job, handler, at);
      if (result === 'rate_limited') rateLimited = true;
      // A sync run that was not turned away counts as a submission too.
      else if (result === 'submitted' || handler.sync) summary.submitted += 1;
      tally(summary, result);
    }
  }

  const running = await db.select('story_jobs', { project_id: projectId ?? null, status: 'running' }, { order: ['locked_until', 'id'] });
  const due = running
    .filter((j) => j.provider_task_id && handlers.get(j.kind) && !handlers.get(j.kind).sync)
    .filter((j) => !(ms(j.locked_until) > at.getTime()))
    .slice(0, POLLS_PER_TICK);
  const polls = await Promise.all(due.map(async (job) => {
    const { result } = await pollOnce(job, handlers.get(job.kind), at);
    if (result === 'pending') {
      await db.update('story_jobs', tryMatch(job), { locked_until: iso(plus(at, POLL_INTERVAL_SECONDS)) });
    }
    return result;
  }));
  summary.polled = due.length;
  for (const result of polls) tally(summary, result);
  return summary;
}

function sameSecret(a, b) {
  const da = createHash('sha256').update(String(a)).digest();
  const db = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(da, db);
}

/** True when the callback token matches KIE_WEBHOOK_SECRET. Unset secret: accepted only in mock mode. */
export function verifyCallbackToken(token) {
  const secret = process.env.KIE_WEBHOOK_SECRET;
  if (!secret) return isMock();
  if (typeof token !== 'string' || token === '') return false;
  return sameSecret(token, secret);
}

/**
 * A provider webhook. -> { ok, reason?, jobId?, outcome? }
 * ok false only for a bad token. Unknown tasks, finished jobs and pending
 * updates are ignored (ok true, no side effects).
 */
export async function handleProviderCallback(provider, body, { token, now } = {}) {
  if (!verifyCallbackToken(token)) return { ok: false, reason: 'unauthorized' };
  await loadHandlers();
  const at = toDate(now);
  let parsed;
  try {
    parsed = parseCallback(provider, body);
  } catch (err) {
    log(`callback from ${provider} could not be parsed: ${err?.message || err}`);
    return { ok: true, ignored: true };
  }
  if (!parsed?.taskId) return { ok: true, ignored: true };
  const [job] = await storyDb().select(
    'story_jobs',
    { provider: String(provider), provider_task_id: String(parsed.taskId) },
    { limit: 1 }
  );
  if (!job || job.status !== 'running' || !ASYNC_RESULT.has(parsed.status) || parsed.status === 'pending') {
    return { ok: true, ignored: true };
  }
  const outcome = await applyStatus(job, parsed, at);
  return { ok: true, jobId: job.id, outcome };
}

/**
 * Ends jobs that have been running for more than 10 minutes. An async job is
 * polled once first so a finished result is not dropped; otherwise it is
 * failed and re-queued while attempts < 2, else failed for good (releasing
 * its hold share). -> { swept, done, retried, failed }
 */
export async function sweep({ now } = {}) {
  await loadHandlers();
  const at = toDate(now);
  const cutoff = at.getTime() - STUCK_AFTER_MINUTES * 60_000;
  const running = await storyDb().select('story_jobs', { status: 'running' }, { order: ['started_at', 'id'] });
  const stuck = running
    .filter((j) => (ms(j.started_at || j.created_at)) <= cutoff)
    .slice(0, SWEEP_LIMIT);
  const summary = { swept: stuck.length, done: 0, retried: 0, failed: 0 };
  for (const job of stuck) {
    const handler = handlers.get(job.kind);
    let result = null;
    if (handler && !handler.sync && job.provider_task_id) {
      const polled = await pollOnce(job, handler, at);
      if (polled.result !== 'pending') result = polled.result;
    }
    if (result === null) {
      result = await retryOrFail(job, { now: at, error: 'This took too long. Please try again.' });
    }
    tally(summary, result);
  }
  return summary;
}

/**
 * The kie webhook URL with the token, for handlers to pass as callbackUrl.
 * null when APP_URL or KIE_WEBHOOK_SECRET is unset (the runner polls instead).
 */
export function callbackUrl() {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const secret = process.env.KIE_WEBHOOK_SECRET;
  if (!base || !secret) return null;
  return `${base}/api/webhooks/kie?token=${encodeURIComponent(secret)}`;
}
