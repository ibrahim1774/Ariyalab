import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer.js';
import { getEntitlement } from '../../../lib/entitlement.js';
import { getBalance } from '../../../lib/credits.js';
import { isBillingV2 } from '../../../lib/billingFlags.js';

const HISTORY_LIMIT = 50;

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
      const ent = await getEntitlement({ supabase: session.supabase, userId, email: session.user.email });
      return res.status(200).json({
        v2: false,
        balance: { plan: null, topup: null, held: 0, available: ent?.creditsRemaining ?? 0 },
        history: [],
      });
    }

    const balance = await getBalance(userId, 'video');
    const { data, error } = await getSupabaseAdmin()
      .from('credit_ledger')
      .select('created_at, delta, reason, balance_after')
      .eq('user_id', userId)
      .eq('currency', 'video')
      .neq('delta', 0)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    return res.status(200).json({ v2: true, balance, history: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not load billing.' });
  }
}
