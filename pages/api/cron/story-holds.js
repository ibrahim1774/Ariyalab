import { safeEqual } from '../../../lib/mcp/oauth.js';
import { sweepStaleHolds } from '../../../lib/story/holdSweeper.js';

/*
 * Every 10 minutes: gives back story credit holds that nothing will end any
 * more (lib/story/holdSweeper.js). Never a hold a job can still settle.
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
    const summary = await sweepStaleHolds();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/story-holds] failed', err);
    return res.status(500).json({ error: 'sweep_failed' });
  }
}
