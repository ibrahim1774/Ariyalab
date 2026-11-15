#!/usr/bin/env node
/*
 * One-time move of this app's legacy credit balances (Stripe customer
 * metadata, lib/metaKeys.js `ariyalab_*` keys) into the billing_v2 ledger.
 *
 *   node scripts/migrate-legacy-credits.mjs                 # dry run (default)
 *   node scripts/migrate-legacy-credits.mjs --dry-run       # the same
 *   node scripts/migrate-legacy-credits.mjs --apply --confirm=<count from the dry run>
 *
 * Options:
 *   --allow-live      required when STRIPE_SECRET_KEY is a live key (sk_live_ / rk_live_)
 *   --allow-flag-off  allow --apply while billing_v2 is still off (not recommended:
 *                     balances keep changing on the legacy path after the snapshot)
 *   --report=<path>   where --apply writes its JSON report
 *                     (default ./legacy-migration-report-<time>.json)
 *
 * Needs STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * What it reads: every Stripe customer (paged), keeping those with this app's
 * credit or plan keys. haelabs.live's keys are never read into a balance.
 * Per customer it prints
 *   { customerId, linkedUserId, legacyCredits, v2Credits, legacyImageCredits,
 *     imageCredits, action, split, plan }
 * where legacyCredits is what the legacy reader (lib/entitlement.js) would
 * show right now, including a pending period rollover or cap backfill.
 *
 * Conversion and split:
 *   v2Credits = ceil(legacyCredits * LEGACY_TO_V2) (100 -> 21).
 *   With an active (not trialing) subscription of ours, the plan bucket gets
 *   the part of this period's allotment still unspent, min(legacyCredits,
 *   plan cap), converted; the rest of v2Credits goes to the topup bucket.
 *   Without one, everything is topup. Trial pools are not moved.
 *   Image credits are not converted (1 image credit stays 1) and all go to the
 *   topup bucket: one legacy number cannot tell the monthly 30 from bought
 *   packs, and the v2 monthly image refill starts on its own.
 *
 * What it writes (--apply only): ledger grants through lib/credits.js with
 * ref `legacy-migration:<customerId>` and reasons legacy_migration_plan,
 * legacy_migration_topup and legacy_migration_image_topup (idempotent: a
 * second run grants nothing). A customer with no linked user, or linked to
 * several, gets credit_pending_grants rows instead, claimed when the customer
 * is linked. It NEVER writes, zeroes or deletes anything in Stripe, so the
 * legacy balances stay readable for a rollback (turn billing_v2 off).
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { KEY } from '../lib/metaKeys.js';
import { CAPS, planFromPrice } from '../lib/stripe.js';
import { grantCredits, hasLedgerEntry, RefConflictError } from '../lib/credits.js';
import { usersForCustomer, parkPendingGrant, findPendingGrant, legacyToV2 } from '../lib/grants.js';
import { isBillingV2Strict } from '../lib/billingFlags.js';

const REASONS = {
  videoPlan: { currency: 'video', bucket: 'plan', reason: 'legacy_migration_plan' },
  videoTopup: { currency: 'video', bucket: 'topup', reason: 'legacy_migration_topup' },
  imageTopup: { currency: 'image', bucket: 'topup', reason: 'legacy_migration_image_topup' },
};
const OUR_KEYS = [KEY.credits, KEY.imageCredits, KEY.plan, KEY.periodStart];
const TODO = new Set(['grant', 'park', 'park_multi']);
const int = (v) => Math.max(0, parseInt(v || '0', 10) || 0);

function parseArgs(argv) {
  const opts = { apply: false, confirm: null, allowLive: false, allowFlagOff: false, report: null, unknown: [] };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--allow-live') opts.allowLive = true;
    else if (arg === '--allow-flag-off') opts.allowFlagOff = true;
    else if (arg.startsWith('--confirm=')) opts.confirm = arg.slice('--confirm='.length);
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

// What lib/entitlement.js readPaidEntitlement would report for an active
// subscriber now (read only): base balance, plus a period rollover not yet
// applied, plus the cap backfill.
function legacyVideoBalance(md, sub, plan) {
  if (!sub || !plan || sub.status !== 'active') return int(md[KEY.credits]);
  const cap = CAPS[plan];
  const periodStartMs = (sub.current_period_start || 0) * 1000;
  const stored = int(md[KEY.periodStart]);
  const hasCredits = md[KEY.credits] !== undefined && md[KEY.credits] !== '';
  let credits;
  if (hasCredits) credits = int(md[KEY.credits]);
  else if (md[KEY.videosUsedThisPeriod] !== undefined) credits = Math.max(0, cap - int(md[KEY.videosUsedThisPeriod]));
  else credits = cap;
  const neverSeeded = stored === 0 && !hasCredits;
  if (periodStartMs > stored && !neverSeeded) credits += cap;
  if (md[KEY.lastSeededCap] !== String(cap) && credits < cap) credits = cap;
  return credits;
}

async function planRow(stripe, customer) {
  const md = customer.metadata || {};
  const { sub, plan } = await ourSubscription(stripe, customer.id);
  const legacyCredits = legacyVideoBalance(md, sub, plan);
  const legacyImageCredits = int(md[KEY.imageCredits]);
  const v2Credits = legacyToV2(legacyCredits);
  const planLegacy = sub?.status === 'active' && plan ? Math.min(legacyCredits, CAPS[plan]) : 0;
  const videoPlan = legacyToV2(planLegacy);
  const split = { videoPlan, videoTopup: v2Credits - videoPlan, imageTopup: legacyImageCredits };

  const users = await usersForCustomer(customer.id);
  const linkedUserId = users.length === 1 ? users[0] : null;
  const ref = `legacy-migration:${customer.id}`;
  const parts = Object.entries(split).filter(([, amount]) => amount > 0);

  let action;
  if (parts.length === 0) action = 'nothing';
  else {
    const done = [];
    for (const [part] of parts) {
      const { currency, reason } = REASONS[part];
      done.push(
        linkedUserId
          ? (await hasLedgerEntry({ userId: linkedUserId, currency, reason, ref })) || Boolean(await findPendingGrant(reason, ref))
          : Boolean(await findPendingGrant(reason, ref))
      );
    }
    if (done.every(Boolean)) action = 'already';
    else if (linkedUserId) action = 'grant';
    else action = users.length > 1 ? 'park_multi' : 'park';
  }
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
  };
}

async function applyRow(row) {
  const ref = `legacy-migration:${row.customerId}`;
  const done = [];
  for (const [part, amount] of Object.entries(row.split)) {
    if (amount <= 0) continue;
    const { currency, bucket, reason } = REASONS[part];
    if (row.action === 'grant') {
      try {
        await grantCredits({ userId: row.linkedUserId, currency, amount, bucket, reason, ref });
      } catch (err) {
        if (err instanceof RefConflictError) {
          return { result: 'ref_conflict', error: `${part}: already granted with a different amount; not changed` };
        }
        throw err;
      }
    } else {
      await parkPendingGrant({ customerId: row.customerId, currency, amount, bucket, reason, ref });
    }
    done.push(part);
  }
  return { result: row.action === 'grant' ? 'granted' : 'parked', parts: done };
}

/**
 * Runs the migration. Tests pass `stripeClient` (a stub) and `writeReport`;
 * the command line builds the real Stripe client. Returns { ok, rows, count }.
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
    return { ok: false, rows: [], count: 0, error: message };
  };
  if (opts.unknown.length) return refuse(`Unknown option(s): ${opts.unknown.join(' ')}`);
  const key = env.STRIPE_SECRET_KEY;
  if (!key && !stripeClient) return refuse('STRIPE_SECRET_KEY is not set. Nothing was read or written.');
  if (isLiveKey(key) && !opts.allowLive) {
    return refuse('STRIPE_SECRET_KEY is a LIVE key. Re-run with --allow-live only if you mean the live account. Nothing was read or written.');
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
    rows.push(await planRow(stripe, customer));
  }
  const count = rows.filter((r) => TODO.has(r.action)).length;

  if (!opts.apply) {
    log(JSON.stringify({ mode: 'dry-run', count, rows }, null, 2));
    log(`Dry run: ${count} customer(s) to migrate. Nothing was written. To apply: --apply --confirm=${count}`);
    return { ok: true, rows, count };
  }

  if (opts.confirm === null || String(count) !== String(opts.confirm)) {
    return refuse(
      `--apply needs --confirm=${count} (the number of customers to migrate right now). ` +
        `Got ${opts.confirm === null ? 'none' : `--confirm=${opts.confirm}`}. Nothing was written.`
    );
  }

  for (const row of rows) {
    if (!TODO.has(row.action)) {
      row.result = row.action;
      continue;
    }
    try {
      Object.assign(row, await applyRow(row));
    } catch (err) {
      row.result = 'error';
      row.error = err?.message || String(err);
    }
  }
  const at = now().toISOString();
  const path = opts.report || `legacy-migration-report-${at.replace(/[:.]/g, '-')}.json`;
  const report = { mode: 'apply', at, count, rows };
  writeReport(path, JSON.stringify(report, null, 2));
  const failed = rows.filter((r) => r.result === 'error' || r.result === 'ref_conflict');
  log(JSON.stringify(report, null, 2));
  log(`Applied: ${count - failed.length} of ${count} migrated; ${failed.length} need a look. Report: ${path}`);
  return { ok: failed.length === 0, rows, count, reportPath: path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigration({ argv: process.argv.slice(2) })
    .then((out) => process.exit(out.ok ? 0 : 2))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
