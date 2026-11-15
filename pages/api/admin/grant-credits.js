import { stripe } from '../../../lib/stripe';
import { getSupabaseAdmin } from '../../../lib/supabaseServer';
import { KEY } from '../../../lib/metaKeys';
import { requireAdmin, findUserByEmail, UserSearchIncompleteError } from '../../../lib/adminGate';
import { isBillingV2Strict } from '../../../lib/billingFlags';
import { grantCredits, RefConflictError } from '../../../lib/credits';
import { runOnce, GrantInProgressError } from '../../../lib/grants';

/*
 * Admin tool to manually grant video credits to a user by email.
 *
 * Gated by lib/adminGate.js (ADMIN_EMAILS must be set and the admin's email
 * confirmed).
 *
 * Body: { email, credits, ref }
 *   - email:   target user email (every page of users is searched)
 *   - credits: positive integer to ADD (max 10000), in the units of the
 *              active credit system (v2 credits when billing_v2 is on)
 *   - ref:     one id per submission (the admin page sends a fresh UUID per
 *              click). A retry with the same ref grants nothing more.
 *
 * A ref is used once across ALL users (lib/grants.js runOnce on
 * `admin-grant:<ref>`): re-sending it, even for another email, grants nothing.
 * billing_v2: a top-up grant in the ledger (reason admin_grant, ref
 * admin:<ref>); no Stripe customer needed. Legacy: adds to this app's credit
 * key on the user's Stripe customer, sending only that key.
 *
 * Returns: { ok, billing, added, ... } or { error, code } (codes: NO_USER,
 * NO_CUSTOMER, NOT_ADMIN).
 */

const REASON = 'admin_grant';
const REF_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const gate = await requireAdmin(req, res);
  if (!gate) return undefined;

  const { email, credits, ref } = req.body || {};
  const targetEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const amount = Number.parseInt(credits, 10);
  if (!targetEmail) return res.status(400).json({ error: 'email required' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
    return res.status(400).json({ error: 'credits must be a positive integer (max 10000)' });
  }
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    return res.status(400).json({ error: 'ref required: one id (8-100 letters, digits, - or _) per submission' });
  }

  try {
    const admin = getSupabaseAdmin();
    let targetUser;
    try {
      targetUser = await findUserByEmail(admin, targetEmail);
    } catch (searchErr) {
      if (!(searchErr instanceof UserSearchIncompleteError)) throw searchErr;
      return res.status(503).json({ error: `${searchErr.message} Nothing was granted.` });
    }
    if (!targetUser) {
      return res.status(404).json({ error: `No Supabase user with email ${targetEmail}.`, code: 'NO_USER' });
    }

    if (await isBillingV2Strict()) {
      try {
        const balance = await runOnce(`admin-grant:${ref}`, () =>
          grantCredits({
            userId: targetUser.id,
            currency: 'video',
            amount,
            bucket: 'topup',
            reason: REASON,
            ref: `admin:${ref}`,
          })
        );
        if (balance === 'already') {
          return res.status(200).json({ ok: true, already: true, billing: 'v2', supabaseUserId: targetUser.id });
        }
        return res.status(200).json({
          ok: true,
          billing: 'v2',
          email: targetUser.email,
          supabaseUserId: targetUser.id,
          added: amount,
          balance,
        });
      } catch (err) {
        if (err instanceof RefConflictError) {
          return res.status(409).json({ error: 'This ref was already used for a different grant. Nothing was granted.' });
        }
        if (err instanceof GrantInProgressError) {
          return res.status(409).json({ error: 'This grant is in progress. Try again in a couple of minutes.' });
        }
        throw err;
      }
    }

    // Legacy: the user's Stripe customer.
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', targetUser.id)
      .maybeSingle();
    if (profileErr) {
      return res.status(500).json({ error: `Profile lookup failed: ${profileErr.message}` });
    }
    const customerId = profile?.stripe_customer_id;
    if (!customerId) {
      return res.status(404).json({
        error: `User has no linked Stripe customer (never subscribed or bought a top-up).`,
        code: 'NO_CUSTOMER',
        supabaseUserId: targetUser.id,
      });
    }

    let outcome;
    try {
      outcome = await runOnce(`admin-grant:${ref}`, async () => {
        const customer = await stripe().customers.retrieve(customerId);
        if (!customer || customer.deleted) return { deleted: true };
        const before = Number.parseInt(customer.metadata?.[KEY.credits] || '0', 10) || 0;
        const after = before + amount;
        await stripe().customers.update(customerId, { metadata: { [KEY.credits]: String(after) } });
        return { before, after };
      });
    } catch (err) {
      if (err instanceof GrantInProgressError) {
        return res.status(409).json({ error: 'This grant is in progress. Try again in a couple of minutes.' });
      }
      throw err;
    }
    if (outcome === 'already') {
      return res.status(200).json({ ok: true, already: true, billing: 'legacy', supabaseUserId: targetUser.id, customerId });
    }
    if (outcome.deleted) {
      return res.status(404).json({ error: 'Stripe customer was deleted.', code: 'NO_CUSTOMER' });
    }
    return res.status(200).json({
      ok: true,
      billing: 'legacy',
      email: targetUser.email,
      supabaseUserId: targetUser.id,
      customerId,
      beforeCredits: outcome.before,
      afterCredits: outcome.after,
      added: amount,
    });
  } catch (err) {
    console.error('[admin/grant-credits] failed', err);
    return res.status(500).json({ error: 'Grant failed. See the server log.' });
  }
}
