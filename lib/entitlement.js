import { stripe, CAPS, TRIAL_CREDITS, planFromPrice } from './stripe';
import { KEY } from './metaKeys';
import { isBillingV2Strict, relinkModeStrict } from './billingFlags';
import { isConfirmedAdmin } from './adminEmails';
import {
  usersForCustomer,
  customerForUser,
  claimPendingGrants,
  linkCustomerAtomically,
  runOnce,
  withLock,
  GrantInProgressError,
} from './grants';
import { RefConflictError } from './credits';
import {
  usesLedger,
  profileCustomerId,
  getEntitlementV2,
  reserveV2,
  refundV2,
  decrementV2,
  refundLegacyJobInLedger,
  getSwapUseV2,
  claimSwapUseV2,
  unclaimSwapUseV2,
  recordSwapUseV2,
  assertNotMigrated,
} from './entitlementV2';

// The billing_v2 adapter lives in lib/entitlementV2.js and the image-credit
// entitlement in lib/imageEntitlement.js; both are re-exported here so the
// routes keep one import path.
export {
  usesLedger,
  attachReservation,
  takeHoldForJob,
  settleReservation,
  settleHeldJob,
  MigratedToV2Error,
} from './entitlementV2';
export {
  IMAGE_REFILL,
  getImageEntitlement,
  reserveImageCredit,
  attachImageJob,
  settleImageCredit,
  refundImageCredit,
} from './imageEntitlement';

// Read how many trial credits the user has consumed so far. Backwards-
// compatible with the legacy binary `trialUsed='1'` flag — old trial
// users who already used their 1-shot trial are treated as having
// consumed 1 credit.
function readTrialUsed(md) {
  const explicit = parseInt(md?.[KEY.trialCreditsUsed] || '', 10);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (md?.[KEY.trialUsed] === '1') return 1;
  return 0;
}

/*
 * Admin accounts bypass the credit system entirely: getEntitlement returns an
 * "admin" tier with effectively unlimited credits, and reserveCredits /
 * refundCredits no-op. That is real provider spend, so an admin is a USER
 * whose CONFIRMED email is in ADMIN_EMAILS (lib/adminEmails.js); there is no
 * built-in address and an email string alone never qualifies.
 */
function adminEntitlement() {
  return {
    tier: 'admin',
    status: 'admin',
    [KEY.credits]: 9999,
    videoCap: 9999,
    videosUsed: 0,
    canSwap: true,
    isAdmin: true,
  };
}

/*
 * Supabase-backed entitlement. Identity = Supabase user.id. We look
 * up their `stripe_customer_id` in the profiles table, then read the
 * Stripe subscription + customer metadata as before.
 *
 * All previous cookie-based logic is gone.
 */

