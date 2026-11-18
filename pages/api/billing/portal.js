import { stripe } from '../../../lib/stripe';
import { getUserFromRequest } from '../../../lib/supabaseServer';
import { customerForUser } from '../../../lib/grants';
import { isBillingV2Strict } from '../../../lib/billingFlags';
import { getPricing } from '../../../lib/pricing';
import { getOrCreatePortalConfiguration } from '../../../lib/stripePortal';
import { currentPlanFor } from '../../../lib/currentPlan';
import { planWithin } from '../../../lib/planWait';

/*
 * POST /api/billing/portal -> { url }
 *
 * A Stripe customer portal session for the signed-in buyer's OWN Stripe
 * customer (profiles.stripe_customer_id, read with the service role): plan
 * changes, cancel, card and invoices. The customer id never comes from the
 * request. 401 signed out, 404 when the account has no Stripe customer yet.
 *
 * Billing v2 on: the session names this app's OWN portal configuration
 * (lib/stripePortal.js, one of two variants by the customer's plan interval: only the Ariya v2 plan prices, upgrades invoiced at
 * once, downgrades at period end). Without one Stripe would use the account
 * default, which belongs to another product on the shared Stripe account, so
 * when the configuration cannot be made this answers the plain failure line and
 * never opens the portal. Billing v2 off: no configuration, as before.
 */
// Where Stripe sends the customer back. Never from the request's Host header
// (a forged Host would turn the portal into an open redirect): APP_URL, or in
// development http://localhost:3000. null in production without APP_URL.
function returnOrigin() {
  const app = process.env.APP_URL && process.env.APP_URL.trim().replace(/\/$/, '');
  if (app) return app;
  return process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session?.user) return res.status(401).json({ error: 'Sign in to manage billing.' });
  const origin = returnOrigin();
  if (!origin) {
    console.error('[billing/portal] APP_URL is not set');
    return res.status(500).json({ error: "We couldn't open billing. Please try again in a moment." });
  }
  try {
    const customer = await customerForUser(session.user.id);
    if (!customer) return res.status(404).json({ error: 'There is no billing account yet. Choose a plan first.', code: 'NO_CUSTOMER' });
    const client = stripe();
    let configuration = null;
    if (await isBillingV2Strict()) {
      // A customer who is POSITIVELY known to be on a yearly Ariya plan gets the yearly-only configuration, so a shorter
      // interval cannot be chosen. Anything else (monthly, no plan, legacy, lookup failed or slow) gets the full one.
      const looked = await planWithin(currentPlanFor(session.user.id, { fresh: true }), 3000);
      const yearly = !looked.unknown && looked.plan && !looked.plan.legacy && looked.plan.interval === 'year';
      configuration = await getOrCreatePortalConfiguration(client, await getPricing(), { variant: yearly ? 'yearly' : 'all' });
    }
    const portal = await client.billingPortal.sessions.create({
      customer,
      // The marker makes /app/billing read the plan fresh (the buyer may just have changed or cancelled it here).
      return_url: `${origin}/app/billing?from=portal`,
      ...(configuration ? { configuration } : {}),
    });
    return res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error('[billing/portal] failed', err);
    return res.status(500).json({ error: "We couldn't open billing. Please try again in a moment." });
  }
}
