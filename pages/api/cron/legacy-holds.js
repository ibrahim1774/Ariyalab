import { safeEqual } from '../../../lib/mcp/oauth.js';
import { reconcileLegacyHolds } from '../../../lib/legacyHolds.js';

/*
 * Every 10 minutes: ends billing_v2 holds of the old tools that no request
 * ended (a kie job nobody polled, a settle or release that failed, a request
 * that died before submitting). Reads provider status only; never submits.
 * See lib/legacyHolds.js.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
 */
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers?.authorization || '');
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const summary = await reconcileLegacyHolds();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/legacy-holds] failed', err);
    return res.status(500).json({ error: 'reconcile_failed' });
  }
}
