import { runWorkerJob } from '../../../../lib/story/runner.js';
import { workerAuthorized } from '../../../../lib/story/workers.js';

/*
 * Runs reference analysis jobs (worker kind 'analyze': never run inside the cron tick).
 * A run downloads the video, runs ffmpeg, transcribes and calls the model, so it gets
 * the whole function: maxDuration 300. Kicked by runCron and by the analyze action;
 * auth is the cron secret.
 *
 * At most ONE job per invocation, claimed at the start: a second would start with less
 * than the whole window and could be cut off after a paid call. The run bounds every
 * provider timeout inside 270 s (lib/story/analyze.js ANALYSIS.windowMs).
 */
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!workerAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const out = await runWorkerJob('analyze', {});
    return res.status(200).json({ ok: true, analyze: out.claimed ? 1 : 0 });
  } catch (err) {
    console.error('[worker/analyze] failed:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}
