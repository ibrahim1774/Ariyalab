import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { HoldClosedError, HoldExceededError, holdHasEntry, releaseHold, settleHold } from '../credits.js';
import { getPricing } from '../pricing.js';
import { ProviderError, SAFE_MESSAGES } from '../providers/errors.js';
import { isMock } from '../providers/mock.js';
import { deleteObject, mirrorUrl } from '../providers/storage.js';
import { parseCallback } from '../providers/video.js';
import { storyDb } from './db.js';

/*
 * The job runner. Every paid or slow step is a story_jobs row; the full
 * contract is the "Runner reference" in
 * .superpowers/sdd/2026-11-14-story-video-maker/task-12-report.md.
 *
 *   queued --claim--> running --submit--> running + provider_task_id --poll--> done
 *                        |                                              \--> failed | blocked
 *                        \-- sync run(job) (cron / worker route) ---------> done | failed | blocked
 *
 * The one money rule: once a paid provider task may exist for a job, nothing
 * here causes a second submit for it. Every uncertain or failing path from
 * that point waits, bounded by a hard cap and a persisted counter that is
 * incremented BEFORE the attempt, or ends in a final failure. A job goes back
 * to 'queued' only when no provider task can exist (see the reference's
 * re-queue table).
 *
 * - Every transition out of 'running' is a conditional update on
 *   (id, status 'running', started_at). Only the caller that gets the row
 *   back acts. started_at changes with every claim, so it names the try.
 * - A poll (and the mirror after it) runs under a lease (lease_until). The
 *   lease is taken with a conditional update, so overlapping callers never
 *   poll or mirror one job twice. locked_until means "next poll due". At most
 *   4 mirrors run at once per instance, each cut off before the caller's deadline.
 * - A finished provider answer that still has to be copied (async 'done', or a
 *   sync result with a provider url) is kept in provider_result until the copy
 *   succeeds, so a copy that cannot run now is tried later from it: the task is
 *   never polled for it again and a sync run is never repeated for it.
 * - Side effects run at least once. A finished row has applied_at = null
 *   until onDone (or the hold release and onFail) has returned. The try is
 *   counted before it starts, and the sweeper re-runs unapplied rows when
 *   their lease ends. Handlers must therefore be idempotent and safe to run
 *   concurrently with themselves.
 * - Webhooks only nudge (locked_until = now, at most once per 5 s, never
 *   inside a poll lease). The next tick polls under our key.
 *
 * Clock: `now` may be a Date, ISO string or ms (a fixed clock, for tests) or
 * a function returning the time; the default is the real clock. Leases are
 * stamped from the clock at the moment of each write. `deadline` is epoch ms
 * on the real clock; no new work starts after it.
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
  pendingProjectsPerRun: 200,
  pollsPerTick: 20,
  mirrorConcurrency: 4,
  maxAttempts: 2, // one retry, only where no provider task can exist
  retryBackoffSeconds: 30,
  rateLimitDelaySeconds: 10,
  rateLimitGiveUpMinutes: 30,
  noHandlerDelaySeconds: 300,
  noHandlerMaxRounds: 5,
  pollIntervalSeconds: 15,
  pollLeaseSeconds: 60,
  pollErrorBackoffMaxSeconds: 300, // poll errors back off 15, 30, 60 ... up to this
  nudgeFloorSeconds: 5,
  syncStuckMinutes: 10,
  // Least time that must be left before a sync job starts in tick / a worker run.
  syncMinSeconds: Object.freeze({ default: 20, render: 120 }),
  taskHardCapMinutes: Object.freeze({ clip: 45, cast_image: 15, still: 15 }),
  // Past its cap, the sweeper polls a job once more (with this short timeout) during
  // the grace, then ends it without polling, so no tick is needed to enforce the cap.
  capGraceMinutes: 10,
  capPollTimeoutMs: 8_000,
  mirrorMaxTries: 4,
  mirrorBackoffSeconds: Object.freeze([30, 60, 120]),
  mirrorTimeoutMs: 45_000,
  mirrorDeadlineMarginMs: 2_000,
  // No mirror starts (and no try is counted) with less time than this for its media class.
  mirrorMinMs: Object.freeze({ video: 25_000, image: 8_000, audio: 10_000 }),
  // runCron lets the sweep's copies run past `deadline`, up to this much after it
  // (the cron function's 60 s limit minus a margin). Tick copies end before the tick deadline.
  cronMirrorExtraMs: 12_000,
  applyLeaseSeconds: 60,
  applyMaxTries: 5,
  applyBackoffSeconds: 60, // times the try number
  taskIdWriteTries: 3,
  taskIdWriteDelayMs: 50, // times the try number
  sweepLimit: 50,
  sweepRepairShare: 0.5, // repairs may use at most this share of the sweep's time
  runningScanLimit: 2000,
  // What lib/providers/storage.js accepts as media, by kind class (first = default).
  mediaExtensions: Object.freeze({
    image: Object.freeze(['png', 'jpg', 'webp']),
    video: Object.freeze(['mp4']),
    audio: Object.freeze(['mp3', 'm4a', 'wav']),
  }),
});
// The live settings: RUNNER_CONFIG, or test overrides from _configure().
let C = { ...RUNNER_CONFIG };

/** Tests: override settings (shallow). */
export function _configure(patch) {
  C = { ...C, ...patch };
}

