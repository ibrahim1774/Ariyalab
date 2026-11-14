import { getPricing, PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT } from '../../../lib/pricing.js';

// Public: the marketing pricing section and /app/billing both read this.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const pricing = await getPricing();
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ pricing, plans: PLANS_V2, topups: TOPUPS_V2, yearlyDiscount: YEARLY_DISCOUNT });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not load pricing.' });
  }
}
