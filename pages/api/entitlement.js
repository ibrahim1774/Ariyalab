import { getUserFromRequest } from '../../lib/supabaseServer';
import { getEntitlement } from '../../lib/entitlement';
import { currentPlanFor } from '../../lib/currentPlan.js';
import { planWithin } from '../../lib/planWait.js';

const PLAN_WAIT_MS = 3000;

// True when the customer is on an old (legacy) plan and has no v2 plan. currentPlanFor reads the customer's own Stripe
// subscriptions once and keeps the answer per user for a minute, so this costs one cached read, not one per request.
// Admins never count; a slow (over 3 s) or failing lookup answers false, so the customer stays where they are.
async function onLegacyPlan(userId, ent) {
  if (ent?.isAdmin || ent?.tier === 'admin') return false;
  const { plan } = await planWithin(currentPlanFor(userId), PLAN_WAIT_MS);
  return plan?.legacy === true;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) {
    return res.status(200).json({
      tier: 'none',
      videosUsed: 0,
      videoCap: 0,
      creditsRemaining: 0,
      canSwap: false,
      legacyPlan: false,
    });
  }
  try {
    const ent = await getEntitlement({ supabase: session.supabase, userId: session.user.id, user: session.user });
    return res.status(200).json({ ...ent, legacyPlan: await onLegacyPlan(session.user.id, ent) });
  } catch (err) {
    return res.status(200).json({
      tier: 'none',
      videosUsed: 0,
      videoCap: 0,
      creditsRemaining: 0,
      canSwap: false,
      legacyPlan: false,
      error: err.message,
    });
  }
}
