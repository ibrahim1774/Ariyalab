import { isMock } from '../../../lib/providers/mock.js';
import { handleProviderCallback } from '../../../lib/story/runner.js';

/*
 * kie.ai task callback (POST, JSON body). The URL carries ?token=, checked
 * against KIE_WEBHOOK_SECRET in handleProviderCallback (constant time; fails
 * closed when the secret is unset outside STORY_MOCK). No session: the path
 * is outside the middleware's private routes.
 *
 * Answers 200 once the update is stored (also for unknown or finished tasks,
 * and when our own processing fails, which polling recovers), 401 for a bad
 * token, 405 for other methods. Error details never leave the server.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const token = typeof req.query?.token === 'string' ? req.query.token : '';
  try {
    const out = await handleProviderCallback(isMock() ? 'mock' : 'kie', req.body, { token });
    if (!out.ok) return res.status(401).json({ error: 'unauthorized' });
  } catch (err) {
    console.error('[webhooks/kie] callback failed:', err?.message || err);
  }
  return res.status(200).json({ ok: true });
}