async function readPaidEntitlement(customerId) {
  const [active, trialing] = await Promise.all([
    stripe().subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
      expand: ['data.items.data.price'],
    }),
    stripe().subscriptions.list({
      customer: customerId,
      status: 'trialing',
      limit: 1,
      expand: ['data.items.data.price'],
    }),
  ]);
  const sub = active.data[0] || trialing.data[0];
  if (!sub) return null;
  const price = sub.items?.data?.[0]?.price;
  const plan = planFromPrice(price);
  if (!plan) return null;

  const customer = await stripe().customers.retrieve(customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};

  const planCap = CAPS[plan];
  const periodStartMs = (sub.current_period_start || 0) * 1000;
  const storedPeriodStart = parseInt(md[KEY.periodStart] || '0', 10);

  let creditsRemaining;
  if (md[KEY.credits] !== undefined && md[KEY.credits] !== '') {
    creditsRemaining = Math.max(0, parseInt(md[KEY.credits], 10) || 0);
  } else if (md[KEY.videosUsedThisPeriod] !== undefined) {
    const used = parseInt(md[KEY.videosUsedThisPeriod], 10) || 0;
    creditsRemaining = Math.max(0, planCap - used);
  } else {
    creditsRemaining = planCap;
  }

  // Never seeded (no credits and no period on the customer): the cap above
  // is this period's allotment already. Adding the rollover on top would
  // hand out two allotments when the customer is linked before /confirm or
  // a claim route seeds it (or when the seed was skipped).
  const neverSeeded =
    storedPeriodStart === 0 && (md[KEY.credits] === undefined || md[KEY.credits] === '');

  let didRollover = false;
  if (periodStartMs > storedPeriodStart && !neverSeeded) {
    creditsRemaining += planCap;
    didRollover = true;
  }

  // Cap-bump backfill: when the included credit allowance is bumped
  // platform-wide (e.g. monthly went from 4 → 15), top up any active
  // subscriber whose mid-period balance sits below the new cap so
  // they don't have to wait until renewal. Tagged via lastSeededCap
  // so it runs once per cap value per customer — never inflates a
  // user who's already at or above the cap (e.g. heavy top-ups).
  let didCapBackfill = false;
  if (
    md[KEY.lastSeededCap] !== String(planCap) &&
    creditsRemaining < planCap
  ) {
    creditsRemaining = planCap;
    didCapBackfill = true;
  }

  // Lazy Purchase reporting: if the period just rolled over to an
  // active billing cycle and we haven't reported a Purchase for this
  // period yet, fire CAPI now. Catches both the trial→active
  // conversion (yearly trial ends → first $49 charge) and every
  // subsequent renewal cycle. Idempotency via lastReportedPeriodStart
  // in customer metadata, so multiple page loads in the same period
  // don't double-fire.
  const lastReportedPeriodStart = parseInt(md[KEY.lastReportedPeriodStart] || '0', 10);
  const shouldReportPurchase =
    didRollover &&
    sub.status === 'active' &&
    storedPeriodStart > 0 && // skip first-ever signup (already reported by /confirm)
    periodStartMs > lastReportedPeriodStart;

  const needsUpdate =
    md[KEY.credits] === undefined ||
    md[KEY.videosUsedThisPeriod] !== undefined ||
    didRollover ||
    didCapBackfill ||
    md[KEY.lastSeededCap] !== String(planCap) ||
    md[KEY.plan] !== plan ||
    storedPeriodStart !== periodStartMs ||
    shouldReportPurchase;

  if (needsUpdate) {
    const nextMd = {
      ...md,
      plan,
      [KEY.periodStart]: String(periodStartMs),
      [KEY.credits]: String(creditsRemaining),
      // Always stamp the seed flag with the current cap so the
      // backfill fires once per cap change per customer.
      [KEY.lastSeededCap]: String(planCap),
    };
    if (md[KEY.videosUsedThisPeriod] !== undefined) nextMd[KEY.videosUsedThisPeriod] = '';
    if (shouldReportPurchase) nextMd[KEY.lastReportedPeriodStart] = String(periodStartMs);
    await stripe().customers.update(customerId, { metadata: nextMd });
  }

  // NOTE: the "lazy Purchase" CAPI report was REMOVED here. It fired a
  // server-side Purchase on every entitlement read (dashboard / generation /
  // status calls) under a `pur-period-…` event id that no browser pixel event
  // shared — so Meta could not deduplicate it. That produced far more server
  // Purchase events than real sales (e.g. 18 server vs 3 browser) and inflated
  // ad-reported conversions (one $29 sale showing as several). The initial
  // purchase is reported by /api/checkout/confirm + claim (which share the
  // browser pixel's event id, so they dedup); renewals and trial→active
  // conversions are reported once by the Stripe webhook
  // (invoice.payment_succeeded). `shouldReportPurchase` + lastReportedPeriodStart
  // are retained only for metadata bookkeeping above.

  if (sub.status === 'trialing') {
    const used = readTrialUsed(md);
    const remaining = Math.max(0, TRIAL_CREDITS - used);
    // Layer trial credits on top of any top-up credits the user bought
    // mid-trial so they can keep generating after the included 2 are gone.
    const topupCredits = parseInt(md[KEY.credits] || '0', 10) || 0;
    return {
      tier: plan,
      status: 'trialing',
      [KEY.credits]: remaining + topupCredits,
      videoCap: TRIAL_CREDITS + topupCredits,
      videosUsed: used,
      canSwap: remaining + topupCredits > 0,
      customerId,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    };
  }

  return {
    tier: plan,
    status: sub.status,
    creditsRemaining,
    videoCap: planCap,
    videosUsed: Math.max(0, planCap - creditsRemaining),
    canSwap: creditsRemaining > 0,
    customerId,
  };
}

/**
 * Main entitlement lookup. Pass the Supabase server client + user id, and the
 * session `user` (needed for the admin check; there is no email-only admin).
 *
 * billing_v2 (read strictly, once, here): the balance comes from the ledger
 * (getBalance) and the plan from a read-only Stripe subscription lookup;
 * nothing is written to Stripe. The returned object carries `billing`
 * ('v2' | 'legacy') so reserve / settle / refund on it use the same store.
 */
export async function getEntitlement({ supabase, userId, user }) {
  if (isConfirmedAdmin(user)) return adminEntitlement();
  if (!userId) {
    return { tier: 'none', videosUsed: 0, videoCap: 0, [KEY.credits]: 0, canSwap: false };
  }
  if (await isBillingV2Strict()) return getEntitlementV2(supabase, userId);
  const customerId = await profileCustomerId(supabase, userId);
  if (!customerId) {
    return { tier: 'none', videosUsed: 0, videoCap: 0, [KEY.credits]: 0, canSwap: false };
  }
  try {
    const paid = await readPaidEntitlement(customerId);
    if (paid) return paid;
  } catch (err) {
    console.warn('[entitlement] Stripe lookup failed', err.message);
  }
  return { tier: 'none', videosUsed: 0, videoCap: 0, [KEY.credits]: 0, canSwap: false };
}

