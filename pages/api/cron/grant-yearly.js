import { safeEqual } from '../../../lib/mcp/oauth.js';
import { grantYearlyMonths } from '../../../lib/grants.js';

/*
 * Daily: grants each running yearly billing-v2 subscription the months that
 * are due (months 1..11 of its period, counted from the subscription's own
 * anchor; month 0 is granted with the invoice). Each month is renewPlanCredits
 * with ref yearly:<subId>:<YYYY-MM>, so a repeat run or a retry grants
 * nothing twice. See lib/grants.js grantYearlyMonths.
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
    const summary = await grantYearlyMonths();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/grant-yearly] failed', err);
    return res.status(500).json({ error: 'grant_failed' });
  }
}
