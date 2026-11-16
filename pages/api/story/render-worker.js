import { runWorkerJob } from '../../../lib/story/runner.js';
import { workerAuthorized } from '../../../lib/story/workers.js';

/*
 * Runs render jobs (a worker kind: never run inside the cron tick). One render
 * is a long ffmpeg job, so it gets the whole function: maxDuration 300 here and
 * memory 3009 MB in vercel.json (functions). Kicked by runCron and by
 * startRender; auth is the cron secret (constant-time compare, closed without it).
 *
 * At most ONE render per invocation, claimed at the start with the run's
 * deadline: a second render would start with less than the window left. The
 * cron kicks again every minute for the rest. A render never charges credits.
 */
export const config = { maxDuration: 300 };

// The claim needs RUNNER_CONFIG.syncMinSeconds.render (120 s) left; ffmpeg and the upload stop at this deadline.
const WINDOW_MS = 285_000;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!workerAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  const deadline = Date.now() + WINDOW_MS;
  // allSettled, as the audio worker: an error in the run is logged, never thrown past the route.
  const [result] = await Promise.allSettled([runWorkerJob('render', { deadline })]);
  if (result.status === 'rejected') {
    console.error('[render-worker] failed:', result.reason?.message || result.reason);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true, render: result.value.claimed ? 1 : 0 });
}