/** Tests: back to RUNNER_CONFIG. */
export function _resetConfig() {
  C = { ...RUNNER_CONFIG };
}

// Which runner callback is running (onDone/onFail) and whether settleJob is settling: for the
// tests' settle guard (handlers must settle only through settleJob).
const handlerScope = new AsyncLocalStorage();
const settleScope = new AsyncLocalStorage();
export function _handlerCallScope() {
  return { inHandler: Boolean(handlerScope.getStore()), inSettleJob: Boolean(settleScope.getStore()) };
}
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
  attention: 'Needs attention: the result was charged but could not be applied.',
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

function toDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError('runner: bad now');
  return d;
}
/** -> a function returning the current time (fixed when `now` is a value). */
function clockOf(now) {
  if (typeof now === 'function') return () => toDate(now());
  if (now === undefined || now === null) return () => new Date();
  const fixed = toDate(now);
  return () => fixed;
}
const iso = (d) => d.toISOString();
const plus = (d, seconds) => new Date(d.getTime() + seconds * 1000);
const ms = (value) => (value ? new Date(value).getTime() : NaN);
const isoOrNull = (value) => (value ? iso(new Date(value)) : null);
const pastDeadline = (deadline) => deadline !== undefined && deadline !== null && Date.now() >= deadline;
const remainingMs = (deadline) => (deadline === undefined || deadline === null ? Infinity : deadline - Date.now());
const sleep = (n) => new Promise((resolve) => setTimeout(resolve, n));

function errorCode(err) {
  const code = err?.code;
  return code === 'blocked' || code === 'failed' || code === 'rate_limited' || code === 'config' ? code : 'failed';
}

function safeMessage(err, code = errorCode(err)) {
  if (err instanceof ProviderError && err.message) return err.message;
  return SAFE_MESSAGES[code] || SAFE_MESSAGES.failed;
}

