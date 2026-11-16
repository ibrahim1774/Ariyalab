import { stripe } from '../../../lib/stripe';
import { getUserFromRequest } from '../../../lib/supabaseServer';
import { customerForUser } from '../../../lib/grants';

/*
 * POST /api/billing/portal -> { url }
 *
 * A Stripe customer portal session for the signed-in buyer's OWN Stripe
 * customer (profiles.stripe_customer_id, read with the service role): plan
 * changes, cancel, card and invoices. The customer id never comes from the
 * request. 401 signed out, 404 when the account has no Stripe customer yet.
 *
 * The portal's configuration (which plans can be switched to, proration,
 * downgrades at period end) is set in the Stripe dashboard and is
 * account-wide: the Stripe account is shared with haelabs.live (see
 * docs/go-live.md).
 */
function appOrigin(req) {
  const app = process.env.APP_URL && process.env.APP_URL.replace(/\/$/, '');
  return app || `https://${req.headers?.host}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session?.user) return res.status(401).json({ error: 'Sign in to manage billing.' });
  try {
    const customer = await customerForUser(session.user.id);
    if (!customer) return res.status(404).json({ error: 'There is no billing account yet. Choose a plan first.', code: 'NO_CUSTOMER' });
    const portal = await stripe().billingPortal.sessions.create({ customer, return_url: `${appOrigin(req)}/app/billing` });
    return res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error('[billing/portal] failed', err);
    return res.status(500).json({ error: 'Could not open billing. Please try again.' });
  }
}
