import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { HoldClosedError, HoldExceededError, releaseHold } from '../credits.js';
import { getPricing } from '../pricing.js';
import { ProviderError, SAFE_MESSAGES } from '../providers/errors.js';
import { isMock } from '../providers/mock.js';
import { mirrorUrl } from '../providers/storage.js';
import { parseCallback } from '../providers/video.js';
import { storyDb } from './db.js';

/*
 * The job runner. Every paid or slow step is a story_jobs row; see the
 * "Runner reference" in .superpowers/sdd/2026-11-14-story-video-maker/
 * task-12-report.md for the full contract. In short:
 *
 *   queued --claim--> running --submit--> running + provider_task_id --poll--> done
 *                        |                                              \--> failed | blocked
 *                        \-- sync run(job) (cron / worker route) ---------> done | failed | blocked
 *
 * - Every transition out of 'running' is a conditional update on
 *   (id, status 'running', started_at). Only the caller that gets the row
 *   back acts on it. started_at changes with every claim, so it names the try.
 * - A job holding a provider task id is never submitted again automatically.
 *   A slow task gets more time up to a per-kind cap, then fails. A failed copy
 *   into our storage retries the copy only. An unknown submit outcome fails.
 *   Only an explicit 'failed' from the provider re-queues (attempts < 2).
 * - Polls take a lease (locked_until) first, so overlapping callers never
 *   poll or mirror the same job twice. At most 4 mirrors run at once per instance.
 * - Side effects run at least once. A finished row has applied_at = null
 *   until onDone (or the hold release and onFail) has returned. The sweeper
 *   re-runs whatever is unapplied once its lease is over, so handlers must be
 *   idempotent.
 * - Webhooks only nudge: they set locked_until = now, and the next tick polls
 *   the provider under our key. The callback body is never trusted.
 *
 * Times: every function takes `now` (Date, ISO string or ms; default the
 * current time) for job timestamps, and an optional `deadline` (epoch ms,
 * compared with the real clock) to stop starting new work.
 */

export const JOB_KINDS = Object.freeze([
  'analyze', 'script', 'cast_image', 'still', 'clip', 'narration', 'music', 'voice_clone', 'render',
]);
export const ASYNC_KINDS = Object.freeze(['cast_image', 'still', 'clip']);
export const SYNC_KINDS = Object.freeze(['analyze', 'script', 'narration', 'music', 'voice_clone', 'render']);
/** Sync kinds that tick never runs; only their worker route does, through runWorkerJob. */
export const WORKER_KINDS = Object.freeze(['render']);

