import { runWorkerJob } from '../../../../lib/story/runner.js';
import { workerAuthorized } from '../../../../lib/story/workers.js';

/*
 * Runs narration and music jobs (worker kinds: never run inside the cron tick).
 * A run is one paid provider call, so it gets the whole function: maxDuration 300.
 * Kicked by runCron and by the action that queued the job; auth is the cron secret.
 */
export const config = { maxDuration: 300 };

const WORK_MS = 285_000;
const KINDS = ['narration', 'music'];

async function work(kind, deadline) {
  let ran = 0;
  // A job starts only with enough time left (RUNNER_CONFIG.syncMinSeconds); runWorkerJob says claimed:false otherwise.
  for (;;) {
    const out = await runWorkerJob(kind, { deadline });
    if (!out.claimed) return ran;
    ran += 1;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!workerAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const deadline = Date.now() + WORK_MS;
    const [narration, music] = await Promise.all(KINDS.map((k) => work(k, deadline)));
    return res.status(200).json({ ok: true, narration, music });
  } catch (err) {
    console.error('[worker/audio] failed:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}