/**
 * Consume credits on successful generation. For trialing subs, flip
 * the one-shot trialUsed flag instead of decrementing.
 */
export async function decrementCredits(entitlement, amount = 1, { ref } = {}) {
  if (entitlement?.isAdmin) return;
  if (usesLedger(entitlement)) return decrementV2(entitlement, amount, ref);
  if (!entitlement.customerId) return;
  await assertNotMigrated(entitlement.customerId);

  if (entitlement.status === 'trialing') {
    // Spend trial credits first, then top-up credits.
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    let toSpend = Math.max(1, amount);
    let used = readTrialUsed(md);
    let topup = parseInt(md[KEY.credits] || '0', 10) || 0;

    const trialAvail = Math.max(0, TRIAL_CREDITS - used);
    const fromTrial = Math.min(trialAvail, toSpend);
    used += fromTrial;
    toSpend -= fromTrial;

    if (toSpend > 0) {
      const fromTopup = Math.min(topup, toSpend);
      topup -= fromTopup;
      toSpend -= fromTopup;
    }

    await stripe().customers.update(entitlement.customerId, {
      metadata: {
        ...md,
        [KEY.trialCreditsUsed]: String(used),
        [KEY.trialUsed]: '', // clear legacy flag
        [KEY.credits]: String(topup),
      },
    });
    return;
  }

  if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const current = parseInt(md[KEY.credits] || '0', 10) || 0;
    const next = Math.max(0, current - Math.max(1, amount));
    await stripe().customers.update(entitlement.customerId, {
      metadata: { ...md, [KEY.credits]: String(next) },
    });
  }
}

/**
 * Strict reservation: re-reads the current creditsRemaining from
 * Stripe, ensures it covers the requested amount, then writes the
 * decremented value back. Throws { code: 'INSUFFICIENT', remaining }
 * if the user doesn't have enough credits at the moment of the call.
 *
 * Trial users keep their boolean trialUsed flag (no race possible).
 */
export async function reserveCredits(entitlement, amount = 1, { route } = {}) {
  if (entitlement?.isAdmin) return; // unlimited; nothing to reserve
  // billing_v2: `amount` is in v2 credits (routes price with lib/cost.js
  // v2CostForGeneration / legacyCreditsToV2 when usesLedger()).
  if (usesLedger(entitlement)) return reserveV2(entitlement, amount, route);
  if (entitlement.customerId) await assertNotMigrated(entitlement.customerId);
  if (!entitlement.customerId) {
    // Treat "never had a Stripe customer" the same as "has a Stripe
    // customer but no active plan" — both mean the user needs to pay
    // before generating. The API layer maps NO_PLAN to a 402 paywall
    // response; NO_CUSTOMER would have fallen through to a 500.
    const err = new Error('No active plan.');
    err.code = 'NO_PLAN';
    throw err;
  }

  if (entitlement.status === 'trialing') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    let used = readTrialUsed(md);
    let topup = parseInt(md[KEY.credits] || '0', 10) || 0;
    const trialAvail = Math.max(0, TRIAL_CREDITS - used);
    const total = trialAvail + topup;
    if (total < amount) {
      const err = new Error('Insufficient credits.');
      err.code = 'INSUFFICIENT';
      err.remaining = total;
      throw err;
    }
    let toSpend = amount;
    const fromTrial = Math.min(trialAvail, toSpend);
    used += fromTrial;
    toSpend -= fromTrial;
    if (toSpend > 0) {
      topup -= toSpend;
      toSpend = 0;
    }
    await stripe().customers.update(entitlement.customerId, {
      metadata: {
        ...md,
        [KEY.trialCreditsUsed]: String(used),
        [KEY.trialUsed]: '', // clear legacy flag
        [KEY.credits]: String(topup),
      },
    });
    return;
  }

  if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const current = parseInt(md[KEY.credits] || '0', 10) || 0;
    if (current < amount) {
      const err = new Error('Insufficient credits.');
      err.code = 'INSUFFICIENT';
      err.remaining = current;
      throw err;
    }
    const next = current - amount;
    await stripe().customers.update(entitlement.customerId, {
      metadata: { ...md, [KEY.credits]: String(next) },
    });
    return;
  }

  const err = new Error('No active plan.');
  err.code = 'NO_PLAN';
  throw err;
}

// Track async (vendor-queued) jobs so /api/status can refund credits
// idempotently when the vendor reports failure (e.g. Kling content
// moderation rejecting a queued job after we've already reserved
// credits). Stored in Stripe customer metadata as
// `pendingJobs = "predId1:cost1,predId2:cost2,..."` (capped, FIFO).
const MAX_PENDING_JOBS = 16;

function parsePendingJobs(md) {
  return (md[KEY.pendingJobs] || '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, cost] = entry.split(':');
      return { id, cost: parseInt(cost, 10) || 0 };
    });
}