export const RUNNER_CONFIG = Object.freeze({
  submitsPerTick: 15, // kie allows 20 new tasks per 10 seconds
  claimsPerTick: 15,
  claimsPerProjectPerPass: 3, // cron round-robin
  pollsPerTick: 20,
  mirrorConcurrency: 4,
  maxAttempts: 2, // one retry after an explicit provider failure
  retryBackoffSeconds: 30,
  rateLimitDelaySeconds: 10,
  rateLimitGiveUpMinutes: 30,
  noHandlerDelaySeconds: 300,
  noHandlerMaxRounds: 5,
  pollIntervalSeconds: 15,
  pollLeaseSeconds: 60,
  pollErrorLimit: 2, // provider errors in a row before a poll counts as a failure
  syncStuckMinutes: 10,
  taskHardCapMinutes: Object.freeze({ clip: 45, cast_image: 15, still: 15 }),
  mirrorMaxTries: 4,
  mirrorBackoffSeconds: Object.freeze([30, 60, 120]),
  applyLeaseSeconds: 60,
  applyMaxTries: 5,
  applyBackoffSeconds: 60, // times the try number
  taskIdWriteTries: 3,
  sweepLimit: 50,
  // What lib/providers/storage.js accepts as media, by kind class (first = default).
  mediaExtensions: Object.freeze({
    image: Object.freeze(['png', 'jpg', 'webp']),
    video: Object.freeze(['mp4']),
    audio: Object.freeze(['mp3', 'm4a', 'wav']),
  }),
});
const C = RUNNER_CONFIG;
const DEFAULT_RETENTION_DAYS = 30;
const MEDIA_CLASS = {
  cast_image: 'image', still: 'image', clip: 'video', render: 'video',
  narration: 'audio', music: 'audio', voice_clone: 'audio', analyze: 'video', script: 'video',
};
const PUBLIC_COLUMNS = ['id', 'project_id', 'shot_id', 'kind', 'status', 'error', 'created_at', 'updated_at'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASYNC_RESULT = new Set(['pending', 'done', 'failed', 'blocked']);

// storage.js messages for files it will never accept (retrying cannot help).
const PERMANENT_MIRROR = new Set(['That file type cannot be stored.', "That file's contents don't match its type."]);
const WRONG_CONTENT = "That file's contents don't match its type.";

const MSG = {
  slow: 'This took too long. Please try again.',
  unknownSubmit: 'We could not confirm the request was received. Please try again.',
  store: 'We could not save the generated file. Please try again.',
  apply: 'The result could not be applied. Please try again.',
  noHandler: 'This step is not available right now. Please try again later.',
};

const log = (...args) => console.error('[story-runner]', ...args);
const warn = (...args) => console.warn('[story-runner]', ...args);

// ------------------------------------------------------------------ handlers

const handlers = new Map();
const baseline = new Map(); // what lib/story/handlers.js registered
let importingHandlers = false;

export function registerHandler(kind, handler) {
  if (!JOB_KINDS.includes(kind)) throw new Error(`registerHandler: unknown job kind ${kind}`);
  if (!handler || typeof handler !== 'object') throw new TypeError('registerHandler: handler must be an object');
  if (SYNC_KINDS.includes(kind)) {
    if (!handler.sync) throw new TypeError(`registerHandler(${kind}): ${kind} is a sync kind; pass sync: true and run(job)`);
    if (typeof handler.run !== 'function') throw new TypeError(`registerHandler(${kind}): a sync handler needs run(job)`);
  } else {
    if (handler.sync) throw new TypeError(`registerHandler(${kind}): ${kind} is an async kind; pass submit(job) and poll(job)`);
    if (typeof handler.submit !== 'function' || typeof handler.poll !== 'function') {
      throw new TypeError(`registerHandler(${kind}): an async handler needs submit(job) and poll(job)`);
    }
  }
  for (const name of ['onDone', 'onFail']) {
    if (handler[name] !== undefined && typeof handler[name] !== 'function') {
      throw new TypeError(`registerHandler(${kind}): ${name} must be a function`);
    }
  }
  handlers.set(kind, handler);
  if (importingHandlers) baseline.set(kind, handler);
}

export function unregisterHandler(kind) {
  handlers.delete(kind);
}

export function registeredKinds() {
  return [...handlers.keys()];
}

/** Tests: back to the handlers lib/story/handlers.js registered. */
export function _resetHandlers() {
  handlers.clear();
  for (const [k, h] of baseline) handlers.set(k, h);
}

let handlersLoaded = null;
// The handler modules import this file, so they are loaded lazily, once.
function loadHandlers() {
  if (!handlersLoaded) {
    importingHandlers = true;
    handlersLoaded = import('./handlers.js')
      .finally(() => { importingHandlers = false; })
      .catch((err) => {
        handlersLoaded = null;
        throw err;
      });
  }
  return handlersLoaded;
}

// ------------------------------------------------------------------ small helpers

function toDate(now) {
  const d = now === undefined || now === null ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError('runner: bad now');
  return d;
}
const iso = (d) => d.toISOString();
const plus = (d, seconds) => new Date(d.getTime() + seconds * 1000);
const ms = (value) => (value ? new Date(value).getTime() : NaN);
const pastDeadline = (deadline) => deadline !== undefined && deadline !== null && Date.now() >= deadline;

function errorCode(err) {
  const code = err?.code;
  return code === 'blocked' || code === 'failed' || code === 'rate_limited' || code === 'config' ? code : 'failed';
}

function safeMessage(err, code = errorCode(err)) {
  if (err instanceof ProviderError && err.message) return err.message;
  return SAFE_MESSAGES[code] || SAFE_MESSAGES.failed;
}

/** A transport error whose request may already have reached the provider. */
function isAmbiguous(err) {
  if (err?.ambiguous === true) return true;
  const c = err?.cause;
  const names = [err?.name, c?.name, c?.cause?.name];
  if (names.includes('TimeoutError') || names.includes('AbortError')) return true;
  const codes = [c?.code, c?.cause?.code];
  return codes.some((x) => x === 'ECONNRESET' || x === 'UND_ERR_SOCKET' || x === 'EPIPE');
}

/** A thrown poll error from a provider that answered (not a network failure). */
function isProviderAnswer(err) {
  if (!(err instanceof ProviderError)) return false;
  const c = err.cause;
  if (!c || c instanceof TypeError || isAmbiguous(err)) return false;
  return c.status !== undefined || c.code !== undefined;
}

const tryMatch = (job) => ({ id: job.id, status: 'running', started_at: iso(new Date(job.started_at)) });

function sameBytes(a, b) {
  const da = createHash('sha256').update(String(a)).digest();
  const db = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(da, db);
}

/** A tiny per-instance semaphore. */
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
const mirrorSlot = limiter(C.mirrorConcurrency);

function extCandidates(job, url) {
  const allowed = C.mediaExtensions[MEDIA_CLASS[job.kind] || 'video'];
  let ext = '';
  try {
    ext = path.extname(new URL(url, 'http://local').pathname).slice(1).toLowerCase();
  } catch {
    ext = '';
  }
  if (ext === 'jpeg') ext = 'jpg';
  return allowed.includes(ext) ? [ext, ...allowed.filter((e) => e !== ext)] : [...allowed];
}

function keyFor(job, ext) {
  const owner = job.project_id || `account-${job.user_id}`;
  return `story/${owner}/${job.kind}/${job.id}.${ext}`;
}

/** Copies a provider URL into our storage, trying each allowed extension when the bytes don't match. */
async function mirrorInto(job, url) {
  return mirrorSlot(async () => {
    let last;
    for (const ext of extCandidates(job, url)) {
      try {
        return await mirrorUrl({ srcUrl: url, key: keyFor(job, ext) });
      } catch (err) {
        last = err;
        if (err?.message !== WRONG_CONTENT) throw err;
      }
    }
    throw last;
  });
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

// ------------------------------------------------------------------ transitions out of 'running'

const RESET_TRY = {
  provider: null,
  provider_task_id: null,
  locked_until: null,
  started_at: null,
  submitted_at: null,
  mirror_tries: 0,
  poll_errors: 0,
};

/** Back to the queue. giveBack: return the attempt (nothing was paid for). */
async function requeue(job, { now, delaySeconds, error, giveBack, extra = {} }) {
  const patch = { ...RESET_TRY, status: 'queued', run_after: iso(plus(now, delaySeconds)), ...extra };
  if (giveBack) patch.attempts = Math.max(0, (job.attempts || 0) - 1);
  if (error !== undefined) patch.error = error;
  const rows = await storyDb().update('story_jobs', tryMatch(job), patch);
  return rows.length > 0;
}

/** Ends a running job as failed or blocked, then applies the failure (release + onFail). */
async function finalize(job, { blocked, error, now }) {
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    status: blocked ? 'blocked' : 'failed',
    error,
    locked_until: iso(plus(now, C.applyLeaseSeconds)),
    applied_at: null,
  });
  if (rows.length === 0) return 'lost';
  await applyFailure(rows[0], now);
  return blocked ? 'blocked' : 'failed';
}

