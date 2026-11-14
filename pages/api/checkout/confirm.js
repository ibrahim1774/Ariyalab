import { stripe, planFromPrice, topupFromPrice, PLANS, CAPS } from '../../../lib/stripe';
import {
  assertCanLink,
  linkStripeCustomerToProfile,
  CustomerLinkedElsewhereError,
} from '../../../lib/entitlement';
import { getUserFromRequest } from '../../../lib/supabaseServer';
import { sendCapiEvent } from '../../../lib/meta';
import { nsEventId } from '../../../lib/metaKeys';
import {
  checkSessionOwner,
  grantForCheckoutSession,
  GrantInProgressError,
  CLAIM_NONCE_COOKIE,
} from '../../../lib/grants';

/*
 * Called by the dashboard when Stripe redirects back after checkout.
 *
 * Order: payment-status guard -> the caller must own the session
 * (lib/grants.js checkSessionOwner: client_reference_id, the buyer id
 * /api/checkout stored, the verified email, or this browser's claim
 * ticket; anything else is 403) -> the purchase must be this app's price
 * (400; haelabs shares the Stripe account) -> the link must be allowed (409
 * when the customer belongs to someone else) -> grant through
 * grantForCheckoutSession, which grants a session exactly once even when
 * the webhook runs at the same moment or the session id is replayed ->
 * link the customer to the caller. Granting before linking keeps the
 * entitlement reader from seeing a linked but unseeded customer.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const { session_id: sessionId } = req.query;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'session_id required' });
  }

  try {
    const checkoutSession = await stripe().checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price', 'subscription', 'customer'],
    });

    // Hard guard: only grant on a session Stripe actually marks as
    // paid (or no_payment_required for trialing subs that haven't
    // been charged yet).
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

    const owner = checkSessionOwner(checkoutSession, session.user, {
      claimNonce: req.cookies?.[CLAIM_NONCE_COOKIE],
    });
    if (!owner.ok) {
      return res.status(403).json({ error: 'This checkout belongs to a different account.' });
    }

    const customerEmail =
      checkoutSession.customer_details?.email ||
      (typeof checkoutSession.customer === 'object'
        ? checkoutSession.customer?.email
        : null) ||
      session.user.email;

    const price = checkoutSession.line_items?.data?.[0]?.price;
    const plan = planFromPrice(price);
    const topup = plan ? null : topupFromPrice(price);
    if (!plan && !topup) {
      return res.status(400).json({ error: 'This checkout is not for an Ariya Lab plan or pack.' });
    }

    try {
      await assertCanLink(session.user.id, customerId);
    } catch (linkErr) {
      if (linkErr instanceof CustomerLinkedElsewhereError) {
        return res.status(409).json({ error: linkErr.message });
      }
      throw linkErr;
    }

    let grant;
    try {
      grant = await grantForCheckoutSession(checkoutSession, { userId: session.user.id });
    } catch (grantErr) {
      // The webhook (or another tab) is granting this session right now and
      // will finish it; Stripe retries the webhook if it fails.
      if (!(grantErr instanceof GrantInProgressError)) throw grantErr;
      grant = { granted: false, inProgress: true };
    }
    const creditsAdded = grant.granted && grant.kind === 'topup' ? grant.amount : 0;

    // Bind Stripe customer <-> Supabase profile (authoritative link).
    try {
      await linkStripeCustomerToProfile(session.supabase, session.user.id, customerId);
    } catch (linkErr) {
      if (linkErr instanceof CustomerLinkedElsewhereError) {
        return res.status(409).json({ error: linkErr.message });
      }
      throw linkErr;
    }

    let eventKind = 'unknown';
    let value;
    if (plan) {
      eventKind = 'subscription';
      value = PLANS[plan].amountCents / 100;
    } else if (topup) {
      eventKind = topup.kind === 'image' ? 'topup-image' : 'topup';
      value = topup.amountCents / 100;
    }

    // Trialing yearly subs paid the $1 trial deposit but not the
    // $49 yet — fire StartTrial with the deposit value. The full
    // $49 Purchase fires from /api/stripe-webhook.js when the trial
    // ends and Stripe bills the first yearly invoice (subscription_
    // cycle).
    const isTrialingSub =
      plan && checkoutSession.subscription?.status === 'trialing';
    const eventName = isTrialingSub ? 'StartTrial' : 'Purchase';
    const eventId = nsEventId(`${isTrialingSub ? 'st' : 'pur'}-${checkoutSession.id}`);
    // Use Stripe's amount_total so we report exactly what was charged
    // today (works for trialing yearly = $1 deposit, monthly = $5,
    // top-ups, and the legacy non-trial flow).
    const actualPaidToday =
      typeof checkoutSession.amount_total === 'number'
        ? checkoutSession.amount_total / 100
        : value;
    const reportedValue = isTrialingSub ? actualPaidToday : value;
    await sendCapiEvent({
      eventName,
      eventId,
      value: reportedValue,
      currency: 'USD',
      email: customerEmail,
      req,
      customData: {
        kind: eventKind,
        plan: plan || undefined,
        pack: topup?.key || undefined,
        supabase_user_id: session.user.id,
      },
    });

    return res.status(200).json({
      ok: true,
      kind: eventKind,
      tier: plan || 'unknown',
      videoCap: plan ? CAPS[plan] : 0,
      creditsAdded,
      ...(grant.inProgress ? { inProgress: true } : {}),
      ...(grant.skipped ? { skipped: grant.skipped } : {}),
      meta: { eventId, eventName, value: reportedValue, currency: 'USD' },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