function serializePendingJobs(list) {
  return list.slice(0, MAX_PENDING_JOBS).map((j) => `${j.id}:${j.cost}`).join(',');
}

export async function trackPendingJob(entitlement, predictionId, cost) {
  if (entitlement?.isAdmin) return;
  // billing_v2 jobs carry their hold in the signed job id (takeHoldForJob).
  if (usesLedger(entitlement)) return;
  if (!entitlement?.customerId || !predictionId || !cost) return;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const list = parsePendingJobs(md).filter((j) => j.id !== predictionId);
  list.unshift({ id: predictionId, cost });
  await stripe().customers.update(entitlement.customerId, {
    metadata: { ...md, [KEY.pendingJobs]: serializePendingJobs(list) },
  });
}

// Settle a tracked pending job. If `refund` is true and the job is
// still tracked, refund its cost back to the user. Idempotent: a
// second call for the same predictionId is a no-op (the entry is
// already gone). Returns the credit count refunded (0 if none).
export async function settlePendingJob(entitlement, predictionId, { refund }) {
  if (entitlement?.isAdmin) return 0;
  // A legacy job ending after the switch: refunded in the ledger (read-only
  // on Stripe). A v2 job's hold is settled with settleHeldJob instead.
  if (usesLedger(entitlement)) return refund ? refundLegacyJobInLedger(entitlement, predictionId) : 0;
  if (!entitlement?.customerId || !predictionId) return 0;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const list = parsePendingJobs(md);
  const idx = list.findIndex((j) => j.id === predictionId);
  if (idx === -1) return 0;
  const { cost } = list[idx];
  list.splice(idx, 1);
  const updates = { ...md, [KEY.pendingJobs]: serializePendingJobs(list) };

  if (refund && cost > 0) {
    if (entitlement.status === 'trialing') {
      const used = readTrialUsed(md);
      if (used > 0) {
        updates[KEY.trialCreditsUsed] = String(Math.max(0, used - cost));
        updates[KEY.trialUsed] = '';
      } else {
        const topup = parseInt(md[KEY.credits] || '0', 10) || 0;
        updates[KEY.credits] = String(topup + cost);
      }
    } else if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
      const current = parseInt(md[KEY.credits] || '0', 10) || 0;
      updates[KEY.credits] = String(current + cost);
    }
  }
  await stripe().customers.update(entitlement.customerId, { metadata: updates });
  return refund ? cost : 0;
}

// Per-frame face-swap use record. /api/character-frame charges once and
// hands out a reusable swap token; this caps how many motion-transfer
// jobs that one charge can start. Same list style as pendingJobs:
// `swapUses = "framePredId:lastSwapPredId:count,..."` (capped, newest
// first). Admin / customer-less entitlements have nowhere to store it.
// Stripe metadata values max out at 500 chars; 8 entries of two ~26-char
// Replicate ids each stay under that.
const MAX_SWAP_USES = 8;

function parseSwapUses(md) {
  return (md[KEY.swapUses] || '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [frameId, swapId, count] = entry.split(':');
      return { frameId, swapId, count: parseInt(count, 10) || 0 };
    })
    .filter((u) => u.frameId && u.swapId);
}

/** Returns { swapId, count } for this frame, or null if never used. */
export async function getSwapUse(entitlement, framePredictionId) {
  if (usesLedger(entitlement)) return framePredictionId ? getSwapUseV2(entitlement, framePredictionId) : null;
  if (!entitlement?.customerId || !framePredictionId) return null;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const use = parseSwapUses(md).find((u) => u.frameId === framePredictionId);
  return use ? { swapId: use.swapId, count: use.count } : null;
}

/**
 * Takes the next use of a paid frame before its motion job starts. billing_v2:
 * a compare-and-set in the database (credit_swap_uses), so two calls cannot
 * both take use N; returns the new count, or null when another call took it
 * or the frame is used up; throws when it cannot be recorded (the caller
 * refuses the swap). Legacy: nothing is written here (recordSwapUse writes
 * after the job starts, as before); returns `expected + 1`.
 */
export async function claimSwapUse(entitlement, framePredictionId, expected, max) {
  if (usesLedger(entitlement)) return claimSwapUseV2(entitlement, framePredictionId, expected, max);
  return expected + 1;
}

/** billing_v2: undoes claim `count` when its motion job did not start. No-op on the legacy path. */
export async function unclaimSwapUse(entitlement, framePredictionId, count) {
  if (usesLedger(entitlement)) await unclaimSwapUseV2(entitlement, framePredictionId, count);
}

