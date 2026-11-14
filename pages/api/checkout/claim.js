import { stripe, planFromPrice, PLANS, CAPS } from '../../../lib/stripe';
import { linkStripeCustomerToProfile, CustomerLinkedElsewhereError } from '../../../lib/entitlement';
import { getUserFromRequest } from '../../../lib/supabaseServer';
import { sendCapiEvent } from '../../../lib/meta';
import { nsEventId } from '../../../lib/metaKeys';
import { checkSessionOwner, grantForCheckoutSession, CLAIM_NONCE_COOKIE } from '../../../lib/grants';

/*
 * Claim a Stripe Checkout Session that was created anonymously
 * (pay-first flow) and bind it to the just-signed-up Supabase user.
 *
 * Requires the caller to be signed in (the brand-new user from the
 * post-payment signup). The caller must own the session
 * (lib/grants.js checkSessionOwner): in this flow that is normally the
 * verified email matching the email Stripe collected. This is the gate
 * that prevents one user from claiming another user's payment.
 *
 * Side effects on success:
 *   - Links profiles.stripe_customer_id <-> the new user (409 when the
 *     customer already belongs to someone else)
 *   - Grants through grantForCheckoutSession (once per session)
 *   - Fires Purchase CAPI event with deduplication id
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Sign in first.' });

  const { session_id: sessionId } = req.query;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'session_id required' });
  }

  try {
    const checkoutSession = await stripe().checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price', 'subscription', 'customer'],
    });

    // Same payment-status hard guard as /api/checkout/confirm.
    const okPaymentStatuses = new Set(['paid', 'no_payment_required']);
    if (!okPaymentStatuses.has(checkoutSession.payment_status)) {
      return res.status(400).json({
        error: `Payment not completed (status: ${checkoutSession.payment_status}).`,
      });
    }

    const customerId =
      typeof checkoutSession.customer === 'string'
        ? checkoutSession.customer
        : checkoutSession.customer?.id;
    if (!customerId) {
      return res.status(400).json({ error: 'Session has no customer.' });
    }

    const customerEmail =
      checkoutSession.customer_details?.email ||
      (typeof checkoutSession.customer === 'object'
        ? checkoutSession.customer?.email
        : null);

    // Security: the caller must own this session (normally: the signed-in
    // user's verified email matches the email Stripe collected).
    const owner = checkSessionOwner(checkoutSession, session.user, {
      claimNonce: req.cookies?.[CLAIM_NONCE_COOKIE],
    });
    if (!owner.ok) {
      return res.status(403).json({
        error: 'Email mismatch. Sign in with the same email you used at checkout.',
      });
    }

    const price = checkoutSession.line_items?.data?.[0]?.price;
    const plan = planFromPrice(price);
    if (!plan) {
      return res.status(400).json({ error: 'Session is not a subscription.' });
    }

    // Authoritative link in our profiles table.
    try {
      await linkStripeCustomerToProfile(session.supabase, session.user.id, customerId);
    } catch (linkErr) {
      if (linkErr instanceof CustomerLinkedElsewhereError) {
        return res.status(409).json({ error: linkErr.message });
      }
      throw linkErr;
    }

    // Seeds plan + credits (legacy) or leaves the grant to the invoice
    // (billing_v2). Already claimed via /confirm or a prior /claim:
    // return success without re-seeding.
    const grant = await grantForCheckoutSession(checkoutSession, {
      userId: session.user.id,
      clearPendingLink: true,
    });
    if (!grant.granted && grant.skipped !== 'granted_per_invoice') {
      return res.status(200).json({
        ok: true,
        alreadyProcessed: true,
        tier: plan,
        videoCap: CAPS[plan],
      });
    }

    const sub = checkoutSession.subscription;
    const value = PLANS[plan].amountCents / 100;
    // Match /api/checkout/confirm.js: a trialing yearly sub fires
    // StartTrial (no charge yet); the real Purchase fires from the
    // Stripe webhook when the post-trial invoice is paid.
    const isTrialingSub = sub?.status === 'trialing';
    const eventName = isTrialingSub ? 'StartTrial' : 'Purchase';
    const eventId = nsEventId(`${isTrialingSub ? 'st' : 'pur'}-${checkoutSession.id}`);
    const reportedValue = isTrialingSub ? 0 : value;
    await sendCapiEvent({
      eventName,
      eventId,
      value: reportedValue,
      currency: 'USD',
      email: customerEmail,
      req,
      customData: {
        kind: 'subscription',
        plan,
        supabase_user_id: session.user.id,
        claim: 1,
      },
    });

    return res.status(200).json({
      ok: true,
      tier: plan,
      videoCap: CAPS[plan],
      meta: { eventId, eventName, value: reportedValue, currency: 'USD' },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
