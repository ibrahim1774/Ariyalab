import { stripe, planFromPrice } from './stripe';
import { KEY } from './metaKeys';
import { isBillingV2Strict } from './billingFlags';
import { isConfirmedAdmin } from './adminEmails';
import { getBalance, callCreditFunction } from './credits';
import {
  PAID_TIERS,
  usesLedger,
  profileCustomerId,
  reserveV2,
  attachReservation,
  settleReservation,
  refundV2,
  assertNotMigrated,
} from './entitlementV2';

/*
 * Image credits (/api/glow-up, /api/interior-design): a pool apart from video
 * credits. Any active or trialing subscriber of ours gets IMAGE_REFILL
 * credits every 30 days; image packs add to it.
 *
 * billing_v2: currency 'image' in the ledger. Every 30-day window (anchored
 * on the Stripe customer's creation) the plan bucket is RESET to
 * IMAGE_REFILL (credit_reset_plan, ref `image-refill:<customer>:<window>`):
 * no rollover, as before, and purchased (topup) image credits are never
 * touched. A generation holds 1 credit (recorded like every old-tool hold,
 * lib/legacyHolds.js), spent with ref `legacy:<route>:<kie task id>` once
 * the image exists and released on failure. Nothing is written to Stripe.
 *
 * Legacy: Stripe metadata as before, except that the refill no longer
 * resets the pool to IMAGE_REFILL (which wiped purchased packs): it raises
 * the pool to IMAGE_REFILL when it is below that and otherwise leaves it as
 * it is. Writes send only this app's two image keys (Stripe merges
 * metadata). A customer moved by the legacy migration is refused here.
 *
 * Only subscriptions with one of this app's prices count (the customer may
 * also subscribe to haelabs.live on the same Stripe customer).
 */
export const IMAGE_REFILL = 30;
const IMAGE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const imageInt = (v) => parseInt(v || '0', 10) || 0;

async function ourActiveSub(customerId) {
  const subs = await stripe().subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
    expand: ['data.items.data.price'],
  });
  return (
    subs.data.find(
      (x) => (x.status === 'active' || x.status === 'trialing') && planFromPrice(x.items?.data?.[0]?.price)
    ) || null
  );
}

/**
 * The image-credit entitlement of the session user. Pass the session `user`
 * (admin check). Shape: { tier, status, imageCreditsRemaining,
 * imagePeriodStart, activeSub, isAdmin?, billing } plus what reserve needs.
 */
export async function getImageEntitlement({ supabase, userId, user }) {
  if (isConfirmedAdmin(user)) {
    return { tier: 'admin', status: 'admin', isAdmin: true, imageCreditsRemaining: 9999, imagePeriodStart: Date.now(), activeSub: { id: 'admin' } };
  }
  const v2 = await isBillingV2Strict();
  const customerId = userId ? await profileCustomerId(supabase, userId) : null;
  const empty = {
    billing: v2 ? 'v2' : 'legacy',
    userId,
    customerId,
    tier: 'none',
    status: 'none',
    imageCreditsRemaining: 0,
    imagePeriodStart: Date.now(),
    activeSub: null,
  };
  if (!customerId) return empty;
  return v2 ? imageEntitlementV2(empty) : imageEntitlementLegacy(empty);
}

async function imageEntitlementV2(base) {
  const activeSub = await ourActiveSub(base.customerId);
  const plan = activeSub ? planFromPrice(activeSub.items?.data?.[0]?.price) : null;
  let imagePeriodStart = base.imagePeriodStart;
  if (plan) {
    const customer = await stripe().customers.retrieve(base.customerId);
    const anchorMs = (customer?.created || activeSub.start_date || 0) * 1000;
    const window = Math.max(0, Math.floor((Date.now() - anchorMs) / IMAGE_PERIOD_MS));
    imagePeriodStart = anchorMs + window * IMAGE_PERIOD_MS;
    await callCreditFunction('credit_reset_plan', {
      p_user: base.userId,
      p_currency: 'image',
      p_allotment: IMAGE_REFILL,
      p_ref: `image-refill:${base.customerId}:${window}`,
    });
  }
  const balance = await getBalance(base.userId, 'image');
  return {
    ...base,
    tier: plan || 'none',
    status: activeSub?.status || 'none',
    activeSub: plan ? activeSub : null,
    imageCreditsRemaining: Number(balance?.available || 0),
    imagePeriodStart,
  };
}

