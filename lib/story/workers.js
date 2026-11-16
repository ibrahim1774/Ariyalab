import { createHash, timingSafeEqual } from 'node:crypto';

import { isMock } from '../providers/mock.js';
import { storyDb } from './db.js';

/*
 * Worker routes (one function per slow kind). runCron and the actions that
 * queue a worker job only kick the route; the route claims and runs the job
 * itself (runWorkerJob in lib/story/runner.js) so it gets its own maxDuration.
 *
 *   /api/story/worker/audio     narration and music (maxDuration 300)
 *   /api/story/worker/analyze   reference analysis (maxDuration 300)
 *   /api/story/render-worker    render (maxDuration 300, memory 3009)
 *   /api/story/worker/draft     MCP drafting, kind script (maxDuration 300; lib/story/draftJobs.js)
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`, the same secret the cron uses.
 */

export const AUDIO_WORKER_PATH = '/api/story/worker/audio';
export const RENDER_WORKER_PATH = '/api/story/render-worker';
export const ANALYZE_WORKER_PATH = '/api/story/worker/analyze';
export const DRAFT_WORKER_PATH = '/api/story/worker/draft';
// The kinds each route runs (used for the in-process run in mock mode).
const WORKER_ROUTE_KINDS = Object.freeze({ [AUDIO_WORKER_PATH]: ['narration', 'music'], [ANALYZE_WORKER_PATH]: ['analyze'], [DRAFT_WORKER_PATH]: ['script'] });

export function workerAuthorized(header) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

/**
 * Asks a worker route to look for work. Waits only long enough for the request to leave (1.5 s), never for
 * the job, and never throws; Vercel keeps the worker running after the caller aborts. Callers await it, so the
 * request is sent before their own function returns. In mock mode outside the tests there is no secret and no
 * second server: the worker runs in this process. Does nothing in tests, or without APP_URL and CRON_SECRET (the
 * cron kicks again every minute). -> true when a kick was made
 */
export async function kickWorker(path) {
  if (isMock()) {
    if (path === RENDER_WORKER_PATH && process.env.NODE_ENV !== 'test') {
      // A render takes a while: started in this process without holding up the request.
      const { runWorkerJob } = await import('./runner.js');
      void runWorkerJob('render', {}).catch((err) => console.error('[story] mock render worker failed', err?.message || err));
      return true;
    }
    const kinds = WORKER_ROUTE_KINDS[path];
    if (process.env.NODE_ENV === 'test' || !kinds) return false;
    const { runWorkerJob } = await import('./runner.js');
    await Promise.allSettled(kinds.map((k) => runWorkerJob(k, {})));
    return true;
  }
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!base || !process.env.CRON_SECRET) return false;
  try {
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // The abort after the request was sent is expected; the worker keeps running.
  }
  return true;
}

/** True when a narration or music job is waiting for its worker. */
export async function audioWorkPending() {
  const rows = await storyDb().select('story_jobs', { kind: ['narration', 'music'], status: 'queued' }, { columns: ['id'], limit: 1 });
  return rows.length > 0;
}

/** True when an analyze job is waiting for its worker. */
export async function analyzeWorkPending() {
  const rows = await storyDb().select('story_jobs', { kind: 'analyze', status: 'queued' }, { columns: ['id'], limit: 1 });
  return rows.length > 0;
}

/** True when an MCP drafting job (kind script) is waiting for its worker. */
export async function draftWorkPending() {
  const rows = await storyDb().select('story_jobs', { kind: 'script', status: 'queued' }, { columns: ['id'], limit: 1 });
  return rows.length > 0;
}

/** True when a render job is waiting for its worker. */
export async function renderWorkPending() {
  const rows = await storyDb().select('story_jobs', { kind: 'render', status: 'queued' }, { columns: ['id'], limit: 1 });
  return rows.length > 0;
}

/**
 * An abort signal for storage and ffmpeg work inside a worker run: it fires at the worker's
 * `deadline` (epoch ms), or `fallbackMs` from now when the worker passed none.
 */
export function deadlineSignal(deadline, fallbackMs) {
  const ms = Number.isFinite(deadline) ? deadline - Date.now() : fallbackMs;
  return AbortSignal.timeout(Math.max(1000, Math.floor(ms)));
}
