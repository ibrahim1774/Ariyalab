import { runWorkerJob } from '../../../../lib/story/runner.js';
import { workerAuthorized } from '../../../../lib/story/workers.js';

/*
 * Runs narration and music jobs (worker kinds: never run inside the cron tick).
 * A run is one paid provider call, so it gets the whole function: maxDuration 300.
 * Kicked by runCron and by the action that queued the job; auth is the cron secret.
 */
export const config = { maxDuration: 300 };

const KINDS = ['narration', 'music'];

/*
 * At most ONE job per kind per invocation, claimed at the start: a second job would start with less than
 * the whole window left and could be killed mid-call at maxDuration, after the provider was paid. Provider
 * timeouts stay under the window (voice 180 s, music 270 s). The cron kicks again every minute for the rest.
 */
async function work(kind) {
  const out = await runWorkerJob(kind, {});
  return out.claimed ? 1 : 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!workerAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  try {
    // allSettled: one kind failing must not cut off the other's provider call.
    const results = await Promise.allSettled(KINDS.map((k) => work(k)));
    results.forEach((r, i) => { if (r.status === 'rejected') console.error(`[worker/audio] ${KINDS[i]} failed:`, r.reason?.message || r.reason); });
    const [narration, music] = results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
    return res.status(200).json({ ok: true, narration, music });
  } catch (err) {
    console.error('[worker/audio] failed:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}
