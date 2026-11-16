import { safeEqual } from '../../../lib/mcp/oauth.js';
import { runRetention } from '../../../lib/story/retention.js';

/*
 * Daily: deletes the stored files of projects past their files_expire_at
 * (pricing_config retentionDays), never a brand-kit / own file or a key an
 * unexpired project still uses, marks those projects expired, and removes
 * orphaned brand and audio uploads older than a day. See lib/story/retention.js.
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
    const summary = await runRetention();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/story-cleanup] failed', err);
    return res.status(500).json({ error: 'cleanup_failed' });
  }
}
