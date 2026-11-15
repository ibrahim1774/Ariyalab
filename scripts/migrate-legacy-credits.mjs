#!/usr/bin/env node
/*
 * One-time move of this app's legacy credit balances (Stripe customer
 * metadata, lib/metaKeys.js `ariyalab_*` keys) into the billing_v2 ledger.
 *
 *   node scripts/migrate-legacy-credits.mjs --cutoff=<ISO time billing_v2 was turned on>
 *        (dry run, the default; also --dry-run)
 *   node scripts/migrate-legacy-credits.mjs --cutoff=<ISO> --apply --confirm=<rows>:<total>
 *        (rows and total are printed by the dry run)
 *
 * Options:
 *   --cutoff=<ISO>     REQUIRED. When billing_v2 was switched on. A plan period
 *                      that started after it is granted by the v2 renewal
 *                      webhook, so it is never added here.
 *   --include-dormant  also move customers with no active or trialing
 *                      subscription of ours (listed as `dormant` otherwise)
 *   --allow-live       required when STRIPE_SECRET_KEY is a live key (sk_live_ / rk_live_)
 *   --allow-flag-off   allow --apply while billing_v2 is still off (not recommended)
 *   --report=<path>    where --apply writes its JSON report
 *                      (default ./legacy-migration-report-<time>.json)
 *
 * Needs STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * What it reads: every Stripe customer (paged), keeping those with this app's
 * credit or plan keys. Per customer it prints
 *   { customerId, linkedUserId, legacyCredits, v2Credits, legacyImageCredits,
 *     imageCredits, action, split, plan, subscriptionStatus }
 * legacyCredits is what the legacy reader (lib/entitlement.js) would show now:
 * the stored balance, plus a period rollover not yet applied (only for a
 * period that started before --cutoff and that the v2 webhook has not already
 * renewed, in the ledger or parked for the customer), plus the cap backfill. Trialing customers: the remaining trial
 * credits plus their top-ups.
 *
 * Conversion and split:
 *   v2Credits = ceil(legacyCredits * LEGACY_TO_V2) (100 -> 21).
 *   Active subscription of ours: the plan bucket gets ceil(min(legacyCredits,
 *   plan cap) * LEGACY_TO_V2); the rest of v2Credits goes to topup. Trialing,
 *   or dormant with --include-dormant: all topup. Image credits are not
 *   converted and go to topup (the v2 monthly image reset starts on its own).
 *
 * Actions: grant (linked user), park (no linked user), park_multi (several
 * users), dormant (no plan; not moved without --include-dormant), already
 * (moved before), nothing (zero balance).
 *
 * What it writes (--apply only), per customer and currency, ONE call to the
 * SQL function credit_migrate_legacy: it records the customer in
 * credit_legacy_migrations and grants (or parks in credit_pending_grants) in
 * the same transaction. A customer already recorded is never granted again,
 * whatever changed since (subscription, linked account, balance): the run
 * reports `already` and, for a linked customer, claims grants still parked.
 * After this, the legacy spend path refuses migrated customers
 * (lib/entitlement.js), so turning billing_v2 off again does not let a
 * balance be spent twice. It NEVER writes, zeroes or deletes anything in Stripe.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { KEY } from '../lib/metaKeys.js';
import { CAPS, TRIAL_CREDITS, planFromPrice } from '../lib/stripe.js';
import { callCreditFunction } from '../lib/credits.js';
import { usersForCustomer, claimPendingGrants, legacyToV2 } from '../lib/grants.js';
import { isBillingV2Strict } from '../lib/billingFlags.js';

const OUR_KEYS = [KEY.credits, KEY.imageCredits, KEY.plan, KEY.periodStart, KEY.trialCreditsUsed];
const TODO = new Set(['grant', 'park', 'park_multi']);
const int = (v) => Math.max(0, parseInt(v || '0', 10) || 0);

function parseArgs(argv) {
  const opts = {
    apply: false, confirm: null, cutoff: null, includeDormant: false,
    allowLive: false, allowFlagOff: false, report: null, unknown: [],
  };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--allow-live') opts.allowLive = true;
    else if (arg === '--allow-flag-off') opts.allowFlagOff = true;
    else if (arg === '--include-dormant') opts.includeDormant = true;
    else if (arg.startsWith('--confirm=')) opts.confirm = arg.slice('--confirm='.length);
    else if (arg.startsWith('--cutoff=')) opts.cutoff = arg.slice('--cutoff='.length);
    else if (arg.startsWith('--report=')) opts.report = arg.slice('--report='.length);
    else opts.unknown.push(arg);
  }
  return opts;
}

export const isLiveKey = (key) => /^(sk|rk)_live_/.test(String(key || ''));

async function* allCustomers(stripe) {
  let after = null;
  for (;;) {
    const page = await stripe.customers.list({ limit: 100, ...(after ? { starting_after: after } : {}) });
    const data = page?.data || [];
    for (const c of data) yield c;
    if (!page?.has_more || data.length === 0) return;
    after = data[data.length - 1].id;
  }
}

// Only subscriptions with one of this app's prices count (the customer may
// also subscribe to haelabs.live on the same Stripe customer).
async function ourSubscription(stripe, customerId) {
  const list = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
    expand: ['data.items.data.price'],
  });
  for (const sub of list?.data || []) {
    if (sub.status !== 'active' && sub.status !== 'trialing') continue;
    const plan = planFromPrice(sub.items?.data?.[0]?.price);
    if (plan) return { sub, plan };
  }
  return { sub: null, plan: null };
}

// What the legacy reader would show now (read only).
async function legacyVideoBalance({ md, sub, plan, cutoffMs, userId, customerId }) {
  if (!sub || !plan) return int(md[KEY.credits]);
  if (sub.status === 'trialing') {
    const used = int(md[KEY.trialCreditsUsed]) || (md[KEY.trialUsed] === '1' ? 1 : 0);
    return Math.max(0, TRIAL_CREDITS - used) + int(md[KEY.credits]);
  }
  const cap = CAPS[plan];
  const periodStartMs = (sub.current_period_start || 0) * 1000;
  const stored = int(md[KEY.periodStart]);
  const hasCredits = md[KEY.credits] !== undefined && md[KEY.credits] !== '';
  let credits;
  if (hasCredits) credits = int(md[KEY.credits]);
  else if (md[KEY.videosUsedThisPeriod] !== undefined) credits = Math.max(0, cap - int(md[KEY.videosUsedThisPeriod]));
  else credits = cap;
  const neverSeeded = stored === 0 && !hasCredits;
  if (periodStartMs > stored && !neverSeeded && periodStartMs < cutoffMs) {
    // A renewal the v2 webhook already granted for this period (in the
    // user's ledger, or parked for the customer: unlinked, or linked but not
    // yet claimed) is not added again.
    const since = new Date(periodStartMs).toISOString();
    const renewed =
      (userId && (await callCreditFunction('credit_has_plan_renewal_since', { p_user: userId, p_since: since }))) ||
      (await callCreditFunction('credit_has_pending_renewal_since', { p_customer: customerId, p_since: since }));
    if (!renewed) credits += cap;
  }
  if (md[KEY.lastSeededCap] !== String(cap) && credits < cap) credits = cap;
  return credits;
}

async function planRow(stripe, customer, opts) {
  const md = customer.metadata || {};
  const { sub, plan } = await ourSubscription(stripe, customer.id);
  const users = await usersForCustomer(customer.id);
  const linkedUserId = users.length === 1 ? users[0] : null;

  const legacyCredits = await legacyVideoBalance({
    md, sub, plan, cutoffMs: opts.cutoffMs, userId: linkedUserId, customerId: customer.id,
  });
  const legacyImageCredits = int(md[KEY.imageCredits]);
  const v2Credits = legacyToV2(legacyCredits);
  const planLegacy = sub?.status === 'active' && plan ? Math.min(legacyCredits, CAPS[plan]) : 0;
  const videoPlan = legacyToV2(planLegacy);
  const split = { videoPlan, videoTopup: v2Credits - videoPlan, imagePlan: 0, imageTopup: legacyImageCredits };

  const recorded = {
    video: await callCreditFunction('credit_legacy_migration_of', { p_customer: customer.id, p_currency: 'video' }),
    image: await callCreditFunction('credit_legacy_migration_of', { p_customer: customer.id, p_currency: 'image' }),
  };
  const wanted = { video: v2Credits > 0, image: legacyImageCredits > 0 };

  let action;
  if (!wanted.video && !wanted.image) action = 'nothing';
  else if ((!wanted.video || recorded.video) && (!wanted.image || recorded.image)) action = 'already';
  else if (!sub && !opts.includeDormant) action = 'dormant';
  else if (linkedUserId) action = 'grant';
  else action = users.length > 1 ? 'park_multi' : 'park';

  return {
    customerId: customer.id,
    linkedUserId,
    legacyCredits,
    v2Credits,
    legacyImageCredits,
    imageCredits: legacyImageCredits,
    action,
    split,
    plan: plan || null,
    subscriptionStatus: sub?.status || null,
    recorded,
  };
}

const rowTotal = (row) => row.split.videoPlan + row.split.videoTopup + row.split.imagePlan + row.split.imageTopup;

async function applyRow(row) {
  const ref = `legacy-migration:${row.customerId}`;
  const userId = row.action === 'grant' ? row.linkedUserId : null;
  const outcomes = [];
  for (const [currency, plan, topup] of [
    ['video', row.split.videoPlan, row.split.videoTopup],
    ['image', row.split.imagePlan, row.split.imageTopup],
  ]) {
    if (plan + topup <= 0) continue;
    const r = await callCreditFunction('credit_migrate_legacy', {
      p_customer: row.customerId,
      p_currency: currency,
      p_user: userId,
      p_plan: plan,
      p_topup: topup,
      p_ref: ref,
    }, { keepNull: ['p_user'] });
    outcomes.push(r?.status);
  }
  const result = outcomes.every((s) => s === 'already')
    ? 'already'
    : outcomes.includes('migrated')
      ? 'migrated'
      : 'parked';
  return { result, outcomes };
}

/**
 * Runs the migration. Tests pass `stripeClient` (a stub) and `writeReport`;
 * the command line builds the real Stripe client. Returns { ok, rows, count, total }.
 */