/** An explicit failure: re-queue with backoff while attempts < maxAttempts, else fail for good. */
async function retryOrFail(job, { now, error }) {
  if ((job.attempts || 0) < C.maxAttempts) {
    return (await requeue(job, { now, delaySeconds: C.retryBackoffSeconds, error, giveBack: false })) ? 'retried' : 'lost';
  }
  return finalize(job, { blocked: false, error, now });
}

/** A rate limit: wait 10 s without using an attempt, until it has lasted 30 minutes. */
async function rateLimited(job, now) {
  const since = job.rate_limited_since ? new Date(job.rate_limited_since) : now;
  if (now.getTime() - since.getTime() > C.rateLimitGiveUpMinutes * 60_000) {
    log(`job ${job.id} (${job.kind}) gave up after ${C.rateLimitGiveUpMinutes} minutes of rate limits`);
    return finalize(job, { blocked: false, error: SAFE_MESSAGES.rate_limited, now });
  }
  const ok = await requeue(job, {
    now, delaySeconds: C.rateLimitDelaySeconds, giveBack: true, extra: { rate_limited_since: iso(since) },
  });
  return ok ? 'rate_limited' : 'lost';
}

/** Maps an error thrown by submit or run to a transition. */
async function handleError(job, err, now, { paidAsync = false } = {}) {
  const code = errorCode(err);
  if (code === 'rate_limited') return rateLimited(job, now);
  if (code === 'blocked') return finalize(job, { blocked: true, error: safeMessage(err, code), now });
  if (code === 'config') {
    log(`CONFIG ERROR, job ${job.id} (${job.kind}) failed without retry: ${err?.message || err}. Fix the environment and re-run the step.`);
    return finalize(job, { blocked: false, error: SAFE_MESSAGES.failed, now });
  }
  if (paidAsync && isAmbiguous(err)) {
    log(`job ${job.id} (${job.kind}): submit outcome unknown (${err?.cause?.name || err?.name}); failed instead of submitting twice`);
    return finalize(job, { blocked: false, error: MSG.unknownSubmit, now });
  }
  if (!(err instanceof ProviderError)) log(`job ${job.id} (${job.kind}) error: ${err?.stack || err?.message || err}`);
  return retryOrFail(job, { now, error: safeMessage(err, code) });
}

/** running -> done with the stored result, then applies it (onDone). */
async function markDone(job, stored, now) {
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    status: 'done',
    result: stored,
    error: null,
    locked_until: iso(plus(now, C.applyLeaseSeconds)),
    applied_at: null,
  });
  if (rows.length === 0) return 'lost';
  await applyDone(rows[0], now);
  return 'done';
}

/** A finished provider task: copy the file into our storage, then mark done. */
async function completeAsync(job, url, now) {
  if (!url) return retryOrFail(job, { now, error: SAFE_MESSAGES.failed });
  let copy;
  try {
    copy = await mirrorInto(job, url);
  } catch (err) {
    return mirrorFailed(job, err, now);
  }
  return markDone(job, { url: copy.url, key: copy.key }, now);
}

