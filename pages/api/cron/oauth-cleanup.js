import { safeEqual } from '../../../lib/mcp/oauth.js';
import { storyDb } from '../../../lib/story/db.js';

/*
 * Daily cron: deletes expired or dead OAuth rows (consent requests, codes,
 * token pairs, rate-limit counters, metadata fetch failures, unused
 * clients) through story_oauth_cleanup().
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const deleted = await storyDb().rpc('story_oauth_cleanup', {});
    return res.status(200).json({ ok: true, deleted });
  } catch (err) {
    console.error('[cron/oauth-cleanup] failed', err);
    return res.status(500).json({ error: 'cleanup_failed' });
  }
}