export async function runMigration({
  argv = [],
  env = process.env,
  stripeClient = null,
  log = (line) => console.log(line),
  fail = (line) => console.error(line),
  writeReport = (path, body) => writeFileSync(path, body),
  now = () => new Date(),
} = {}) {
  const opts = parseArgs(argv);
  const refuse = (message) => {
    fail(message);
    return { ok: false, rows: [], count: 0, total: 0, error: message };
  };
  if (opts.unknown.length) return refuse(`Unknown option(s): ${opts.unknown.join(' ')}`);
  const key = env.STRIPE_SECRET_KEY;
  if (!key && !stripeClient) return refuse('STRIPE_SECRET_KEY is not set. Nothing was read or written.');
  if (isLiveKey(key) && !opts.allowLive) {
    return refuse('STRIPE_SECRET_KEY is a LIVE key. Re-run with --allow-live only if you mean the live account. Nothing was read or written.');
  }
  opts.cutoffMs = opts.cutoff ? Date.parse(opts.cutoff) : NaN;
  if (!Number.isFinite(opts.cutoffMs)) {
    return refuse('--cutoff=<ISO time billing_v2 was turned on> is required (for example --cutoff=2026-11-20T09:00:00Z). Nothing was read or written.');
  }
  if (opts.apply && !opts.allowFlagOff && !(await isBillingV2Strict())) {
    return refuse('billing_v2 is off. Turn it on first (see the runbook), or pass --allow-flag-off. Nothing was written.');
  }

  let stripe = stripeClient;
  if (!stripe) {
    const { default: Stripe } = await import('stripe');
    stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  }

  const rows = [];
  for await (const customer of allCustomers(stripe)) {
    if (customer.deleted) continue;
    const md = customer.metadata || {};
    if (!OUR_KEYS.some((k) => md[k] !== undefined && md[k] !== '')) continue;
    rows.push(await planRow(stripe, customer, opts));
  }
  const todo = rows.filter((r) => TODO.has(r.action));
  const count = todo.length;
  const total = todo.reduce((n, r) => n + rowTotal(r), 0);
  const dormant = rows.filter((r) => r.action === 'dormant');

  if (!opts.apply) {
    log(JSON.stringify({ mode: 'dry-run', cutoff: opts.cutoff, count, total, rows }, null, 2));
    log(
      `Dry run: ${count} customer(s) to migrate, ${total} credits in all; ${dormant.length} dormant not included. ` +
        `Nothing was written. To apply: --apply --confirm=${count}:${total}`
    );
    return { ok: true, rows, count, total };
  }

  if (opts.confirm !== `${count}:${total}`) {
    return refuse(
      `--apply needs --confirm=${count}:${total} (customers to migrate : total credits, right now). ` +
        `Got ${opts.confirm === null ? 'none' : `--confirm=${opts.confirm}`}. Nothing was written.`
    );
  }

  for (const row of rows) {
    try {
      if (TODO.has(row.action)) {
        Object.assign(row, await applyRow(row));
      } else {
        row.result = row.action;
      }
      // Grants parked for a customer that is linked now (an earlier run, or a
      // link that raced the park) are claimed for its user.
      if (row.linkedUserId && (row.result === 'already' || row.result === 'migrated')) {
        await claimPendingGrants(row.customerId, row.linkedUserId);
      }
    } catch (err) {
      row.result = 'error';
      row.error = err?.message || String(err);
    }
  }
  const at = now().toISOString();
  const path = opts.report || `legacy-migration-report-${at.replace(/[:.]/g, '-')}.json`;
  const report = { mode: 'apply', at, cutoff: opts.cutoff, count, total, rows };
  writeReport(path, JSON.stringify(report, null, 2));
  const failed = rows.filter((r) => r.result === 'error');
  log(JSON.stringify(report, null, 2));
  log(`Applied: ${count - failed.length} of ${count} migrated; ${failed.length} need a look; ${dormant.length} dormant left. Report: ${path}`);
  return { ok: failed.length === 0, rows, count, total, reportPath: path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigration({ argv: process.argv.slice(2) })
    .then((out) => process.exit(out.ok ? 0 : 2))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