/** Keeps the task id; tries the copy again later, or fails for good (never re-submits). */
async function mirrorFailed(job, err, now) {
  const tries = (job.mirror_tries || 0) + 1;
  const permanent = PERMANENT_MIRROR.has(err?.message);
  log(`mirror failed for job ${job.id} (${job.kind}), try ${tries}${permanent ? ' (permanent)' : ''}: ${err?.message || err}`);
  if (permanent || tries >= C.mirrorMaxTries) {
    await storyDb().update('story_jobs', tryMatch(job), { mirror_tries: tries });
    return finalize(job, { blocked: false, error: MSG.store, now });
  }
  const backoff = C.mirrorBackoffSeconds[Math.min(tries - 1, C.mirrorBackoffSeconds.length - 1)];
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    mirror_tries: tries,
    locked_until: iso(plus(now, backoff)),
  });
  return rows.length ? 'pending' : 'lost';
}

// ------------------------------------------------------------------ applying side effects

async function markApplied(row, now) {
  await storyDb().update('story_jobs', { id: row.id, status: row.status, applied_at: null }, {
    applied_at: iso(now),
    locked_until: null,
  });
}

/** A side effect threw: count it and leave the row for the sweeper (or give up). */
async function applyFailed(row, now, err, what) {
  const tries = (row.apply_tries || 0) + 1;
  log(`${what} failed for job ${row.id} (${row.kind}), try ${tries}: ${err?.stack || err?.message || err}`);
  const rows = await storyDb().update('story_jobs', { id: row.id, status: row.status, applied_at: null }, {
    apply_tries: tries,
    locked_until: iso(plus(now, C.applyBackoffSeconds * tries)),
  });
  return { tries, row: rows[0] };
}

async function applyDone(row, now) {
  const result = row.result;
  if (result && typeof result === 'object' && result.key) {
    try {
      await noteFileStored(row.project_id, now);
    } catch (err) {
      log(`files_expire_at update failed for project ${row.project_id}: ${err?.message || err}`);
    }
  }
  const handler = handlers.get(row.kind);
  try {
    if (!handler) throw new Error(`no handler registered for ${row.kind}`);
    if (handler.onDone) await handler.onDone(row, result);
  } catch (err) {
    const { tries, row: updated } = await applyFailed(row, now, err, 'onDone');
    if (tries >= C.applyMaxTries && updated) {
      // The result cannot be used: treat the job as failed (release its hold share, onFail).
      const rows = await storyDb().update('story_jobs', { id: row.id, status: 'done', applied_at: null }, {
        status: 'failed',
        error: MSG.apply,
        apply_tries: 0,
        locked_until: iso(plus(now, C.applyLeaseSeconds)),
      });
      if (rows[0]) await applyFailure(rows[0], now);
    }
    return;
  }
  await markApplied(row, now);
}

async function applyFailure(row, now) {
  if (row.hold_id && row.cost_credits > 0) {
    try {
      await releaseHold({ holdId: row.hold_id, amount: row.cost_credits, ref: `job:${row.id}` });
    } catch (err) {
      const terminal = err instanceof HoldClosedError || err instanceof HoldExceededError || /hold_not_found/.test(err?.message || '');
      if (!terminal) {
        const { tries } = await applyFailed(row, now, err, 'hold release');
        if (tries < C.applyMaxTries) return;
        log(`OPERATOR: hold ${row.hold_id} share ${row.cost_credits} for job ${row.id} was not released after ${tries} tries; release it by hand`);
      } else {
        log(`hold ${row.hold_id} for job ${row.id} needs no release (${err?.message || err})`);
      }
    }
  }
  const handler = handlers.get(row.kind);
  if (handler?.onFail) {
    try {
      await handler.onFail(row, { blocked: row.status === 'blocked', error: row.error, final: true });
    } catch (err) {
      const { tries } = await applyFailed(row, now, err, 'onFail');
      if (tries < C.applyMaxTries) return;
      log(`OPERATOR: onFail for job ${row.id} (${row.kind}) kept failing; marked applied`);
    }
  }
  await markApplied(row, now);
}

// ------------------------------------------------------------------ steps

async function writeTaskId(job, task, now) {
  let lastErr;
  for (let i = 0; i < C.taskIdWriteTries; i++) {
    try {
      const rows = await storyDb().update('story_jobs', tryMatch(job), {
        provider: String(task.provider),
        provider_task_id: String(task.taskId),
        locked_until: iso(plus(now, C.pollIntervalSeconds)),
        rate_limited_since: null,
      });
      return rows.length ? 'submitted' : 'lost';
    } catch (err) {
      lastErr = err;
    }
  }
  log(`ORPHAN TASK: job ${job.id} (${job.kind}) got ${task.provider} task ${task.taskId} but it could not be stored: ${lastErr?.message || lastErr}`);
  throw lastErr;
}