export async function recordSwapUse(entitlement, framePredictionId, swapPredictionId, count) {
  if (usesLedger(entitlement)) {
    if (framePredictionId && swapPredictionId) await recordSwapUseV2(entitlement, framePredictionId, swapPredictionId, count);
    return;
  }
  if (!entitlement?.customerId || !framePredictionId || !swapPredictionId) return;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const list = parseSwapUses(md).filter((u) => u.frameId !== framePredictionId);
  list.unshift({ frameId: framePredictionId, swapId: swapPredictionId, count });
  const serialized = list
    .slice(0, MAX_SWAP_USES)
    .map((u) => `${u.frameId}:${u.swapId}:${u.count}`)
    .join(',');
  await stripe().customers.update(entitlement.customerId, {
    metadata: { ...md, [KEY.swapUses]: serialized },
  });
}

/**
 * Refund a reservation. Use only when reservation succeeded but the
 * downstream work failed.
 */
export async function refundCredits(entitlement, amount = 1) {
  if (entitlement?.isAdmin) return;
  // billing_v2: releases this request's hold (the whole of it); nothing to
  // refund once it was settled or handed to a job id.
  if (usesLedger(entitlement)) return refundV2(entitlement);
  if (!entitlement.customerId) return;

  if (entitlement.status === 'trialing') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const used = readTrialUsed(md);
    // Refund to trial pool first if anything was used; otherwise top-ups.
    if (used > 0) {
      const next = Math.max(0, used - Math.max(1, amount));
      await stripe().customers.update(entitlement.customerId, {
        metadata: { ...md, [KEY.trialCreditsUsed]: String(next), [KEY.trialUsed]: '' },
      });
    } else {
      const topup = parseInt(md[KEY.credits] || '0', 10) || 0;
      await stripe().customers.update(entitlement.customerId, {
        metadata: { ...md, [KEY.credits]: String(topup + Math.max(1, amount)) },
      });
    }
    return;
  }

  if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const current = parseInt(md[KEY.credits] || '0', 10) || 0;
    const next = current + Math.max(1, amount);
    await stripe().customers.update(entitlement.customerId, {
      metadata: { ...md, [KEY.credits]: String(next) },
    });
  }
}

