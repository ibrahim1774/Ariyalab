import { runWorkerJob } from '../../../../lib/story/runner.js';
import { workerAuthorized } from '../../../../lib/story/workers.js';

/*
 * Runs the MCP connector's drafting jobs (worker kind 'script', lib/story/draftJobs.js: script write
 * and revise, cast characters, shot plan; never run inside the cron tick or /api/mcp). A run is one
 * or two model calls, so it gets its own function: maxDuration 300. Kicked by runCron and by the MCP
 * tool that queued the job; auth is the cron secret.
 *
 * At most ONE job per invocation, claimed at the start, like the other worker routes.
 */
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!workerAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const out = await runWorkerJob('script', {});
    return res.status(200).json({ ok: true, draft: out.claimed ? 1 : 0 });
  } catch (err) {
    console.error('[worker/draft] failed:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}
