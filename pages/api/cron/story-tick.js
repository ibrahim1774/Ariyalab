import { storyDb } from '../../../lib/story/db.js';
import { SUBMITS_PER_TICK, sweep, tick } from '../../../lib/story/runner.js';

/*
 * Every minute (vercel.json): sweep stuck jobs, then tick each project with
 * queued or running jobs. One submit budget (15) is shared by all projects in
 * an invocation, and no new project is started after WORK_MS so the
 * function ends inside maxDuration.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
 */
export const config = { maxDuration: 60 };

const WORK_MS = 45_000;
const MAX_PROJECTS = 100;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const started = Date.now();
  try {
    const swept = await sweep();
    const active = await storyDb().select(
      'story_jobs',
      { status: ['queued', 'running'] },
      { columns: ['project_id', 'created_at'], order: ['created_at'] }
    );
    const projects = [...new Set(active.map((j) => j.project_id))].slice(0, MAX_PROJECTS);
    const budget = { submits: SUBMITS_PER_TICK };
    const totals = { projects: 0, claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 };
    for (const projectId of projects) {
      if (Date.now() - started > WORK_MS) break;
      try {
        const s = await tick({ projectId, budget });
        totals.projects += 1;
        for (const k of Object.keys(s)) totals[k] += s[k];
      } catch (err) {
        console.error('[cron/story-tick] tick failed for project', projectId, err?.message || err);
      }
    }
    return res.status(200).json({ ok: true, swept, ...totals });
  } catch (err) {
    console.error('[cron/story-tick] failed:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}
