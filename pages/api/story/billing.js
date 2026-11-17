import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer.js';
import { getEntitlement } from '../../../lib/entitlement.js';
import { getBalance } from '../../../lib/credits.js';
import { isBillingV2 } from '../../../lib/billingFlags.js';
import { PLANS, TOPUPS } from '../../../lib/stripe.js';

const HISTORY_LIMIT = 50;

// What the existing /api/checkout actually sells today (lib/stripe.js), for the
// page to show while billing v2 is off.
function legacyOffers() {
  const plans = {};
  for (const [key, p] of Object.entries(PLANS)) {
    plans[key] = { usd: p.amountCents / 100, credits: p.cap, interval: p.interval };
  }
  const topups = {};
  for (const [key, t] of Object.entries(TOPUPS)) {
    if (t.kind === 'video') topups[key] = { usd: t.amountCents / 100, credits: t.credits };
  }
  return { plans, topups };
}

/*
 * GET /api/story/billing -> { v2, balance, history }
 *
 * v2 on: balance split from the credit ledger, plus the caller's last 50
 * ledger rows. Zero-delta rows (partial releases and other bookkeeping) are
 * left out. v2 off: one number, taken from the existing entitlement.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });
  const userId = session.user.id;

  try {
    if (!(await isBillingV2())) {
      const ent = await getEntitlement({ supabase: session.supabase, userId, user: session.user });
      return res.status(200).json({
        v2: false,
        balance: { plan: null, topup: null, held: 0, available: ent?.creditsRemaining ?? 0 },
        history: [],
        offers: legacyOffers(),
      });
    }

    const balance = await getBalance(userId, 'video');
    const { data, error } = await getSupabaseAdmin()
      .from('credit_ledger')
      .select('id, created_at, delta, reason, balance_after')
      .eq('user_id', userId)
      .eq('currency', 'video')
      .neq('delta', 0)
      // The bigserial id follows the order rows were applied under the account lock (credit_apply), which is the order of the
      // running balance_after. created_at is not reliable for this: rows of one account written back to back can carry
      // timestamps in the opposite order, so it is only selected for display.
      .order('id', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    return res.status(200).json({ v2: true, balance, history: data || [] });
  } catch (err) {
    console.error('[api/story/billing]', err);
    return res.status(500).json({ error: 'Could not load billing.' });
  }
}
