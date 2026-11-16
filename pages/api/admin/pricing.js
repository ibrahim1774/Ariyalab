import { requireAdmin } from '../../../lib/adminGate.js';
import { getPricing, readPricingRowsFresh, writePricingConfig } from '../../../lib/pricing.js';
import { DEFAULTS, PROVIDER_COSTS_USD } from '../../../lib/pricingConstants.js';
import { pricingReadout, validatePricingWrite, EDITABLE } from '../../../lib/adminPricing.js';

/*
 * Admin pricing editor (admins only: lib/adminGate.js, 401/403/503 otherwise).
 *
 * GET  -> { rows, pricing, defaults, providerCosts, readout, billingV2, editable }
 *         rows: the pricing_config rows as stored; pricing: what the app uses
 *         (defaults merged with the rows); readout: cost per credit, margin per
 *         quality, drift from the homepage's static defaults.
 * POST { key, value, confirm? } -> the same, after writing one row.
 *         Turning billing_v2 on needs confirm: 'billing_v2' (once the legacy
 *         migration ran with --apply it must stay on: docs/go-live.md).
 *         A changed plan or pack price is a NEW Stripe price at the next
 *         checkout; subscribers keep the price (and credits) they bought.
 *         This instance re-reads at once; other instances within 60 s.
 */
async function snapshot() {
  const rows = await readPricingRowsFresh();
  const pricing = await getPricing();
  const flag = rows.find((r) => r.key === 'billing_v2');
  return {
    rows,
    pricing,
    defaults: DEFAULTS,
    providerCosts: PROVIDER_COSTS_USD,
    readout: pricingReadout(pricing),
    billingV2: flag?.value === true,
    editable: Object.keys(EDITABLE),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return undefined;

  try {
    if (req.method === 'POST') {
      const { key, value, confirm } = req.body || {};
      const problem = validatePricingWrite(key, value);
      if (problem) return res.status(400).json({ error: problem });
      if (key === 'billing_v2' && value === true && confirm !== 'billing_v2') {
        return res.status(400).json({ error: 'Turning billing v2 on needs confirm: "billing_v2".', code: 'CONFIRM_REQUIRED' });
      }
      await writePricingConfig(key, value);
      console.info('[admin/pricing] write', admin.user.email, key, JSON.stringify(value));
    }
    return res.status(200).json(await snapshot());
  } catch (err) {
    console.error('[admin/pricing]', err);
    return res.status(500).json({ error: 'Could not read or write pricing.' });
  }
}