async function submitAsync(job, handler, now) {
  // Marked before the call: a crash after this leaves "submitted, outcome unknown", which is never re-submitted.
  const marked = await storyDb().update('story_jobs', tryMatch(job), { submitted_at: iso(now) });
  if (!marked.length) return 'lost';
  let task;
  try {
    task = await handler.submit(job);
  } catch (err) {
    return handleError(job, err, now, { paidAsync: true });
  }
  if (!task || !task.provider || !task.taskId) {
    log(`submit for job ${job.id} (${job.kind}) returned no provider task`);
    return finalize(job, { blocked: false, error: MSG.unknownSubmit, now });
  }
  return writeTaskId(job, task, now);
}

async function runSyncJob(job, handler, now) {
  let value;
  try {
    value = await handler.run(job);
  } catch (err) {
    return handleError(job, err, now);
  }
  const isObject = value !== null && typeof value === 'object';
  // A result with a provider url and no key of ours is media to copy; one with a key is already stored.
  if (isObject && value.url && !value.key) {
    let copy;
    try {
      copy = await mirrorInto(job, value.url);
    } catch (err) {
      log(`mirror failed for sync job ${job.id} (${job.kind}): ${err?.message || err}`);
      if (PERMANENT_MIRROR.has(err?.message)) return finalize(job, { blocked: false, error: MSG.store, now });
      return retryOrFail(job, { now, error: MSG.store });
    }
    return markDone(job, { ...value, url: copy.url, key: copy.key }, now);
  }
  return markDone(job, value ?? {}, now);
}

async function noHandler(job, now) {
  const rounds = (job.no_handler_rounds || 0) + 1;
  log(`no handler registered for job kind ${job.kind} (job ${job.id}), round ${rounds}`);
  if (rounds >= C.noHandlerMaxRounds) {
    await storyDb().update('story_jobs', tryMatch(job), { no_handler_rounds: rounds });
    return finalize(job, { blocked: false, error: MSG.noHandler, now });
  }
  const ok = await requeue(job, { now, delaySeconds: C.noHandlerDelaySeconds, giveBack: true, extra: { no_handler_rounds: rounds } });
  return ok ? 'skipped' : 'lost';
}

/** Takes the poll lease; true when this caller may poll. */
async function takeLease(job, now, seconds) {
  const rows = await storyDb().update(
    'story_jobs',
    { ...tryMatch(job), locked_until: job.locked_until ? iso(new Date(job.locked_until)) : null },
    { locked_until: iso(plus(now, seconds)) }
  );
  return rows.length > 0 ? rows[0] : null;
}

function overCap(job, now) {
  const cap = C.taskHardCapMinutes[job.kind];
  const start = ms(job.submitted_at || job.started_at);
  return cap !== undefined && Number.isFinite(start) && now.getTime() - start >= cap * 60_000;
}

/** One poll of a leased job. -> 'pending' | 'done' | 'retried' | 'failed' | 'blocked' | 'lost' */
async function pollJob(job, handler, now) {
  let outcome;
  let providerError = false;
  try {
    outcome = await handler.poll(job);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'blocked' || code === 'config') return handleError(job, err, now);
    if (isProviderAnswer(err)) {
      const errors = (job.poll_errors || 0) + 1;
      if (errors >= C.pollErrorLimit) return retryOrFail(job, { now, error: safeMessage(err) });
      providerError = true;
      job = { ...job, poll_errors: errors };
    } else if (!(err instanceof ProviderError)) {
      log(`poll for job ${job.id} (${job.kind}) threw: ${err?.message || err}`);
    }
    outcome = { status: 'pending' };
  }
  if (!ASYNC_RESULT.has(outcome?.status)) {
    log(`poll for job ${job.id} (${job.kind}) returned an unknown status ${outcome?.status}`);
    outcome = { status: 'pending' };
  }
  if (outcome.status === 'done') return completeAsync(job, outcome.url, now);
  if (outcome.status === 'blocked') return finalize(job, { blocked: true, error: outcome.error || SAFE_MESSAGES.blocked, now });
  if (outcome.status === 'failed') return retryOrFail(job, { now, error: outcome.error || SAFE_MESSAGES.failed });

  if (overCap(job, now)) {
    log(`job ${job.id} (${job.kind}) passed its ${C.taskHardCapMinutes[job.kind]} minute cap; failed without submitting again`);
    return finalize(job, { blocked: false, error: MSG.slow, now });
  }
  // A real answer resets the error count; a provider error keeps it.
  await storyDb().update('story_jobs', tryMatch(job), {
    locked_until: iso(plus(now, C.pollIntervalSeconds)),
    poll_errors: providerError ? job.poll_errors : 0,
  });
  return 'pending';
}

function tally(summary, result) {
  if (result === 'done') summary.done += 1;
  else if (result === 'failed' || result === 'blocked') summary.failed += 1;
  else if (result === 'retried' || result === 'rate_limited') summary.retried += 1;
}

