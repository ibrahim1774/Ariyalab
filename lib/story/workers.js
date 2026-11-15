import { createHash, timingSafeEqual } from 'node:crypto';

import { isMock } from '../providers/mock.js';
import { storyDb } from './db.js';

/*
 * Worker routes (one function per slow kind). runCron and the actions that
 * queue a worker job only kick the route; the route claims and runs the job
 * itself (runWorkerJob in lib/story/runner.js) so it gets its own maxDuration.
 *
 *   /api/story/worker/audio   narration and music (maxDuration 300)
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`, the same secret the cron uses.
 */

export const AUDIO_WORKER_PATH = '/api/story/worker/audio';

export function workerAuthorized(header) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

/**
 * Asks a worker route to look for work. Fire and forget: it waits only long enough for the request to
 * leave (3 s), never for the job, and never throws. Does nothing in mock mode or without APP_URL and
 * CRON_SECRET (the cron kicks it again every minute). -> true when a request was sent
 */
export async function kickWorker(path) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (isMock() || !base || !process.env.CRON_SECRET) return false;
  try {
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      signal: AbortSignal.timeout(3000),
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