/** A submit error whose request may already have reached the provider. */
function isAmbiguous(err) {
  if (err?.ambiguous === true) return true; // set by lib/providers/errors.js
  const names = [err?.name, err?.cause?.name];
  return names.includes('TimeoutError') || names.includes('AbortError');
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

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`mirror timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

/** How long a mirror for this job may run before `deadline`; 0 when there is not enough time to start one. */
function mirrorBudget(deadline, job) {
  const left = remainingMs(deadline) - C.mirrorDeadlineMarginMs;
  const budget = Math.min(C.mirrorTimeoutMs, left);
  const min = C.mirrorMinMs[MEDIA_CLASS[job.kind] || 'video'] ?? C.mirrorMinMs.video;
  return budget >= min ? budget : 0;
}

/**
 * Copies a provider URL into our storage within `timeoutMs`, trying each
 * allowed extension when the bytes don't match. At the timeout the download
 * is aborted (its signal), and the slot stays taken until it has really
 * stopped; the caller gets the timeout at once (a second later at most).
 */
async function mirrorInto(job, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`mirror timed out after ${timeoutMs} ms`)), timeoutMs);
  const work = mirrorSlot(async () => {
    let last;
    for (const ext of extCandidates(job, url)) {
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        return await mirrorUrl({ srcUrl: url, key: keyFor(job, ext), signal: controller.signal });
      } catch (err) {
        last = err;
        if (controller.signal.aborted) throw controller.signal.reason;
        if (err?.message !== WRONG_CONTENT) throw err;
      }
    }
    throw last;
  }).finally(() => clearTimeout(timer));
  return withTimeout(work, timeoutMs + 1_000);
}

async function removeStored(key, why) {
  if (!key) return;
  try {
    await deleteObject({ key });
  } catch (err) {
    log(`could not delete ${key} (${why}): ${err?.message || err}`);
  }
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
async function noteFileStored(projectId, at) {
  if (!projectId) return;
  const days = await retentionDays();
  await storyDb().update(
    'story_projects',
    { id: projectId, files_expire_at: null },
    { files_expire_at: iso(plus(at, days * 86400)) }
  );
}

const settleRef = (job) => `job:${job.id}:settle`;

// ------------------------------------------------------------------ transitions out of 'running'

const RESET_TRY = {
  provider: null,
  provider_task_id: null,
  locked_until: null,
  lease_until: null,
  started_at: null,
  submitted_at: null,
  nudged_at: null,
  mirror_tries: 0,
  poll_errors: 0,
  rate_limited_since: null,
  provider_result: null,
};

/**
 * Back to the queue. Only called where no provider task can exist for this
 * try (see the re-queue table in the reference). giveBack returns the attempt.
 */
async function requeue(job, { clk, delaySeconds, error, giveBack, extra = {} }) {
  const patch = { ...RESET_TRY, status: 'queued', run_after: iso(plus(clk(), delaySeconds)), ...extra };
  if (giveBack) patch.attempts = Math.max(0, (job.attempts || 0) - 1);
  if (error !== undefined) patch.error = error;
  const rows = await storyDb().update('story_jobs', tryMatch(job), patch);
  return rows.length > 0;
}

/** Ends a running job as failed or blocked, then applies the failure (release + onFail). */
async function finalize(job, { blocked, error, clk }) {
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    status: blocked ? 'blocked' : 'failed',
    error,
    locked_until: iso(plus(clk(), C.applyLeaseSeconds)),
    lease_until: null,
    applied_at: null,
    apply_tries: 0,
  });
  if (rows.length === 0) return 'lost';
  await applyFailure(rows[0], clk);
  return blocked ? 'blocked' : 'failed';
}

/**
 * A failure where no provider task exists (a definite submit failure, a sync
 * run): re-queue with backoff while attempts < maxAttempts, else fail for good.
 */
async function retryOrFail(job, { clk, error }) {
  if ((job.attempts || 0) < C.maxAttempts) {
    return (await requeue(job, { clk, delaySeconds: C.retryBackoffSeconds, error, giveBack: false })) ? 'retried' : 'lost';
  }
  return finalize(job, { blocked: false, error, clk });
}

/** A rate limit (the request was refused, no task): wait 10 s without using an attempt, for up to 30 minutes. */
async function rateLimited(job, clk) {
  const now = clk();
  const since = job.rate_limited_since ? new Date(job.rate_limited_since) : now;
  if (now.getTime() - since.getTime() > C.rateLimitGiveUpMinutes * 60_000) {
    log(`job ${job.id} (${job.kind}) gave up after ${C.rateLimitGiveUpMinutes} minutes of rate limits`);
    return finalize(job, { blocked: false, error: SAFE_MESSAGES.rate_limited, clk });
  }
  const ok = await requeue(job, {
    clk, delaySeconds: C.rateLimitDelaySeconds, giveBack: true, extra: { rate_limited_since: iso(since) },
  });
  return ok ? 'rate_limited' : 'lost';
}

/** Maps an error thrown by submit (async) or run (sync) to a transition. */
async function handleError(job, err, clk, { submit = false } = {}) {
  const code = errorCode(err);
  // First: a submit that threw anything but a clear provider answer may have created a task.
  if (submit && (isAmbiguous(err) || !(err instanceof ProviderError))) {
    log(`job ${job.id} (${job.kind}): submit outcome unknown (${err?.cause?.causeCode || err?.cause?.status || err?.cause?.name || err?.name}); failed instead of submitting twice`);
    return finalize(job, { blocked: false, error: MSG.unknownSubmit, clk });
  }
  if (code === 'rate_limited') return rateLimited(job, clk);
  if (code === 'blocked') return finalize(job, { blocked: true, error: safeMessage(err, code), clk });
  if (code === 'config') {
    log(`CONFIG ERROR, job ${job.id} (${job.kind}) failed without retry: ${err?.message || err}. Fix the environment and re-run the step.`);
    return finalize(job, { blocked: false, error: SAFE_MESSAGES.failed, clk });
  }
  if (!(err instanceof ProviderError)) log(`job ${job.id} (${job.kind}) error: ${err?.stack || err?.message || err}`);
  return retryOrFail(job, { clk, error: safeMessage(err, code) });
}

/** running -> done with the stored result, then applies it (onDone). */
async function markDone(job, stored, clk) {
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    status: 'done',
    result: stored,
    provider_result: null,
    error: null,
    locked_until: iso(plus(clk(), C.applyLeaseSeconds)),
    lease_until: null,
    applied_at: null,
    apply_tries: 0,
  });
  if (rows.length === 0) return 'lost';
  await applyDone(rows[0], clk);
  return 'done';
}

/** If our copy is not what the row ended up holding, delete it (the job was ended meanwhile). */
async function dropOrphanCopy(job, key) {
  try {
    const [row] = await storyDb().select('story_jobs', { id: job.id }, { columns: ['id', 'status', 'result'], limit: 1 });
    if (row && row.status === 'done' && row.result?.key === key) return;
  } catch (err) {
    log(`could not check job ${job.id} before deleting ${key}: ${err?.message || err}`);
    return;
  }
  await removeStored(key, `job ${job.id} ended while its file was being copied`);
}

/** The copy tries are used up (or the file can never be stored): final, with an operator line (the result was paid). */
function copyGiveUp(job, clk, why) {
  log(`OPERATOR: job ${job.id} (${job.kind}) finished at the provider${job.provider_task_id ? ` (task ${job.provider_task_id})` : ''} but its file could not be stored (${why}); failed without asking the provider again`);
  return finalize(job, { blocked: false, error: MSG.store, clk });
}

/**
 * A finished provider answer (`base`: { url } for an async task, the run's
 * value for a sync kind): keep it on the row (provider_result), count the
 * mirror try (persisted, with a lease that covers it), copy the file into our
 * storage, then mark done with `{ ...base, url, key }`. With too little time
 * to copy, the answer is kept and nothing is counted; tick or the sweep copies
 * it later from the row. Never submits or runs again: the mirror tries end it.
 */
async function copyResult(job, base, clk, deadline) {
  if (!base?.url) return finalize(job, { blocked: false, error: SAFE_MESSAGES.failed, clk });
  if ((job.mirror_tries || 0) >= C.mirrorMaxTries) return copyGiveUp(job, clk, `${job.mirror_tries} copy tries used`);
  const budget = mirrorBudget(deadline, job);
  if (budget === 0) {
    // Not enough time to copy this kind of file: keep the answer, free the lease, count nothing, leave it due.
    const rows = await storyDb().update('story_jobs', tryMatch(job), {
      provider_result: base, lease_until: null, locked_until: iso(clk()),
    });
    return rows.length ? 'pending' : 'lost';
  }
  const tries = (job.mirror_tries || 0) + 1;
  const counted = await storyDb().update('story_jobs', tryMatch(job), {
    provider_result: base,
    mirror_tries: tries,
    lease_until: iso(new Date(clk().getTime() + budget + C.mirrorDeadlineMarginMs)),
  });
  if (!counted.length) return 'lost';
  let copy;
  try {
    copy = await mirrorInto(job, base.url, budget);
  } catch (err) {
    return mirrorFailed({ ...job, mirror_tries: tries }, err, clk);
  }
  const result = await markDone(job, { ...base, url: copy.url, key: copy.key }, clk);
  if (result === 'lost') await dropOrphanCopy(job, copy.key);
  return result;
}

/** Keeps the task id and the kept answer; the copy is tried again after a backoff, or the job fails for good. */
async function mirrorFailed(job, err, clk) {
  const tries = job.mirror_tries || 0;
  const permanent = PERMANENT_MIRROR.has(err?.message);
  log(`mirror failed for job ${job.id} (${job.kind}), try ${tries}${permanent ? ' (permanent)' : ''}: ${err?.message || err}`);
  if (permanent) return finalize(job, { blocked: false, error: MSG.store, clk });
  if (tries >= C.mirrorMaxTries) return copyGiveUp(job, clk, `${tries} copy tries failed`);
  const backoff = C.mirrorBackoffSeconds[Math.min(tries - 1, C.mirrorBackoffSeconds.length - 1)];
  const rows = await storyDb().update('story_jobs', tryMatch(job), {
    lease_until: null,
    locked_until: iso(plus(clk(), backoff)),
  });
  return rows.length ? 'pending' : 'lost';
}

// ------------------------------------------------------------------ applying side effects

const unappliedMatch = (row) => ({ id: row.id, status: row.status, applied_at: null });

async function markApplied(row, clk, extra = {}) {
  await storyDb().update('story_jobs', unappliedMatch(row), { applied_at: iso(clk()), locked_until: null, ...extra });
}

/** Counts a side-effect try before it starts. -> the counted row, or null when another caller has the row. */
async function countApply(row, clk) {
  const tries = (row.apply_tries || 0) + 1;
  const rows = await storyDb().update('story_jobs', unappliedMatch(row), {
    apply_tries: tries,
    locked_until: iso(plus(clk(), C.applyLeaseSeconds)),
  });
  return rows[0] || null;
}

/** A side effect threw: back off (the try is already counted). */
async function applyBackoff(row, clk, err, what) {
  log(`${what} failed for job ${row.id} (${row.kind}), try ${row.apply_tries}: ${err?.stack || err?.message || err}`);
  await storyDb().update('story_jobs', unappliedMatch(row), {
    locked_until: iso(plus(clk(), C.applyBackoffSeconds * row.apply_tries)),
  });
}

async function applyDone(row, clk) {
  if ((row.apply_tries || 0) >= C.applyMaxTries) return giveUpDone(row, clk);
  const counted = await countApply(row, clk);
  if (!counted) return;
  const result = counted.result;
  if (result && typeof result === 'object' && result.key) {
    try {
      await noteFileStored(counted.project_id, clk());
    } catch (err) {
      log(`files_expire_at update failed for project ${counted.project_id}: ${err?.message || err}`);
    }
  }
  const handler = handlers.get(counted.kind);
  try {
    if (!handler) throw new Error(`no handler registered for ${counted.kind}`);
    if (handler.onDone) await handlerScope.run(true, () => handler.onDone(counted, result));
  } catch (err) {
    await applyBackoff(counted, clk, err, 'onDone');
    if (counted.apply_tries >= C.applyMaxTries) await giveUpDone(counted, clk);
    return;
  }
  await markApplied(counted, clk);
}

/**
 * onDone failed applyMaxTries times. If the job's share was already settled
 * (settleJob's ref is in the ledger) the customer was charged: keep the job
 * done, flag it for an operator and leave the hold alone. Otherwise the result
 * is unused: delete the stored file and fail the job (release + onFail).
 */
async function giveUpDone(row, clk) {
  let settled = false;
  if (row.hold_id) {
    try {
      settled = await holdHasEntry({ holdId: row.hold_id, op: 'settle', ref: settleRef(row) });
    } catch (err) {
      log(`could not check the settle of job ${row.id}; will try again: ${err?.message || err}`);
      return;
    }
  }
  if (settled) {
    log(`OPERATOR: job ${row.id} (${row.kind}) was charged (hold ${row.hold_id}) but onDone kept failing; stored file ${row.result?.key || '(none)'} kept; needs attention`);
    await markApplied(row, clk, { error: MSG.attention });
    return;
  }
  const rows = await storyDb().update('story_jobs', unappliedMatch(row), {
    status: 'failed',
    error: MSG.apply,
    apply_tries: 0,
    locked_until: iso(plus(clk(), C.applyLeaseSeconds)),
  });
  if (!rows[0]) return;
  await removeStored(row.result?.key, `job ${row.id} failed after onDone gave up`);
  await applyFailure(rows[0], clk);
}

async function applyFailure(row, clk) {
  if ((row.apply_tries || 0) >= C.applyMaxTries) {
    log(`OPERATOR: failure side effects for job ${row.id} (${row.kind}) kept failing; hold ${row.hold_id || '(none)'} share ${row.cost_credits || 0} may need a manual release`);
    await markApplied(row, clk);
    return;
  }
  const counted = await countApply(row, clk);
  if (!counted) return;
  if (counted.hold_id && counted.cost_credits > 0) {
    try {
      await releaseHold({ holdId: counted.hold_id, amount: counted.cost_credits, ref: `job:${counted.id}` });
    } catch (err) {
      const terminal = err instanceof HoldClosedError || err instanceof HoldExceededError || /hold_not_found/.test(err?.message || '');
      if (!terminal) {
        await applyBackoff(counted, clk, err, 'hold release');
        return;
      }
      log(`hold ${counted.hold_id} for job ${counted.id} needs no release (${err?.message || err})`);
    }
  }
  const handler = handlers.get(counted.kind);
  if (handler?.onFail) {
    try {
      await handlerScope.run(true, () => handler.onFail(counted, { blocked: counted.status === 'blocked', error: counted.error, final: true }));
    } catch (err) {
      await applyBackoff(counted, clk, err, 'onFail');
      return;
    }
  }
  await markApplied(counted, clk);
}

// ------------------------------------------------------------------ steps

async function writeTaskId(job, task, clk) {
  let lastErr;
  for (let i = 0; i < C.taskIdWriteTries; i++) {
    if (i > 0) await sleep(C.taskIdWriteDelayMs * i);
    try {
      const rows = await storyDb().update('story_jobs', tryMatch(job), {
        provider: String(task.provider),
        provider_task_id: String(task.taskId),
        locked_until: iso(plus(clk(), C.pollIntervalSeconds)),
        rate_limited_since: null,
      });
      if (!rows.length) {
        log(`ORPHAN TASK: job ${job.id} (${job.kind}) changed while ${task.provider} task ${task.taskId} was created; the task is not tracked`);
        return 'lost';
      }
      return 'submitted';
    } catch (err) {
      lastErr = err;
    }
  }
  log(`ORPHAN TASK: job ${job.id} (${job.kind}) got ${task.provider} task ${task.taskId} but it could not be stored: ${lastErr?.message || lastErr}`);
  throw lastErr;
}

async function submitAsync(job, handler, clk) {
  // Marked before the call: a crash after this leaves "submitted, outcome unknown", which is never re-submitted.
  const marked = await storyDb().update('story_jobs', tryMatch(job), { submitted_at: iso(clk()) });
  if (!marked.length) return 'lost';
  let task;
  try {
    task = await handler.submit(job);
  } catch (err) {
    return handleError(job, err, clk, { submit: true });
  }
  if (!task || !task.provider || !task.taskId) {
    log(`submit for job ${job.id} (${job.kind}) returned no provider task`);
    return finalize(job, { blocked: false, error: MSG.unknownSubmit, clk });
  }
  return writeTaskId(job, task, clk);
}

async function runSyncJob(job, handler, clk, deadline) {
  let value;
  try {
    value = await handler.run(job);
  } catch (err) {
    return handleError(job, err, clk);
  }
  const isObject = value !== null && typeof value === 'object';
  // A result with a provider url and no key of ours is media to copy (kept on the row until it is
  // copied, so the paid run is never repeated for it); one with a key is already stored.
  if (isObject && value.url && !value.key) return copyResult(job, value, clk, deadline);
  return markDone(job, value ?? {}, clk);
}

async function noHandler(job, clk) {
  const rounds = (job.no_handler_rounds || 0) + 1;
  log(`no handler registered for job kind ${job.kind} (job ${job.id}), round ${rounds}`);
  if (rounds >= C.noHandlerMaxRounds) {
    await storyDb().update('story_jobs', tryMatch(job), { no_handler_rounds: rounds });
    return finalize(job, { blocked: false, error: MSG.noHandler, clk });
  }
  const ok = await requeue(job, { clk, delaySeconds: C.noHandlerDelaySeconds, giveBack: true, extra: { no_handler_rounds: rounds } });
  return ok ? 'skipped' : 'lost';
}

const leaseFree = (job, at) => !(ms(job.lease_until) > at.getTime());

/** Takes the poll lease; -> the leased row, or null when another caller holds it. */
async function takeLease(job, clk) {
  const rows = await storyDb().update(
    'story_jobs',
    { ...tryMatch(job), lease_until: isoOrNull(job.lease_until) },
    { lease_until: iso(plus(clk(), C.pollLeaseSeconds)) }
  );
  return rows[0] || null;
}

function overCap(job, at, extraMinutes = 0) {
  const cap = C.taskHardCapMinutes[job.kind];
  const start = ms(job.submitted_at || job.started_at);
  return cap !== undefined && Number.isFinite(start) && at.getTime() - start >= (cap + extraMinutes) * 60_000;
}

/**
 * One poll of a leased job. While the job holds a provider task, nothing here
 * re-queues it: pending and poll errors wait (bounded by the hard cap), and
 * failed or blocked answers end it for good.
 * -> 'pending' | 'done' | 'failed' | 'blocked' | 'lost'
 */
async function pollJob(job, handler, clk, deadline, { timeoutMs } = {}) {
  let outcome;
  let pollError = null;
  try {
    if (timeoutMs) {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`poll timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });
      outcome = await Promise.race([handler.poll(job, { signal: controller.signal }), timeout]).finally(() => clearTimeout(timer));
    } else {
      outcome = await handler.poll(job);
    }
  } catch (err) {
    const code = errorCode(err);
    if (code === 'blocked') return finalize(job, { blocked: true, error: safeMessage(err, code), clk });
    if (code === 'config') {
      log(`CONFIG ERROR while polling job ${job.id} (${job.kind}): ${err?.message || err}`);
      return finalize(job, { blocked: false, error: SAFE_MESSAGES.failed, clk });
    }
    pollError = err;
    outcome = { status: 'pending' };
  }
  if (!ASYNC_RESULT.has(outcome?.status)) {
    log(`poll for job ${job.id} (${job.kind}) returned an unknown status ${outcome?.status}`);
    outcome = { status: 'pending' };
  }
  const at = clk();
  if (outcome.status === 'done') {
    if (overCap(job, at)) warn(`job ${job.id} (${job.kind}) task ${job.provider_task_id} finished after its ${C.taskHardCapMinutes[job.kind]} minute cap`);
    return copyResult(job, { url: outcome.url }, clk, deadline);
  }
  if (outcome.status === 'blocked') return finalize(job, { blocked: true, error: outcome.error || SAFE_MESSAGES.blocked, clk });
  if (outcome.status === 'failed') return finalize(job, { blocked: false, error: outcome.error || SAFE_MESSAGES.failed, clk });

  // Past the cap, a pending answer ends the job. A poll error or timeout tells us nothing, so
  // inside the grace it waits like any poll error; the sweep ends it at cap + grace.
  if (overCap(job, at) && (!pollError || overCap(job, at, C.capGraceMinutes))) {
    log(`job ${job.id} (${job.kind}) passed its ${C.taskHardCapMinutes[job.kind]} minute cap; failed without submitting again`);
    return finalize(job, { blocked: false, error: MSG.slow, clk });
  }
  let errors = 0;
  let wait = C.pollIntervalSeconds;
  if (pollError) {
    errors = (job.poll_errors || 0) + 1;
    wait = Math.min(C.pollErrorBackoffMaxSeconds, C.pollIntervalSeconds * 2 ** (errors - 1));
    if (!(pollError instanceof ProviderError)) log(`poll for job ${job.id} (${job.kind}) threw: ${pollError?.message || pollError}`);
  }
  await storyDb().update('story_jobs', tryMatch(job), {
    locked_until: iso(plus(clk(), wait)),
    lease_until: null,
    poll_errors: errors,
  });
  return 'pending';
}

