import { getPricing, v2Offers } from '../../../lib/pricing.js';
import { isBillingV2 } from '../../../lib/billingFlags.js';

// Public: /app/billing and the old funnel paywalls read this (billingV2 says which offers checkout sells).
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const pricing = await getPricing();
    // What /api/checkout sells under billing v2, from the same config.
    const offers = v2Offers(pricing);
    const billingV2 = await isBillingV2();
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ pricing, billingV2, plans: offers.plans, topups: offers.topups, yearlyDiscount: offers.yearlyDiscount });
  } catch (err) {
    console.error('[api/story/pricing]', err);
    return res.status(500).json({ error: 'Could not load pricing.' });
  }
}