async function claimOne({ projectId, now, kinds, skipKinds, anyProject = false }) {
  const params = { p_project: projectId ?? null, p_limit: 1, p_now: iso(now) };
  if (kinds) params.p_kinds = kinds;
  if (skipKinds && skipKinds.length) params.p_skip_kinds = skipKinds;
  if (anyProject) params.p_any_project = true;
  const rows = await storyDb().rpc('story_claim_jobs', params);
  return rows[0] || null;
}

// ------------------------------------------------------------------ public API

/**
 * Adds a job. -> the story_jobs row.
 * userId is taken from the project; pass it for account-level jobs (no projectId).
 * holdId and costCredits go together: the hold share this job releases if it fails for good.
 */
export async function enqueue({ projectId = null, shotId = null, kind, payload = {}, userId, holdId = null, costCredits = null, runAfter = null }) {
  if (!JOB_KINDS.includes(kind)) throw new Error(`enqueue: unknown job kind ${kind}`);
  if ((holdId === null || holdId === undefined) !== (costCredits === null || costCredits === undefined)) {
    throw new TypeError('enqueue: holdId and costCredits go together');
  }
  if (costCredits !== null && costCredits !== undefined && (!Number.isInteger(costCredits) || costCredits <= 0)) {
    throw new TypeError('enqueue: costCredits must be a positive integer');
  }
  let owner = userId || null;
  if (projectId) {
    const [project] = await storyDb().select('story_projects', { id: projectId }, { columns: ['id', 'user_id'], limit: 1 });
    if (!project) throw new Error(`enqueue: project ${projectId} not found`);
    if (owner && owner !== project.user_id) throw new Error('enqueue: userId does not own the project');
    owner = project.user_id;
  }
  if (!owner) throw new Error('enqueue: userId is required for a job without a project');
  const [job] = await storyDb().insert('story_jobs', {
    project_id: projectId,
    user_id: owner,
    shot_id: shotId,
    kind,
    payload: payload ?? {},
    hold_id: holdId ?? null,
    cost_credits: costCredits ?? null,
    run_after: runAfter ? iso(toDate(runAfter)) : null,
  });
  return job;
}

/** Queued and running jobs of a project (null: account-level), oldest first, public columns only. */
export async function activeJobs(projectId) {
  return storyDb().select(
    'story_jobs',
    { project_id: projectId ?? null, status: ['queued', 'running'] },
    { columns: PUBLIC_COLUMNS, order: ['created_at', 'id'] }
  );
}

/**
 * One pass for a project: claim due jobs one at a time (at most `limit`;
 * async submits also limited by `budget.submits`, default 15; sync kinds only
 * when runSync; worker kinds never), then poll up to 20 running async jobs
 * whose locked_until passed. Stops starting work at `deadline` (epoch ms).
 * Safe to call concurrently. -> { claimed, submitted, polled, done, failed, retried }
 */
export async function tick({ projectId = null, limit = C.claimsPerTick, now, deadline, runSync = true, budget } = {}) {
  await loadHandlers();
  const at = toDate(now);
  const pool = budget || { submits: C.submitsPerTick };
  const summary = { claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 };
  const syncKinds = runSync ? SYNC_KINDS.filter((k) => !WORKER_KINDS.includes(k)) : [];
  const maxClaims = Number.isInteger(limit) && limit >= 0 ? limit : C.claimsPerTick;

  while (summary.claimed < maxClaims && !pastDeadline(deadline)) {
    const asyncOk = pool.submits > 0 && !pool.rateLimited;
    const kinds = asyncOk ? [...ASYNC_KINDS, ...syncKinds] : syncKinds;
    if (kinds.length === 0) break;
    let job;
    try {
      job = await claimOne({ projectId, now: at, kinds });
    } catch (err) {
      log(`claim failed for project ${projectId}: ${err?.message || err}`);
      break;
    }
    if (!job) break;
    summary.claimed += 1;
    try {
      const handler = handlers.get(job.kind);
      let result;
      if (!handler) {
        result = await noHandler(job, at);
      } else if (handler.sync) {
        result = await runSyncJob(job, handler, at);
      } else {
        pool.submits -= 1;
        result = await submitAsync(job, handler, at);
        if (result === 'submitted') summary.submitted += 1;
        if (result === 'rate_limited') pool.rateLimited = true;
      }
      tally(summary, result);
    } catch (err) {
      // The job stays running; the sweeper recovers it.
      log(`job ${job.id} (${job.kind}) failed unexpectedly in tick: ${err?.stack || err?.message || err}`);
    }
  }

  if (pastDeadline(deadline)) return summary;
  let running;
  try {
    running = await storyDb().select('story_jobs', { project_id: projectId ?? null, status: 'running' }, { order: ['locked_until', 'id'] });
  } catch (err) {
    log(`listing running jobs failed for project ${projectId}: ${err?.message || err}`);
    return summary;
  }
  const due = running
    .filter((j) => j.provider_task_id && ASYNC_KINDS.includes(j.kind) && handlers.get(j.kind))
    .filter((j) => !(ms(j.locked_until) > at.getTime()))
    .slice(0, C.pollsPerTick);
  const results = await Promise.all(due.map(async (job) => {
    try {
      const leased = await takeLease(job, at, C.pollLeaseSeconds);
      if (!leased) return null;
      summary.polled += 1;
      return await pollJob(leased, handlers.get(job.kind), at);
    } catch (err) {
      log(`poll of job ${job.id} (${job.kind}) failed: ${err?.message || err}`);
      return null;
    }
  }));
  for (const result of results) tally(summary, result);
  return summary;
}

