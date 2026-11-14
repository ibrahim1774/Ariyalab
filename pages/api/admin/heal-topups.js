import { stripe } from '../../../lib/stripe';
import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer';
import { KEY } from '../../../lib/metaKeys';
import {
  assertCanLink,
  linkStripeCustomerToProfile,
  CustomerLinkedElsewhereError,
  UnfinishedMergeError,
} from '../../../lib/entitlement';
import { grantForCheckoutSession, GrantInProgressError } from '../../../lib/grants';

/*
 * Admin tool to fix orphaned top-up credits.
 *
 * The bug we're healing: a top-up payment lands credits on a Stripe
 * customer that the user's Supabase profile is not linked to. This
 * happens when /api/checkout/confirm is skipped (user closes the tab
 * before redirect, has no session cookie, etc.) and only the webhook
 * fallback runs — that path grants credits but never wrote
 * stripe_customer_id back to profiles before the recent fix.
 *
 * Inputs:
 *   { email }                — find Supabase user by email + Stripe
 *                              customers by email and report state.
 *   { sessionId }            — load a specific Checkout session, find
 *                              its customer, find the user by the email on
 *                              the payment. Add { email } to link the
 *                              session's customer to THAT account instead
 *                              (a buyer who paid with another email).
 *   { dryRun: false }        — actually relink. Defaults to dryRun: true
 *                              so the first call always shows what
 *                              would change without changing anything.
 *   { customerId: "cus_..." } — when multiple Stripe customers exist
 *                              for the same email, force which one to
 *                              link (review dryRun output, then call
 *                              again with this).
 *
 * Returns a structured report with all candidate customers, current
 * link state, credits available, and what the heal action would (or
 * did) do. Idempotent — running it twice with dryRun: false on the
 * same already-linked profile is a no-op that re-reports the state.
 *
 * This is also the support merge: when the user's profile already points at
 * another live customer, the link goes through linkStripeCustomerToProfile
 * with `via: 'admin'`, the only caller allowed to move a profile while
 * relink_mode is 'support' (lib/entitlement.js). It moves this app's credit
 * balances off the old customer (legacy mode), copies the other metadata
 * keys the new customer lacks, and under billing_v2 delivers the grants
 * parked for the new customer. Refused when the old customer still has a
 * subscription or the copy would not fit Stripe's metadata limits.
 *
 * With a sessionId the merge runs in the same order as the customer paths:
 * checks, then the grant for that checkout session (lib/grants.js, once per
 * session), then the move and the link. A customer who re-opens their claim
 * or confirm link afterwards finds the session already done.
 *
 * Ownership evidence. The dry run (and every refusal) shows the payment's
 * email, payment status, client_reference_id, metadata.supabase_user_id,
 * whether a claim ticket exists, the target account's email and whether it
 * is confirmed, and the proof that ties the two: 'client_reference_id',
 * 'metadata', 'email' (payment email equals the account's CONFIRMED email)
 * or 'none'. With 'none' the link needs { overrideOwnership: true, reason }:
 * the reason is logged and written to the new customer's metadata
 * (ariyalab_admin_override_reason). A session that is not paid is refused.
 *
 *   { forceAbandonEarlierMerge: true } — only for the 409 that names an
 *                              unfinished earlier merge whose target no
 *                              longer exists or no longer points back: gives
 *                              up that carry (recorded on the old customer
 *                              as ariyalab_relink_abandoned) and merges.
 *
 * Gated by ADMIN_EMAILS (must be set; there is no built-in fallback, the
 * route answers 503 without it) and the admin's email must be confirmed.
 */

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const SESSION_EXPAND = ['line_items.data.price', 'subscription', 'customer'];
const RETRY_MESSAGE = 'A grant or merge for this customer is in progress. Try again in a couple of minutes.';

function summarizeCustomer(customer) {
  if (!customer || customer.deleted) return null;
  const md = customer.metadata || {};
  return {
    id: customer.id,
    email: customer.email,
    creditsRemaining: Number.parseInt(md[KEY.credits] || '0', 10) || 0,
    supabaseUserId: md.supabase_user_id || null,
    processedSessions: (md[KEY.processedSessions] || '').split(',').filter(Boolean),
    plan: md[KEY.plan] || null,
  };
}

// The project is shared with haelabs.live, so the user list is long: read
// every page. "Not found" is only answered after the last page; if the page
// bound is ever hit the search is reported as incomplete, never as "no user".
const USERS_PER_PAGE = 1000;
const MAX_USER_PAGES = 200;
class UserSearchIncompleteError extends Error {}

async function findUserByEmail(admin, email) {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`User lookup failed: ${error.message}`);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === wanted);
    if (hit) return hit;
    if (users.length < USERS_PER_PAGE) return null;
  }
  throw new UserSearchIncompleteError();
}

const lower = (v) => String(v || '').trim().toLowerCase();