function tally(summary, result) {
  if (result === 'done') summary.done += 1;
  else if (result === 'failed' || result === 'blocked') summary.failed += 1;
  else if (result === 'retried' || result === 'rate_limited') summary.retried += 1;
}

async function claimOne({ projectId, at, kinds, anyProject = false }) {
  const params = { p_project: projectId ?? null, p_limit: 1, p_now: iso(at) };
  if (kinds) params.p_kinds = kinds;
  if (anyProject) params.p_any_project = true;
  const rows = await storyDb().rpc('story_claim_jobs', params);
  return rows[0] || null;
}

const syncMinMs = (kind) => 1000 * (C.syncMinSeconds[kind] ?? C.syncMinSeconds.default);

// ------------------------------------------------------------------ public API

/**
 * Adds a job. -> the story_jobs row.
 * userId is taken from the project; pass it for account-level jobs (no projectId).
 * holdId and costCredits go together: the hold share this job settles (settleJob) or releases.
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

/**
 * The only way a handler settles: settles the job's hold share
 * (cost_credits) with reason `story_<kind>` and ref `job:<id>:settle`, which
 * the runner looks up later. Does nothing when that ref is already in the
 * ledger. Call it as the LAST step of onDone. -> balance, or null when the
 * job has no hold or was already settled.
 */