/**
 * Claims and runs one job of a worker kind (render) from any project, for its
 * own route. -> { claimed: false } | { claimed: true, jobId, outcome }
 */
export async function runWorkerJob(kind, { now, deadline } = {}) {
  if (!WORKER_KINDS.includes(kind)) throw new Error(`runWorkerJob: ${kind} is not a worker kind`);
  await loadHandlers();
  if (pastDeadline(deadline)) return { claimed: false };
  const at = toDate(now);
  const job = await claimOne({ projectId: null, now: at, kinds: [kind], anyProject: true });
  if (!job) return { claimed: false };
  const handler = handlers.get(kind);
  const outcome = handler ? await runSyncJob(job, handler, at) : await noHandler(job, at);
  return { claimed: true, jobId: job.id, outcome };
}

// ------------------------------------------------------------------ webhook (nudge only)

function secret() {
  return process.env.KIE_WEBHOOK_SECRET || '';
}

/** HMAC-SHA256(KIE_WEBHOOK_SECRET, 'kie:<jobId>:<attempt>') as hex. */
export function callbackSignature(jobId, attempt) {
  return createHmac('sha256', secret()).update(`kie:${jobId}:${attempt}`).digest('hex');
}

/**
 * The webhook URL for one try of a job (pass the claimed job row):
 * `${APP_URL}/api/webhooks/kie?job=<id>&sig=<callbackSignature(id, attempts)>`.
 * null when APP_URL or KIE_WEBHOOK_SECRET is unset (polling still finishes the job).
 */
export function callbackUrl(job) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!base || !secret() || !job?.id) return null;
  return `${base}/api/webhooks/kie?job=${encodeURIComponent(job.id)}&sig=${callbackSignature(job.id, job.attempts)}`;
}

function header(headers, name) {
  if (!headers) return undefined;
  const v = typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** kie's own signature (docs.kie.ai webhook verification): base64 HMAC-SHA256(key, taskId + '.' + timestamp). */
function kieSignatureOk(headers, taskId, now) {
  const key = process.env.KIE_WEBHOOK_HMAC_KEY;
  if (!key) return true;
  const ts = String(header(headers, 'x-webhook-timestamp') || '');
  const sig = String(header(headers, 'x-webhook-signature') || '');
  if (!/^\d{1,12}$/.test(ts) || !sig || !taskId) return false;
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > 600) return false;
  const expected = createHmac('sha256', key).update(`${taskId}.${ts}`).digest('base64');
  return sameBytes(sig, expected);
}

/**
 * A provider webhook. Verifies the per-job, per-try signature, then only
 * nudges the job (locked_until = now) so the next tick polls the provider.
 * The body's status and URLs are never used.
 * -> { ok:false, reason:'unauthorized' } | { ok:true, ignored:true } | { ok:true, nudged:true, jobId }
 */
export async function handleProviderCallback(provider, body, { jobId, sig, headers, now } = {}) {
  const at = toDate(now);
  if (typeof jobId !== 'string' || !UUID.test(jobId) || typeof sig !== 'string' || sig === '') {
    return { ok: false, reason: 'unauthorized' };
  }
  const [job] = await storyDb().select('story_jobs', { id: jobId }, { limit: 1 });
  const hasSecret = Boolean(secret());
  if (!hasSecret && !isMock()) return { ok: false, reason: 'unauthorized' };
  // Compare even for a missing job so timing says nothing about which ids exist.
  const expected = hasSecret ? callbackSignature(jobId, job ? job.attempts : -1) : sig;
  if (!sameBytes(sig, expected) || !job) return { ok: false, reason: 'unauthorized' };

  let taskId = null;
  try {
    taskId = parseCallback(provider, body)?.taskId || null;
  } catch {
    taskId = null;
  }
  if (!kieSignatureOk(headers, taskId, at)) return { ok: false, reason: 'unauthorized' };
  if (!taskId) return { ok: true, ignored: true };
  if (job.status !== 'running' || job.provider !== String(provider) || job.provider_task_id !== String(taskId)) {
    if (job.provider_task_id !== String(taskId)) {
      warn(`callback for job ${job.id} names task ${taskId}, current task is ${job.provider_task_id || 'none'}; ignored (reconcile if it was paid)`);
    }
    return { ok: true, ignored: true };
  }
  const rows = await storyDb().update('story_jobs', { ...tryMatch(job), provider_task_id: job.provider_task_id }, {
    locked_until: iso(at),
  });
  return rows.length ? { ok: true, nudged: true, jobId: job.id } : { ok: true, ignored: true };
}