// What ties the payment to the target account (see the file header).
function ownershipEvidence({ cs, paymentEmail, user }) {
  const emailConfirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
  let ownershipProof = 'none';
  if (cs?.client_reference_id && cs.client_reference_id === user.id) ownershipProof = 'client_reference_id';
  else if (cs?.metadata?.supabase_user_id && cs.metadata.supabase_user_id === user.id) ownershipProof = 'metadata';
  else if (emailConfirmed && paymentEmail && lower(paymentEmail) === lower(user.email)) ownershipProof = 'email';
  return {
    payment: cs
      ? {
          sessionId: cs.id,
          email: lower(paymentEmail) || null,
          paymentStatus: cs.payment_status || null,
          clientReferenceId: cs.client_reference_id || null,
          metadataSupabaseUserId: cs.metadata?.supabase_user_id || null,
          hasClaimTicket: Boolean(cs.metadata?.claim_ticket),
        }
      : null,
    paymentEmail: lower(paymentEmail) || null,
    account: { id: user.id, email: user.email, emailConfirmed },
    ownershipProof,
    needsOverride: ownershipProof === 'none',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admins = adminEmails();
  if (!admins.length) {
    return res.status(503).json({ error: 'Admin tools are disabled: ADMIN_EMAILS is not set.' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const callerEmail = (session.user.email || '').toLowerCase();
  const callerConfirmed = Boolean(session.user.email_confirmed_at || session.user.confirmed_at);
  if (!callerConfirmed || !admins.includes(callerEmail)) {
    return res.status(403).json({ error: 'Admin only.', code: 'NOT_ADMIN' });
  }

  const {
    email,
    sessionId,
    customerId: forcedCustomerId,
    dryRun,
    overrideOwnership,
    reason,
    forceAbandonEarlierMerge,
  } = req.body || {};
  const overrideReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  const isDryRun = dryRun !== false; // default true
  const targetEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!targetEmail && !targetSessionId) {
    return res.status(400).json({ error: 'email or sessionId required' });
  }

  try {
    const admin = getSupabaseAdmin();

    let resolvedEmail = targetEmail;
    let candidateCustomerIds = [];
    let cs = null;
    let sessionEmail = '';

    // Path A: session id — pull customer + email straight from Stripe.
    if (targetSessionId) {
      cs = await stripe().checkout.sessions.retrieve(targetSessionId, { expand: SESSION_EXPAND });
      const cid = typeof cs.customer === 'string' ? cs.customer : cs.customer?.id;
      if (!cid) {
        return res.status(404).json({ error: 'Session has no customer attached.' });
      }
      candidateCustomerIds = [cid];
      sessionEmail = lower(
        cs.customer_details?.email || (typeof cs.customer === 'object' ? cs.customer?.email : '') || cs.customer_email
      );
      // An explicit `email` names the account to link (the buyer may have
      // typed another email at Stripe); otherwise the email on the payment.
      resolvedEmail = targetEmail || sessionEmail;
    }

    // Path B: email — find every Stripe customer that matches.
    if (!candidateCustomerIds.length && resolvedEmail) {
      const list = await stripe().customers.list({ email: resolvedEmail, limit: 10 });
      candidateCustomerIds = list.data.map((c) => c.id);
    }

    if (!candidateCustomerIds.length) {
      return res.status(404).json({
        error: `No Stripe customer found for ${resolvedEmail || targetSessionId}`,
      });
    }

    // Find the Supabase user (must exist for us to relink to anything).
    let user;
    try {
      user = await findUserByEmail(admin, resolvedEmail);
    } catch (searchErr) {
      if (!(searchErr instanceof UserSearchIncompleteError)) throw searchErr;
      console.error('[admin/heal-topups] user search hit the page bound', MAX_USER_PAGES * USERS_PER_PAGE);
      return res.status(503).json({
        error: `Account search incomplete: more than ${MAX_USER_PAGES * USERS_PER_PAGE} users were read without finding ${resolvedEmail}. Nothing was changed.`,
      });
    }
    if (!user) {
      return res.status(404).json({
        error: `No Supabase user with email ${resolvedEmail}. Heal aborted.`,
        candidateCustomers: candidateCustomerIds,
      });
    }

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();
    const currentlyLinked = profile?.stripe_customer_id || null;

    // Pull each candidate customer's state for the report.
    const candidates = await Promise.all(
      candidateCustomerIds.map(async (id) => {
        try {
          const c = await stripe().customers.retrieve(id);
          return summarizeCustomer(c);
        } catch {
          return { id, error: 'retrieve failed' };
        }
      })
    );
    const usableCandidates = candidates.filter(Boolean);

    // Decide which customer to link.
    let targetCustomerId = null;
    if (forcedCustomerId) {
      if (!candidateCustomerIds.includes(forcedCustomerId)) {
        return res.status(400).json({
          error: 'forcedCustomerId is not among the candidates for this email.',
          candidates: usableCandidates,
        });
      }
      targetCustomerId = forcedCustomerId;
    } else if (usableCandidates.length === 1) {
      targetCustomerId = usableCandidates[0].id;
    } else {
      // Pick the one with the most credits as the default suggestion,
      // but require an explicit forcedCustomerId to actually heal when
      // there's ambiguity.
      const sorted = [...usableCandidates].sort(
        (a, b) => (b.creditsRemaining || 0) - (a.creditsRemaining || 0)
      );
      const suggestion = sorted[0]?.id || null;
      return res.status(409).json({
        ambiguous: true,
        message: `Multiple Stripe customers for ${resolvedEmail}. Re-run with customerId set to one of them.`,
        suggestion,
        currentlyLinked,
        candidates: usableCandidates,
      });
    }

    const targetSummary = usableCandidates.find((c) => c.id === targetCustomerId) || null;
    const willChange = currentlyLinked !== targetCustomerId;
    const evidence = ownershipEvidence({ cs, paymentEmail: cs ? sessionEmail : targetSummary?.email, user });

    if (cs && cs.payment_status !== 'paid') {
      return res.status(400).json({
        error: `This checkout session is not paid (status: ${cs.payment_status}). Nothing was changed.`,
        ...evidence,
      });
    }

    if (!willChange) {
      return res.status(200).json({
        ok: true,
        message: 'Profile is already linked to this customer. No action needed.',
        email: resolvedEmail,
        supabaseUserId: user.id,
        currentlyLinked,
        targetCustomerId,
        targetCustomer: targetSummary,
        dryRun: isDryRun,
        ...evidence,
      });
    }

    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        message:
          'Dry run only — re-run with { dryRun: false } to apply. Will change the profile link from currentlyLinked → targetCustomerId.',
        email: resolvedEmail,
        supabaseUserId: user.id,
        currentlyLinked,
        targetCustomerId,
        targetCustomer: targetSummary,
        otherCandidates: usableCandidates.filter((c) => c.id !== targetCustomerId),
        ...evidence,
      });
    }

    // Nothing ties this payment to this account: the admin must say why.
    const overridden = evidence.needsOverride;
    if (overridden && !(overrideOwnership === true && overrideReason)) {
      return res.status(409).json({
        error:
          'Nothing ties this payment to this account (no reference id, no metadata, and the payment email is not the account\'s confirmed email). To link anyway, send overrideOwnership: true and a reason.',
        ...evidence,
      });
    }
    if (overridden) {
      console.warn(
        '[admin/heal-topups] ownership override by', callerEmail,
        'account', user.id, 'customer', targetCustomerId, 'reason:', overrideReason
      );
    }

    // Same order as the customer paths: checks, grant, then move + link.
    let grant = null;
    try {
      await assertCanLink(user.id, targetCustomerId, { via: 'admin' });
      if (cs) {
        grant = await grantForCheckoutSession(cs, {
          userId: user.id,
          clearPendingLink: cs.metadata?.pending_supabase_link === 'true',
        });
      }
      await linkStripeCustomerToProfile(admin, user.id, targetCustomerId, {
        via: 'admin',
        forceAbandonEarlierMerge: forceAbandonEarlierMerge === true,
      });
    } catch (mergeErr) {
      if (mergeErr instanceof UnfinishedMergeError) {
        const u = mergeErr.unfinishedMerge;
        return res.status(409).json({
          error:
            `An earlier merge from ${u.from} to ${u.to} did not finish: ${u.from} was emptied and ${u.to} was never credited (video:image owed ${u.carry}). ` +
            (u.canAbandon
              ? `${u.to} no longer exists or no longer points back, so that merge cannot finish. Send forceAbandonEarlierMerge: true to record the carry as abandoned and merge; give the customer those credits by hand.`
              : `Finish that merge first by running this tool for ${u.to}.`),
          unfinishedMerge: u,
        });
      }
      if (mergeErr instanceof CustomerLinkedElsewhereError) {
        return res.status(409).json({ error: mergeErr.message, ...evidence });
      }
      if (mergeErr instanceof GrantInProgressError) {
        return res.status(409).json({ error: RETRY_MESSAGE, retryable: true });
      }
      throw mergeErr;
    }

    // Backfill supabase_user_id on the customer so webhook-only paths can
    // self-heal, and record an ownership override. Only the changed keys are
    // sent (Stripe merges metadata).
    try {
      const cust = await stripe().customers.retrieve(targetCustomerId);
      if (cust && !cust.deleted) {
        const patch = {};
        if ((cust.metadata || {}).supabase_user_id !== user.id) patch.supabase_user_id = user.id;
        if (overridden) patch[KEY.adminOverrideReason] = overrideReason;
        if (Object.keys(patch).length) await stripe().customers.update(targetCustomerId, { metadata: patch });
      }
    } catch (mdErr) {
      console.warn('[admin/heal-topups] metadata backfill failed', mdErr.message);
    }

    return res.status(200).json({
      ok: true,
      dryRun: false,
      message: 'Profile relinked.',
      email: resolvedEmail,
      supabaseUserId: user.id,
      previouslyLinked: currentlyLinked,
      nowLinked: targetCustomerId,
      grant: grant ? { granted: grant.granted, already: grant.already, pending: grant.pending, skipped: grant.skipped } : null,
      ...evidence,
    });
  } catch (err) {
    console.error('[admin/heal-topups] failed', err);
    return res.status(500).json({ error: 'Heal failed. See the server log.' });
  }
}