async function imageEntitlementLegacy(base) {
  const customer = await stripe().customers.retrieve(base.customerId);
  if (!customer || customer.deleted) return base;
  const md = customer.metadata || {};
  const plan = md[KEY.plan] || null;
  const activeSub = await ourActiveSub(base.customerId);
  const status = activeSub?.status || 'none';
  if (!PAID_TIERS.has(plan) || !activeSub) {
    return { ...base, tier: plan || 'none', status, md };
  }
  const now = Date.now();
  const periodStart = imageInt(md[KEY.imagePeriodStart]);
  let imageCredits = imageInt(md[KEY.imageCredits]);
  let nextPeriodStart = periodStart;
  if (!periodStart || now - periodStart >= IMAGE_PERIOD_MS) {
    imageCredits = Math.max(imageCredits, IMAGE_REFILL);
    nextPeriodStart = now;
  }
  return {
    ...base,
    tier: plan,
    status,
    activeSub,
    md,
    imageCreditsRemaining: imageCredits,
    imagePeriodStart: nextPeriodStart,
  };
}

/**
 * Takes 1 image credit for a generation. Returns false (charge nothing) when
 * the pool is empty. The caller must then attachImageJob once kie accepted
 * the task, and settleImageCredit on success or refundImageCredit on failure.
 * Throws MigratedToV2Error (code 'MIGRATED') on the legacy path for a
 * migrated customer.
 */
export async function reserveImageCredit(ent, { route } = {}) {
  if (ent?.isAdmin) return true;
  if (usesLedger(ent)) {
    try {
      await reserveV2(ent, 1, route || 'image-tool', 'image');
    } catch (err) {
      if (err.code === 'INSUFFICIENT') return false;
      throw err;
    }
    ent.imageCreditsRemaining = Math.max(0, ent.imageCreditsRemaining - 1);
    return true;
  }
  if (!ent.md || ent.imageCreditsRemaining <= 0) return false;
  await assertNotMigrated(ent.customerId);
  const next = ent.imageCreditsRemaining - 1;
  await stripe().customers.update(ent.customerId, {
    metadata: { [KEY.imageCredits]: String(next), [KEY.imagePeriodStart]: String(ent.imagePeriodStart) },
  });
  ent.imageCreditsRemaining = next;
  ent.imageReserved = true;
  return true;
}

/** kie accepted the task: record it with the hold (billing_v2). */
export async function attachImageJob(ent, taskId) {
  await attachReservation(ent, { provider: 'kie-image', jobId: taskId });
}

/** The generation succeeded: spend the hold (billing_v2; a failure is recorded for retry). No-op on the legacy path. */
export async function settleImageCredit(ent, jobId) {
  await settleReservation(ent, jobId);
}

/** The generation failed: give the credit back. Never throws. */
export async function refundImageCredit(ent) {
  try {
    if (usesLedger(ent)) {
      if (!ent.hold) return;
      await refundV2(ent);
      ent.imageCreditsRemaining += 1;
      return;
    }
    if (!ent?.imageReserved) return;
    ent.imageReserved = false;
    // Re-read so a parallel write is not stomped; send only the changed key.
    const fresh = await stripe().customers.retrieve(ent.customerId);
    const freshMd = fresh && !fresh.deleted ? fresh.metadata || {} : {};
    const patch = { [KEY.imageCredits]: String(imageInt(freshMd[KEY.imageCredits]) + 1) };
    if (freshMd[KEY.imagePeriodStart] == null) patch[KEY.imagePeriodStart] = String(ent.imagePeriodStart);
    await stripe().customers.update(ent.customerId, { metadata: patch });
    ent.imageCreditsRemaining += 1;
  } catch (err) {
    console.warn('[entitlement] image credit refund failed', err.message);
  }
}
