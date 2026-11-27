import { getUserFromRequest } from '../../lib/supabaseServer';
import { getEntitlement } from '../../lib/entitlement';
import { currentPlanFor } from '../../lib/currentPlan.js';
import { planWithin } from '../../lib/planWait.js';
import { isBillingV2 } from '../../lib/billingFlags.js';

// Under billing v2 an old-plan customer's plan, credits and tools live on the classic site.
const CLASSIC_URL = 'https://www.ariyalab.online/';

const PLAN_WAIT_MS = 1500;

// Started alongside getEntitlement (never after it), so it adds no wait of its own beyond the 1.5 s cap on a cache miss.
// Resolves true only when the customer is on an old (legacy) plan with no v2 plan (currentPlanFor reads their own Stripe
// subscriptions, cached per user for a minute). Anything else (slow, failing, throwing) is false and can never touch the entitlement.
function startLegacyLookup(userId) {
  try {
    return planWithin(Promise.resolve().then(() => currentPlanFor(userId)), PLAN_WAIT_MS)
      .then(({ plan }) => plan?.legacy === true)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
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
  const legacyLookup = startLegacyLookup(session.user.id);
  try {
    const ent = await getEntitlement({ supabase: session.supabase, userId: session.user.id, user: session.user });
    const legacyPlan = !(ent?.isAdmin || ent?.tier === 'admin') && (await legacyLookup);
    // Only for an old-plan customer; a failed flag read just leaves it out (never touches the entitlement).
    const classicUrl = legacyPlan && (await isBillingV2().catch(() => false)) ? CLASSIC_URL : undefined;
    return res.status(200).json({ ...ent, legacyPlan, ...(classicUrl ? { classicUrl } : {}) });
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
