import { createHash, timingSafeEqual } from 'node:crypto';

import { runCron } from '../../../lib/story/runner.js';

/*
 * Every minute (vercel.json): runCron ticks each project with pending work
 * round-robin under one shared submit budget, then sweeps with the time left.
 * Work stops starting at WORK_MS so the function ends inside maxDuration.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
 */
export const config = { maxDuration: 60 };

const WORK_MS = 45_000;

function authorized(header) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const out = await runCron({ deadline: Date.now() + WORK_MS });
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('[cron/story-tick] failed:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}