// ------------------------------------------------------------------ sweep

/**
 * Recovery, all projects, at most 50 rows per kind of work, stopping at
 * `deadline`:
 *  1. re-applies finished jobs whose side effects did not complete;
 *  2. running jobs with no task id whose claim lease passed: re-queued with the
 *     attempt given back if never submitted, failed if the submit outcome is unknown;
 *  3. running async jobs past their kind's hard cap: polled once, then failed;
 *  4. running sync jobs older than 10 minutes: the retry rule.
 * -> { repaired, swept, done, retried, failed }
 */
export async function sweep({ now, deadline } = {}) {
  await loadHandlers();
  const at = toDate(now);
  const summary = { repaired: 0, swept: 0, done: 0, retried: 0, failed: 0 };
  const db = storyDb();

  const unapplied = await db.select('story_jobs', { status: ['done', 'failed', 'blocked'], applied_at: null }, { order: ['locked_until', 'id'], limit: C.sweepLimit });
  for (const row of unapplied) {
    if (pastDeadline(deadline)) return summary;
    if (ms(row.locked_until) > at.getTime()) continue;
    try {
      const [leased] = await db.update(
        'story_jobs',
        { id: row.id, status: row.status, applied_at: null, locked_until: row.locked_until ? iso(new Date(row.locked_until)) : null },
        { locked_until: iso(plus(at, C.applyLeaseSeconds)) }
      );
      if (!leased) continue;
      summary.repaired += 1;
      if (leased.status === 'done') await applyDone(leased, at);
      else await applyFailure(leased, at);
    } catch (err) {
      log(`repair of job ${row.id} failed: ${err?.message || err}`);
    }
  }

  const running = await db.select('story_jobs', { status: 'running' }, { order: ['started_at', 'id'], limit: 500 });
  const stuckCutoff = at.getTime() - C.syncStuckMinutes * 60_000;
  let handled = 0;
  for (const job of running) {
    if (pastDeadline(deadline) || handled >= C.sweepLimit) break;
    const handler = handlers.get(job.kind);
    try {
      let result = null;
      if (SYNC_KINDS.includes(job.kind)) {
        if (ms(job.started_at || job.created_at) > stuckCutoff) continue;
        result = await retryOrFail(job, { now: at, error: MSG.slow });
      } else if (!job.provider_task_id) {
        if (ms(job.locked_until) > at.getTime()) continue;
        result = job.submitted_at
          ? await finalize(job, { blocked: false, error: MSG.unknownSubmit, now: at })
          : ((await requeue(job, { now: at, delaySeconds: 0, giveBack: true })) ? 'retried' : 'lost');
      } else {
        if (!overCap(job, at)) continue;
        const leased = await takeLease(job, at, C.pollLeaseSeconds);
        if (!leased) continue;
        result = handler ? await pollJob(leased, handler, at) : await finalize(leased, { blocked: false, error: MSG.slow, now: at });
      }
      handled += 1;
      summary.swept += 1;
      tally(summary, result);
    } catch (err) {
      log(`sweep of job ${job.id} (${job.kind}) failed: ${err?.message || err}`);
    }
  }
  return summary;
}

// ------------------------------------------------------------------ cron

/**
 * One cron run: ticks every project with pending work round-robin (at most 3
 * claims per project per pass, one shared submit budget), then sweeps with
 * whatever time is left (at most 15 s). `deadline` is epoch ms.
 */
export async function runCron({ now, deadline = Date.now() + 45_000, sweepMs = 15_000 } = {}) {
  await loadHandlers();
  const at = toDate(now);
  const totals = { projects: 0, passes: 0, claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 };
  const tickDeadline = deadline - sweepMs;
  let projects = [];
  if (!pastDeadline(tickDeadline)) {
    const rows = await storyDb().rpc('story_pending_projects', { p_now: iso(at), p_limit: 200 });
    projects = rows.map((r) => r.project_id ?? null);
  }
  totals.projects = projects.length;
  const budget = { submits: C.submitsPerTick };
  let active = projects;
  while (active.length && !pastDeadline(tickDeadline)) {
    totals.passes += 1;
    const next = [];
    for (const projectId of active) {
      if (pastDeadline(tickDeadline)) break;
      try {
        const s = await tick({ projectId, limit: C.claimsPerProjectPerPass, now: at, deadline: tickDeadline, budget });
        for (const k of Object.keys(s)) totals[k] += s[k];
        if (s.claimed >= C.claimsPerProjectPerPass) next.push(projectId);
      } catch (err) {
        log(`cron tick failed for project ${projectId}: ${err?.message || err}`);
      }
    }
    active = next;
  }
  let swept = null;
  if (!pastDeadline(deadline)) {
    try {
      swept = await sweep({ now: at, deadline });
    } catch (err) {
      log(`cron sweep failed: ${err?.message || err}`);
    }
  }
  return { ...totals, swept };
}
