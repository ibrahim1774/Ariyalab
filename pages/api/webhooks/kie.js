import { isMock } from '../../../lib/providers/mock.js';
import { handleProviderCallback } from '../../../lib/story/runner.js';

/*
 * kie.ai task callback: POST /api/webhooks/kie?job=<jobId>&sig=<signature>,
 * the URL lib/story/runner.js callbackUrl(job) built for that try of the job.
 * The signature (HMAC of the job id and try number with KIE_WEBHOOK_SECRET) is
 * checked in constant time, and kie's X-Webhook-Signature too when
 * KIE_WEBHOOK_HMAC_KEY is set. A valid callback only nudges the job so the
 * next tick polls kie; nothing in the body is trusted. No session: the path is
 * outside the middleware matcher.
 *
 * 200 { ok: true } for anything verified (also unknown or finished tasks, and
 * when our own processing fails: polling recovers), 401 for a bad signature,
 * 405 for other methods. Error details never leave the server.
 */
export const config = { maxDuration: 10 };

const one = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const out = await handleProviderCallback(isMock() ? 'mock' : 'kie', req.body, {
      jobId: one(req.query?.job),
      sig: one(req.query?.sig),
      headers: req.headers,
    });
    if (!out.ok) return res.status(401).json({ error: 'unauthorized' });
  } catch (err) {
    console.error('[webhooks/kie] callback failed:', err?.message || err);
  }
  return res.status(200).json({ ok: true });
}