export async function addCredits(customerId, credits) {
  if (!customerId || !credits || credits <= 0) return;
  const customer = await stripe().customers.retrieve(customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const current = parseInt(md[KEY.credits] || '0', 10) || 0;
  const next = current + credits;
  await stripe().customers.update(customerId, {
    metadata: { ...md, [KEY.credits]: String(next) },
  });
}

/** Thrown when linking would break the one-to-one Stripe customer <-> user rule. */
export class CustomerLinkedElsewhereError extends Error {
  constructor(message = 'This payment belongs to a different account.') {
    super(message);
    this.name = 'CustomerLinkedElsewhereError';
    this.code = 'customer_linked_elsewhere';
  }
}

export const ACTIVE_PLAN_ELSEWHERE_MESSAGE =
  'You already have an active plan on this account. Contact support so we can merge your new purchase.';
export const RELINK_SUPPORT_MESSAGE =
  'Your account is already linked to a different billing profile. Contact support so we can merge your new purchase.';
/**
 * A move off `from` found an earlier move to another customer (`to`) that
 * zeroed `from` and never credited `to`; `carry` ("<video>:<image>") is what
 * `to` is owed. `canAbandon`: `to` no longer exists in Stripe or no longer
 * points back at `from`, so that earlier move can never finish. Carries the
 * customer-facing support message; the admin tool shows the details.
 */
export class UnfinishedMergeError extends CustomerLinkedElsewhereError {
  constructor({ from, to, carry, canAbandon }) {
    super(RELINK_SUPPORT_MESSAGE);
    this.name = 'UnfinishedMergeError';
    this.unfinishedMerge = { from, to, carry, canAbandon };
  }
}

// relink_mode 'support' (the default): no customer-triggered path moves a
// profile off a live customer.
export const BILLING_PROFILE_EXISTS_MESSAGE =
  'You already have a billing profile on this account. Contact support so we can merge your new purchase.';

// Ownership proofs strong enough to move a profile off an existing customer
// (lib/grants.js checkSessionOwner `via`, plus server-side callers). An email
// match alone is not: anyone can type someone else's email at Stripe.
const REPLACING_PROOFS = new Set(['ticket', 'client_reference_id', 'metadata', 'server', 'admin']);
// A subscription in any of these states still ties the old customer to a plan.
const LIVE_PLAN_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
// Keys a relink moves (balances) or writes as markers: never copied.
const MOVED_OR_MARKER_KEYS = new Set([
  KEY.credits, KEY.imageCredits, KEY.relinkedFrom, KEY.relinkedTo, KEY.relinkCarry,
  KEY.relinkAbandoned, KEY.adminOverrideReason,
]);
// Keys the legacy grant / relink may still add to the new customer.
const RESERVED_NEW_KEYS = [
  KEY.credits, KEY.imageCredits, KEY.relinkedFrom, KEY.processedSessions, KEY.imagePeriodStart,
  KEY.plan, KEY.periodStart, KEY.lastSeededCap, KEY.shared.supabaseUserId, KEY.adminOverrideReason,
];
// Stripe metadata limits.
const STRIPE_MAX_KEYS = 50;
const STRIPE_MAX_KEY_LENGTH = 40;
const STRIPE_MAX_VALUE_LENGTH = 500;

/** Keys to copy from the old customer: everything not moved/marker and missing on the new one. */
function keysToCopy(oldMd, newMd) {
  return Object.keys(oldMd).filter((k) => !MOVED_OR_MARKER_KEYS.has(k) && !(k in newMd) && oldMd[k] !== '');
}

/** Would copying the old customer's keys break Stripe's metadata limits on the new one? */
function copyExceedsLimits(oldMd, newMd) {
  const copy = keysToCopy(oldMd, newMd);
  const keys = new Set([...Object.keys(newMd), ...copy, ...RESERVED_NEW_KEYS]);
  if (keys.size > STRIPE_MAX_KEYS) return true;
  return copy.some((k) => k.length > STRIPE_MAX_KEY_LENGTH || String(oldMd[k]).length > STRIPE_MAX_VALUE_LENGTH);
}

/** null when the customer is deleted / missing in Stripe, else the customer. */
async function liveCustomer(customerId) {
  try {
    const c = await stripe().customers.retrieve(customerId);
    return !c || c.deleted ? null : c;
  } catch (err) {
    if (err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing') return null;
    throw err;
  }
}

// Looks at every subscription of the customer, page by page. Fails closed: an
// error is thrown to the caller, and a customer with more pages than the
// bound counts as having a live plan (support decides).
const SUBSCRIPTION_PAGE_SIZE = 100;
const SUBSCRIPTION_MAX_PAGES = 20;
async function hasLivePlan(customerId) {
  let startingAfter = null;
  for (let page = 0; page < SUBSCRIPTION_MAX_PAGES; page += 1) {
    const list = await stripe().subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: SUBSCRIPTION_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = list?.data || [];
    if (data.some((sub) => LIVE_PLAN_STATUSES.has(sub.status))) return true;
    if (!list?.has_more || data.length === 0) return false;
    startingAfter = data[data.length - 1].id;
  }
  return true;
}

/**
 * Throws CustomerLinkedElsewhereError unless `userId` may be linked to
 * `stripeCustomerId`:
 *   - the customer must not be linked to another user;
 *   - a user with no customer (or whose customer is deleted in Stripe, which
 *     holds nothing) links normally, whatever the mode;
 *   - when the user's profile points at a different customer that still
 *     exists, moving the profile is a replacing relink:
 *       relink_mode 'support' (default): refused for every caller except
 *         the admin tool (`via: 'admin'`), with
 *         BILLING_PROFILE_EXISTS_MESSAGE. Nothing is written; the purchase
 *         stays parked (billing_v2) or on the new customer (legacy) until
 *         support merges it with pages/api/admin/heal-topups.js.
 *       relink_mode 'auto', and the admin tool in either mode, need ALL of:
 *       (a) ownership proven by the claim ticket, client_reference_id,
 *           metadata.supabase_user_id or a server-side caller (`via`),
 *           never by an email match alone;
 *       (b) no subscription of ANY product on the old customer in status
 *           active, trialing, past_due, unpaid or paused;
 *       (c) the old customer's other metadata fits on the new customer
 *           within Stripe's limits (50 keys, 40-char keys, 500-char
 *           values) when copied (see moveToNewCustomer).
 *       Otherwise 409 with a support message.
 * Returns { relinkFrom, replace, expectedOld }: the old customer to move
 * state away from (or null), whether the profile's current link may be
 * replaced, and the customer that link must still be when it is replaced.
 * Reads only.
 */
export async function assertCanLink(userId, stripeCustomerId, { via } = {}) {
  const owners = await usersForCustomer(stripeCustomerId);
  if (owners.some((id) => id !== userId)) throw new CustomerLinkedElsewhereError();
  const current = await customerForUser(userId);
  if (!current || current === stripeCustomerId) return { relinkFrom: null, replace: false, expectedOld: null };
  const old = await liveCustomer(current);
  // A customer deleted in Stripe holds nothing: the user effectively has none.
  if (!old) return { relinkFrom: null, replace: true, expectedOld: current };
  if (via !== 'admin' && (await relinkModeStrict()) !== 'auto') {
    throw new CustomerLinkedElsewhereError(BILLING_PROFILE_EXISTS_MESSAGE);
  }
  if (!REPLACING_PROOFS.has(via)) throw new CustomerLinkedElsewhereError(RELINK_SUPPORT_MESSAGE);
  if (await hasLivePlan(current)) throw new CustomerLinkedElsewhereError(ACTIVE_PLAN_ELSEWHERE_MESSAGE);
  const target = await liveCustomer(stripeCustomerId);
  if (target && copyExceedsLimits(old.metadata || {}, target.metadata || {})) {
    throw new CustomerLinkedElsewhereError(RELINK_SUPPORT_MESSAGE);
  }
  return { relinkFrom: current, replace: true, expectedOld: current };
}

const int = (v) => parseInt(v || '0', 10) || 0;

// Moves the profile's state from the old customer to the new one, retry-safe
// and at most once per (old, new) pair (runOnce: lock row + done row). The
// caller holds the per-old-customer and per-user relink locks.
//   - This app's balances (KEY.credits, KEY.imageCredits) MOVE (legacy mode;
//     billing_v2 keeps credits per user): the old customer is zeroed FIRST,
//     recording what moved in relinkCarry, then the new one is credited
//     (marked relinked_from in the same write). A retry resumes from
//     whichever step is missing; since the old balance is zeroed before the
//     new one is credited, the two never both hold it and a relink back
//     cannot sum them.
//   - Every other key on the old customer (shared un-namespaced keys such
//     as `plan`, anything that may be haelabs.live's) is COPIED to the new
//     customer only where the new one lacks it: never overwritten, summed or
//     deleted from the old customer. It rides in the same write as the
//     credit, so it is applied once. Copied in both billing modes.
// Only changed keys are sent (Stripe merges metadata), so concurrent writes,
// haelabs' included, are not clobbered. A copy that would break Stripe's
// metadata limits is refused before anything is written.
// If an earlier move off this old customer to ANOTHER customer zeroed it and
// then died before crediting, relinkCarry is the only record of what that
// customer is owed: this move is refused (UnfinishedMergeError) rather than
// overwriting it. Only the admin tool may give that carry up
// (`abandonEarlier`), and only when the earlier target no longer exists or
// no longer points back; the abandoned carry is recorded on the old customer.
// `adminOverrideReason` (admin tool only) rides in the same write that credits
// the new customer, so the merge and its reason land together or not at all.
// Abandoned carries are appended to relinkAbandoned (a comma-separated list),
// never overwritten; a list that would not fit in a Stripe value is refused.
async function moveToNewCustomer(oldId, newId, { carryCredits, abandonEarlier = false, adminOverrideReason = null }) {
  return runOnce(`relink:${oldId}:${newId}`, async () => {
    const newCustomer = await liveCustomer(newId);
    if (!newCustomer) return;
    const newMd = newCustomer.metadata || {};
    if (newMd[KEY.relinkedFrom] === oldId) return 'already'; // finished earlier
    const old = await liveCustomer(oldId);
    const oldMd = old ? old.metadata || {} : null;
    if (oldMd && copyExceedsLimits(oldMd, newMd)) throw new CustomerLinkedElsewhereError(RELINK_SUPPORT_MESSAGE);

    let carried = null;
    if (carryCredits && oldMd) {
      if (oldMd[KEY.relinkedTo] !== newId) {
        const earlier = oldMd[KEY.relinkedTo];
        const [owedVideo, owedImage] = String(oldMd[KEY.relinkCarry] || '0:0').split(':');
        let abandoned = null;
        if (earlier && int(owedVideo) + int(owedImage) > 0) {
          const earlierTarget = await liveCustomer(earlier);
          const pointsBackAt = earlierTarget?.metadata?.[KEY.relinkedFrom];
          if (pointsBackAt !== oldId) {
            const carry = `${int(owedVideo)}:${int(owedImage)}`;
            // Gone, or since overwritten by another merge. A target that
            // exists and was simply never credited can still be finished.
            const canAbandon = !earlierTarget || Boolean(pointsBackAt);
            if (!(abandonEarlier && canAbandon)) {
              console.error('[entitlement] unfinished relink', oldId, '->', earlier, 'owes', carry);
              throw new UnfinishedMergeError({ from: oldId, to: earlier, carry, canAbandon });
            }
            const entry = `${earlier}:${carry}`;
            const list = String(oldMd[KEY.relinkAbandoned] || '').split(',').filter(Boolean);
            if (!list.includes(entry)) list.push(entry);
            abandoned = list.join(',');
            if (abandoned.length > STRIPE_MAX_VALUE_LENGTH) {
              console.error('[entitlement] relinkAbandoned is full on', oldId, abandoned);
              throw new CustomerLinkedElsewhereError(
                'The record of abandoned merges on the old billing profile is full. Nothing was changed; ask the developer.'
              );
            }
            console.warn('[entitlement] abandoning unfinished relink', oldId, '->', earlier, 'owed', carry);
          }
        }
        carried = { video: int(oldMd[KEY.credits]), image: int(oldMd[KEY.imageCredits]) };
        await stripe().customers.update(oldId, {
          metadata: {
            [KEY.credits]: '0',
            [KEY.imageCredits]: '0',
            [KEY.relinkedTo]: newId,
            [KEY.relinkCarry]: `${carried.video}:${carried.image}`,
            ...(abandoned ? { [KEY.relinkAbandoned]: abandoned } : {}),
          },
        });
      } else {
        const [video, image] = String(oldMd[KEY.relinkCarry] || '0:0').split(':');
        carried = { video: int(video), image: int(image) };
      }
    }
    const patch = { [KEY.relinkedFrom]: oldId };
    if (oldMd) for (const k of keysToCopy(oldMd, newMd)) patch[k] = oldMd[k];
    if (adminOverrideReason) patch[KEY.adminOverrideReason] = adminOverrideReason;
    if (carried) {
      patch[KEY.credits] = String(int(newMd[KEY.credits]) + carried.video);
      patch[KEY.imageCredits] = String(int(newMd[KEY.imageCredits]) + carried.image);
    }
    await stripe().customers.update(newId, { metadata: patch });
    console.info('[entitlement] relinked', oldId, '->', newId, carried ? JSON.stringify(carried) : '');
  });
}

/** Records an admin's ownership override on the customer (only that key). Throws on failure. */
async function writeOverrideReason(customerId, reason) {
  const current = await liveCustomer(customerId);
  if (current?.metadata?.[KEY.adminOverrideReason] === reason) return;
  await stripe().customers.update(customerId, { metadata: { [KEY.adminOverrideReason]: reason } });
}

/**
 * Link a Stripe customer to a Supabase user's profile row.
 * Called from /api/checkout/confirm and the claim routes after the caller
 * was checked against the checkout session and the grant ran. `via` is how
 * ownership was proven (checkSessionOwner), 'server' for server-side
 * callers, 'admin' for the admin heal tool; with relink_mode it gates
 * replacing relinks (assertCanLink).
 *
 * Order: Stripe-side checks (assertCanLink), then, for a replacing relink,
 * the move off the old customer (retry-safe) and the link, both under two
 * lock rows taken in a fixed order: one for the OLD customer, one for the
 * USER. Two relinks of one user, or two relinks off one old customer, can
 * therefore never both read the old balance before one of them zeroes it:
 * the second gets GrantInProgressError (retry later). Inside the locks the
 * profile is re-read, and the link itself is a compare-and-swap on the old
 * customer (credit_link_customer, service role, serialized per customer and
 * per user), so a link that changed since assertCanLink looked is never
 * replaced. The `supabase` argument is kept for callers and no longer used
 * for the write. With billing_v2 on, grants parked for this customer are
 * then claimed; a duplicate pending row is dropped inside
 * claimPendingGrants, and any other claim failure is thrown so the caller
 * can retry.
 */
// eslint-disable-next-line no-unused-vars
export async function linkStripeCustomerToProfile(
  supabase,
  userId,
  stripeCustomerId,
  { via, forceAbandonEarlierMerge = false, adminOverrideReason = null } = {}
) {
  // Only the admin tool records an ownership override.
  const overrideReason = via === 'admin' && adminOverrideReason ? String(adminOverrideReason) : null;
  const { relinkFrom, replace, expectedOld } = await assertCanLink(userId, stripeCustomerId, { via });
  const v2 = await isBillingV2Strict();
  const writeLink = async () => {
    const result = await linkCustomerAtomically(userId, stripeCustomerId, { allowReplace: replace, expectedOld });
    if (result === 'linked_elsewhere') throw new CustomerLinkedElsewhereError();
    if (result === 'user_has_other') throw new CustomerLinkedElsewhereError(RELINK_SUPPORT_MESSAGE);
    // The link changed since assertCanLink read it: the caller retries and
    // is judged against the new state.
    if (result === 'conflict') throw new GrantInProgressError(`relink_user:${userId}`);
  };
  if (relinkFrom) {
    await withLock(`relink_old:${relinkFrom}`, () =>
      withLock(`relink_user:${userId}`, async () => {
        if ((await customerForUser(userId)) !== relinkFrom) throw new GrantInProgressError(`relink_user:${userId}`);
        const moved = await moveToNewCustomer(relinkFrom, stripeCustomerId, {
          carryCredits: !v2,
          // Only the admin tool may give up an earlier, unfinishable carry.
          abandonEarlier: via === 'admin' && forceAbandonEarlierMerge === true,
          adminOverrideReason: overrideReason,
        });
        // The move finished on an earlier call (without this reason): record it now.
        if (moved === 'already' && overrideReason) await writeOverrideReason(stripeCustomerId, overrideReason);
        await writeLink();
      })
    );
  } else {
    if (overrideReason) await writeOverrideReason(stripeCustomerId, overrideReason);
    await writeLink();
  }
  if (!v2) return;
  try {
    await claimPendingGrants(stripeCustomerId, userId);
  } catch (claimErr) {
    if (!(claimErr instanceof RefConflictError)) throw claimErr;
    console.error('[entitlement] pending grant claim failed', stripeCustomerId, claimErr.message);
  }
}
