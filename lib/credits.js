import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabaseServer.js';

/*
 * Thin JavaScript layer over the locked credit_* SQL functions
 * (supabase/migrations/20261114000100_credit_ledger.sql).
 *
 * REFS MUST BE UNIQUE PER OPERATION. A (reason, ref) pair names exactly one
 * operation for a user and currency. Retrying the same operation means
 * sending the same reason, ref, amount (and hold, and bucket for grants):
 * it then returns without changing anything. Reusing a pair for a different
 * operation throws RefConflictError. Use a ref unique to each charge (for
 * example `<shot id>:<attempt>` or a job id), never a project-level ref for
 * several charges. Partial releases need a ref unique within that hold.
 * Renewals are keyed by ref alone (a Stripe invoice id, or
 * `yearly:<sub>:<period>`). To make hold creation retry-safe, pass a holdId
 * you stored before calling.
 */

export class InsufficientCreditsError extends Error {
  constructor(needed, available) {
    super('insufficient_credits');
    this.name = 'InsufficientCreditsError';
    this.needed = needed;
    this.available = available;
  }
}
export class RefConflictError extends Error {
  constructor(detail) {
    super('ref_conflict');
    this.name = 'RefConflictError';
    this.detail = detail;
  }
}
export class HoldClosedError extends Error {
  constructor() {
    super('hold_closed');
    this.name = 'HoldClosedError';
  }
}
export class HoldExceededError extends Error {
  constructor(detail) {
    super('hold_exceeded');
    this.name = 'HoldExceededError';
    this.requested = detail?.requested;
    this.remaining = detail?.remaining;
  }
}

let testDb = null;

/** Tests inject a PGlite-style handle ({ query }). Pass null to use the admin client. */
export function setCreditsDb(db) {
  testDb = db;
}

function parseDetail(detail) {
  if (!detail) return {};
  if (typeof detail === 'object') return detail;
  try {
    return JSON.parse(detail);
  } catch {
    return {};
  }
}

/**
 * Maps a PGlite error (.message, .detail) or a PostgREST error object
 * ({ message, details, hint, code }) to a typed error. Anything else is
 * returned unchanged (as an Error) for the caller to throw.
 */