export async function settleJob(job) {
  if (!job?.hold_id || !(job.cost_credits > 0)) return null;
  if (await holdHasEntry({ holdId: job.hold_id, op: 'settle', ref: settleRef(job) })) return null;
  return settleScope.run(true, () => settleHold({
    holdId: job.hold_id, amount: job.cost_credits, reason: `story_${job.kind}`, ref: settleRef(job),
  }));
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
 * when runSync and their minimum time is left; worker kinds never), then poll
 * up to 20 running async jobs that are due and not leased. Safe to call
 * concurrently. -> { claimed, submitted, polled, done, failed, retried }
 */
export async function tick({ projectId = null, limit = C.claimsPerTick, now, deadline, mirrorDeadline, runSync = true, budget } = {}) {
  const copyBy = mirrorDeadline ?? deadline;
  await loadHandlers();
  const clk = clockOf(now);
  const pool = budget || { submits: C.submitsPerTick };
  const summary = { claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 };
  const maxClaims = Number.isInteger(limit) && limit >= 0 ? limit : C.claimsPerTick;

  while (summary.claimed < maxClaims && !pastDeadline(deadline)) {
    const syncKinds = runSync
      ? SYNC_KINDS.filter((k) => !WORKER_KINDS.includes(k) && remainingMs(deadline) >= syncMinMs(k))
      : [];
    const asyncOk = pool.submits > 0 && !pool.rateLimited;
    const kinds = asyncOk ? [...ASYNC_KINDS, ...syncKinds] : syncKinds;
    if (kinds.length === 0) break;
    let job;
    try {
      job = await claimOne({ projectId, at: clk(), kinds });
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
        result = await noHandler(job, clk);
      } else if (handler.sync) {
        result = await runSyncJob(job, handler, clk, copyBy);
      } else {
        pool.submits -= 1;
        result = await submitAsync(job, handler, clk);
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
  const at = clk();
  // Due: async tasks to poll, and kept answers (any kind) waiting for their copy.
  const due = running
    .filter((j) => j.provider_result || (j.provider_task_id && ASYNC_KINDS.includes(j.kind) && handlers.get(j.kind)))
    .filter((j) => !(ms(j.locked_until) > at.getTime()) && leaseFree(j, at))
    .slice(0, C.pollsPerTick);
  const results = await Promise.all(due.map(async (job) => {
    try {
      const leased = await takeLease(job, clk);
      if (!leased) return null;
      if (leased.provider_result) return await copyResult(leased, leased.provider_result, clk, copyBy);
      summary.polled += 1;
      return await pollJob(leased, handlers.get(job.kind), clk, copyBy);
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
 * own route. Nothing is claimed with less than the kind's minimum time left.
 * -> { claimed: false } | { claimed: true, jobId, outcome }
 */
export async function runWorkerJob(kind, { now, deadline } = {}) {
  if (!WORKER_KINDS.includes(kind)) throw new Error(`runWorkerJob: ${kind} is not a worker kind`);
  await loadHandlers();
  if (pastDeadline(deadline) || remainingMs(deadline) < syncMinMs(kind)) return { claimed: false };
  const clk = clockOf(now);
  const job = await claimOne({ projectId: null, at: clk(), kinds: [kind], anyProject: true });
  if (!job) return { claimed: false };
  const handler = handlers.get(kind);
  const outcome = handler ? await runSyncJob(job, handler, clk, deadline) : await noHandler(job, clk);
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
function kieSignatureOk(headers, taskId, at) {
  const key = process.env.KIE_WEBHOOK_HMAC_KEY;
  if (!key) return true;
  const ts = String(header(headers, 'x-webhook-timestamp') || '');
  const sig = String(header(headers, 'x-webhook-signature') || '');
  if (!/^\d{1,12}$/.test(ts) || !sig || !taskId) return false;
  if (Math.abs(at.getTime() / 1000 - Number(ts)) > 600) return false;
  const expected = createHmac('sha256', key).update(`${taskId}.${ts}`).digest('base64');
  return sameBytes(sig, expected);
}

/**
 * A provider webhook. Verifies the per-job, per-try signature, then only
 * nudges the job (locked_until = now) so the next tick polls the provider:
 * at most once per 5 s, and never while a poll holds the job's lease. The
 * body's status and URLs are never used.
 * -> { ok:false, reason:'unauthorized' } | { ok:true, ignored:true } | { ok:true, nudged:true, jobId }
 */
export async function handleProviderCallback(provider, body, { jobId, sig, headers, now } = {}) {
  const at = clockOf(now)();
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
  if (ms(job.nudged_at) > at.getTime() - C.nudgeFloorSeconds * 1000) return { ok: true, ignored: true };
  if (!leaseFree(job, at)) return { ok: true, ignored: true }; // a poll is in flight; it will see the result
  // Never shorten a backoff (poll errors, a failed copy): only a normal wait is pulled forward.
  if ((job.poll_errors || 0) > 0 || ms(job.locked_until) - at.getTime() > C.pollIntervalSeconds * 1000) {
    return { ok: true, ignored: true };
  }
  const rows = await storyDb().update(
    'story_jobs',
    { ...tryMatch(job), provider_task_id: job.provider_task_id, lease_until: isoOrNull(job.lease_until), nudged_at: isoOrNull(job.nudged_at) },
    { locked_until: iso(at), nudged_at: iso(at) }
  );
  return rows.length ? { ok: true, nudged: true, jobId: job.id } : { ok: true, ignored: true };
}

// ------------------------------------------------------------------ sweep

/**
 * Recovery, all projects. Work that needs provider or storage time stops at
 * `deadline`; the database-only steps (marked DB) run even past it, so the
 * hard cap holds when the caller ran late:
 *  1. re-applies finished jobs whose side effects did not complete (at most
 *     half of the sweep's time, so the rest always runs; not past `deadline`);
 *  2. kept provider answers (provider_result) whose copy is due: copied (a
 *     counted try; not past `deadline` or without copy time), or failed with
 *     an OPERATOR line once the copy tries are used up (DB);
 *  3. DB: running jobs with no task id whose claim lease passed: re-queued
 *     with the attempt given back if never submitted, failed if the submit
 *     outcome is unknown;
 *  4. running async jobs past their kind's hard cap: inside the grace, polled
 *     once more when due and the short poll timeout is still left (not past
 *     `deadline`); DB: past cap + grace, failed without polling;
 *  5. DB: running sync jobs older than 10 minutes: the retry rule (sync kinds
 *     hold no provider task).
 * At most sweepLimit jobs are handled. -> { repaired, swept, done, retried, failed }
 */
export async function sweep({ now, deadline, mirrorDeadline } = {}) {
  const copyBy = mirrorDeadline ?? deadline;
  await loadHandlers();
  const clk = clockOf(now);
  const summary = { repaired: 0, swept: 0, done: 0, retried: 0, failed: 0 };
  const db = storyDb();
  const repairDeadline = deadline === undefined || deadline === null
    ? undefined
    : Date.now() + Math.max(0, deadline - Date.now()) * C.sweepRepairShare;

  const unapplied = await db.select('story_jobs', { status: ['done', 'failed', 'blocked'], applied_at: null }, { order: ['locked_until', 'id'], limit: C.sweepLimit });
  for (const row of unapplied) {
    if (pastDeadline(repairDeadline)) break;
    if (ms(row.locked_until) > clk().getTime()) continue;
    try {
      const [leased] = await db.update(
        'story_jobs',
        { ...unappliedMatch(row), locked_until: isoOrNull(row.locked_until) },
        { locked_until: iso(plus(clk(), C.applyLeaseSeconds)) }
      );
      if (!leased) continue;
      summary.repaired += 1;
      if (leased.status === 'done') await applyDone(leased, clk);
      else await applyFailure(leased, clk);
    } catch (err) {
      log(`repair of job ${row.id} failed: ${err?.message || err}`);
    }
  }

  const running = await db.select('story_jobs', { status: 'running' }, { order: ['started_at', 'id'], limit: C.runningScanLimit });
  let handled = 0;
  for (const job of running) {
    if (handled >= C.sweepLimit) break;
    const late = pastDeadline(deadline); // from here on, database-only steps only
    const at = clk();
    const handler = handlers.get(job.kind);
    try {
      let result = null;
      if (job.provider_result) {
        // Finished at the provider, waiting for its copy: never failed by the cap while tries are left.
        if (!leaseFree(job, at) || ms(job.locked_until) > at.getTime()) continue;
        const triesLeft = (job.mirror_tries || 0) < C.mirrorMaxTries;
        if (triesLeft && (late || mirrorBudget(copyBy, job) === 0)) continue;
        const leased = await takeLease(job, clk);
        if (!leased) continue;
        result = await copyResult(leased, leased.provider_result, clk, copyBy);
      } else if (SYNC_KINDS.includes(job.kind)) {
        if (ms(job.started_at || job.created_at) > at.getTime() - C.syncStuckMinutes * 60_000) continue;
        result = await retryOrFail(job, { clk, error: MSG.slow });
      } else if (!job.provider_task_id) {
        if (ms(job.locked_until) > at.getTime()) continue;
        result = job.submitted_at
          ? await finalize(job, { blocked: false, error: MSG.unknownSubmit, clk })
          : ((await requeue(job, { clk, delaySeconds: 0, giveBack: true })) ? 'retried' : 'lost');
      } else {
        if (!overCap(job, at) || !leaseFree(job, at)) continue;
        if (!handler || overCap(job, at, C.capGraceMinutes)) {
          // Past cap + grace: end it without asking again, whether or not any tick reaches the project.
          warn(`job ${job.id} (${job.kind}) task ${job.provider_task_id} passed its cap and grace; failed without polling (reconcile if the task finishes)`);
          result = await finalize(job, { blocked: false, error: MSG.slow, clk });
        } else {
          // Inside the grace: one more short poll when it is due and there is time for it.
          if (late || ms(job.locked_until) > at.getTime()) continue;
          if (remainingMs(deadline) < C.capPollTimeoutMs + C.mirrorDeadlineMarginMs) continue;
          const leased = await takeLease(job, clk);
          if (!leased) continue;
          result = await pollJob(leased, handler, clk, copyBy, { timeoutMs: C.capPollTimeoutMs });
        }
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
 * One cron run: ticks the projects with pending work (rotating, least
 * recently picked first) round-robin, at most 3 claims per project per pass
 * under one shared submit budget, until the tick deadline (deadline -
 * sweepMs; copies started by ticks end before it), then always sweeps: with
 * the time left before `deadline`, and its copies may run until
 * `mirrorDeadline` (deadline + 12 s). Past `deadline` the sweep still runs its
 * database-only steps, so an over-cap job is ended even when a tick ran late.
 * `deadline` is epoch ms.
 */
export async function runCron({ now, deadline = Date.now() + 45_000, sweepMs = 15_000, mirrorDeadline } = {}) {
  const copyBy = mirrorDeadline ?? deadline + C.cronMirrorExtraMs;
  await loadHandlers();
  const clk = clockOf(now);
  const totals = { projects: 0, passes: 0, claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 };
  const tickDeadline = deadline - sweepMs;
  const tickCopyBy = Math.min(tickDeadline, copyBy);
  let projects = [];
  if (!pastDeadline(tickDeadline)) {
    try {
      const rows = await storyDb().rpc('story_pending_projects', {
        p_now: iso(clk()), p_limit: C.pendingProjectsPerRun, p_skip_kinds: [...WORKER_KINDS],
      });
      projects = rows.map((r) => r.project_id ?? null);
    } catch (err) {
      log(`cron could not list projects with pending work: ${err?.message || err}`);
    }
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
        const s = await tick({ projectId, limit: C.claimsPerProjectPerPass, now: clk, deadline: tickDeadline, mirrorDeadline: tickCopyBy, budget });
        for (const k of Object.keys(s)) totals[k] += s[k];
        if (s.claimed >= C.claimsPerProjectPerPass) next.push(projectId);
      } catch (err) {
        log(`cron tick failed for project ${projectId}: ${err?.message || err}`);
      } finally {
        // Rotation: every project this run actually reached moves to the back, even when its tick threw.
        if (projectId) {
          try {
            await storyDb().update('story_projects', { id: projectId }, { runner_ticked_at: iso(clk()) });
          } catch (err) {
            log(`cron could not stamp project ${projectId}: ${err?.message || err}`);
          }
        }
      }
    }
    active = next;
  }
  let swept = null;
  try {
    swept = await sweep({ now: clk, deadline, mirrorDeadline: copyBy });
  } catch (err) {
    log(`cron sweep failed: ${err?.message || err}`);
  }
  return { ...totals, swept };
}