export function _mapError(err) {
  const message = String(err?.message || '').trim();
  const detail = parseDetail(err?.detail ?? err?.details);
  switch (message) {
    case 'insufficient_credits':
      return new InsufficientCreditsError(detail.needed, detail.available);
    case 'ref_conflict':
      return new RefConflictError(detail);
    case 'hold_closed':
      return new HoldClosedError();
    case 'hold_exceeded':
      return new HoldExceededError(detail);
    default:
      if (err instanceof Error) return err;
      return Object.assign(new Error(message || 'credit call failed'), { cause: err });
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

// One path for both runtimes. `params` use the SQL parameter names; null and
// undefined values are dropped so SQL defaults apply.
async function call(fnName, params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  try {
    if (testDb) {
      if (!IDENT.test(fnName) || entries.some(([k]) => !IDENT.test(k))) throw new Error('bad rpc name');
      const args = entries.map(([k], i) => `${k} => $${i + 1}`).join(', ');
      const { rows } = await testDb.query(
        `select public.${fnName}(${args}) as result`,
        entries.map(([, v]) => v)
      );
      return rows[0].result;
    }
    const { data, error } = await getSupabaseAdmin().rpc(fnName, Object.fromEntries(entries));
    if (error) throw error;
    return data;
  } catch (err) {
    throw _mapError(err);
  }
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}
function amountOf(value) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('amount must be a positive integer');
  return value;
}
function currencyOf(value) {
  if (value !== 'video' && value !== 'image') throw new TypeError("currency must be 'video' or 'image'");
  return value;
}

export async function getBalance(userId, currency = 'video') {
  return call('credit_balance', { p_user: text(userId, 'userId'), p_currency: currencyOf(currency) });
}

export async function grantCredits({ userId, currency, amount, bucket, reason, ref }) {
  return call('credit_grant', {
    p_user: text(userId, 'userId'),
    p_currency: currencyOf(currency),
    p_amount: amountOf(amount),
    p_bucket: bucket,
    p_reason: text(reason, 'reason'),
    p_ref: text(ref, 'ref'),
  });
}

export async function renewPlanCredits({ userId, allotment, ref, currency = 'video' }) {
  return call('credit_renew_plan', {
    p_user: text(userId, 'userId'),
    p_allotment: amountOf(allotment),
    p_ref: text(ref, 'ref'),
    p_currency: currencyOf(currency),
  });
}

export async function spendCredits({ userId, currency, amount, reason, ref, projectId }) {
  return call('credit_spend', {
    p_user: text(userId, 'userId'),
    p_currency: currencyOf(currency),
    p_amount: amountOf(amount),
    p_reason: text(reason, 'reason'),
    p_ref: text(ref, 'ref'),
    p_project: projectId,
  });
}

/** Returns the hold id. Generated when omitted; passing the same holdId again returns the same hold. */
export async function holdCredits({ userId, currency, amount, projectId, holdId }) {
  text(projectId, 'projectId');
  return call('credit_hold', {
    p_user: text(userId, 'userId'),
    p_currency: currencyOf(currency),
    p_amount: amountOf(amount),
    p_project: projectId,
    p_hold_id: holdId || randomUUID(),
  });
}

export async function settleHold({ holdId, amount, reason, ref }) {
  return call('credit_settle', {
    p_hold: text(holdId, 'holdId'),
    p_amount: amountOf(amount),
    p_reason: text(reason, 'reason'),
    p_ref: text(ref, 'ref'),
  });
}

/** amount omitted releases the rest (safe to repeat); a partial release requires a ref. */
export async function releaseHold({ holdId, amount, ref }) {
  const partial = amount !== undefined && amount !== null;
  if (partial) {
    amountOf(amount);
    text(ref, 'ref');
  }
  return call('credit_release', {
    p_hold: text(holdId, 'holdId'),
    p_amount: partial ? amount : undefined,
    p_ref: partial ? ref : undefined,
  });
}

/** Takes available credits now; the rest is collected as holds are released. Returns { taken, owed }. */
export async function clawback({ userId, currency, amount, reason, ref, firstBucket }) {
  if (firstBucket != null && firstBucket !== 'plan' && firstBucket !== 'topup') {
    throw new TypeError("firstBucket must be 'plan' or 'topup'");
  }
  const r = await call('credit_clawback', {
    p_user: text(userId, 'userId'),
    p_currency: currencyOf(currency),
    p_amount: amountOf(amount),
    p_reason: text(reason, 'reason'),
    p_ref: text(ref, 'ref'),
    p_first_bucket: firstBucket,
  });
  return { taken: r.taken, owed: r.owed };
}

const isoCreatedAt = (h) => ({ ...h, created_at: new Date(h.created_at).toISOString() });

/** Active holds created more than `olderThanMinutes` ago, oldest first. For the sweeper. */
export async function listStaleHolds({ olderThanMinutes }) {
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
    throw new TypeError('olderThanMinutes must be a non-negative number');
  }
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  if (testDb) {
    const { rows } = await testDb.query(
      `select id, user_id, currency, amount, remaining, project_id, created_at
         from public.credit_holds
        where status = 'active' and created_at < $1::timestamptz
        order by created_at`,
      [cutoff]
    );
    return rows.map(isoCreatedAt);
  }
  const { data, error } = await getSupabaseAdmin()
    .from('credit_holds')
    .select('id, user_id, currency, amount, remaining, project_id, created_at')
    .eq('status', 'active')
    .lt('created_at', cutoff)
    .order('created_at');
  if (error) throw error;
  return (data || []).map(isoCreatedAt);
}
