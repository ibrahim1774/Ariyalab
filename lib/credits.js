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
// undefined values are dropped so SQL defaults apply, except the names in
// `keepNull`, which are sent as SQL null (for parameters without a default).
async function call(fnName, params, { keepNull = [] } = {}) {
  const entries = Object.entries(params).filter(
    ([k, v]) => v !== undefined && (v !== null || keepNull.includes(k))
  );
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

/**
 * Returns the hold id. Generated when omitted; passing the same holdId again
 * returns the same hold. `projectId` is required; pass an explicit null for a
 * hold that belongs to no project (the old tools, lib/entitlement.js).
 */
export async function holdCredits({ userId, currency, amount, projectId, holdId }) {
  if (projectId !== null) text(projectId, 'projectId');
  return call(
    'credit_hold',
    {
      p_user: text(userId, 'userId'),
      p_currency: currencyOf(currency),
      p_amount: amountOf(amount),
      p_project: projectId,
      p_hold_id: holdId || randomUUID(),
    },
    { keepNull: ['p_project'] }
  );
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

/**
 * Active holds created more than `olderThanMinutes` ago, oldest first (then by
 * id). For the sweeper. Optional: `projectOnly` (holds of a project), `limit`
 * (page size) and `after` (the `cursor` of the last row of the previous page:
 * { createdAt, id } where createdAt is the database's own timestamp text,
 * microseconds kept, so keyset paging never repeats a row).
 */
export async function listStaleHolds({ olderThanMinutes, projectOnly = false, limit = null, after = null }) {
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
    throw new TypeError('olderThanMinutes must be a non-negative number');
  }
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const max = Number.isInteger(limit) && limit > 0 ? limit : null;
  if (testDb) {
    const params = [cutoff];
    let where = "status = 'active' and created_at < $1::timestamptz";
    if (projectOnly) where += ' and project_id is not null';
    if (after) {
      params.push(String(after.createdAt), after.id);
      where += ` and (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const { rows } = await testDb.query(
      `select id, user_id, currency, amount, remaining, project_id, created_at, created_at::text as created_at_raw
         from public.credit_holds where ${where}
        order by created_at, id${max ? ` limit ${max}` : ''}`,
      params
    );
    return rows.map(({ created_at_raw: raw, ...h }) => ({ ...isoCreatedAt(h), cursor: { createdAt: raw, id: h.id } }));
  }
  let q = getSupabaseAdmin()
    .from('credit_holds')
    .select('id, user_id, currency, amount, remaining, project_id, created_at')
    .eq('status', 'active')
    .lt('created_at', cutoff);
  if (projectOnly) q = q.not('project_id', 'is', null);
  if (after) {
    // PostgREST returns timestamptz text with microseconds; it is used as is.
    const at = encodeURIComponent(String(after.createdAt));
    q = q.or(`created_at.gt.${at},and(created_at.eq.${at},id.gt.${after.id})`);
  }
  q = q.order('created_at').order('id');
  if (max) q = q.limit(max);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((h) => ({ ...isoCreatedAt(h), cursor: { createdAt: h.created_at, id: h.id } }));
}

/**
 * True when the ledger has a row of `op` ('settle' | 'release') for this hold
 * with exactly this ref. The job runner uses it to see whether a job's share
 * was already settled (ref `job:<id>:settle`) before it would release it.
 */
export async function holdHasEntry({ holdId, op, ref }) {
  text(holdId, 'holdId');
  text(ref, 'ref');
  if (op !== 'settle' && op !== 'release') throw new TypeError("op must be 'settle' or 'release'");
  if (testDb) {
    const { rows } = await testDb.query(
      'select 1 from public.credit_ledger where hold_id = $1 and op = $2 and ref = $3 limit 1',
      [holdId, op, ref]
    );
    return rows.length > 0;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('credit_ledger')
    .select('id')
    .eq('hold_id', holdId)
    .eq('op', op)
    .eq('ref', ref)
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

/** True when the user's ledger already holds the operation (reason, ref) in this currency. */
export async function hasLedgerEntry({ userId, currency, reason, ref }) {
  text(userId, 'userId');
  currencyOf(currency);
  text(reason, 'reason');
  text(ref, 'ref');
  if (testDb) {
    const { rows } = await testDb.query(
      'select 1 from public.credit_ledger where user_id = $1 and currency = $2 and reason = $3 and ref = $4 limit 1',
      [userId, currency, reason, ref]
    );
    return rows.length > 0;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('credit_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('currency', currency)
    .eq('reason', reason)
    .eq('ref', ref)
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

/**
 * Calls one of the other credit_* SQL functions (security definer, service
 * role only; see 20261114000600_credit_legacy_tools.sql) through the same
 * runtime switch as the functions above. Scalar or jsonb result.
 */
export async function callCreditFunction(fnName, params, opts) {
  return call(fnName, params, opts);
}

/** Same, for a set-returning function: an array of rows. */
export async function callCreditRows(fnName, params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  try {
    if (testDb) {
      if (!IDENT.test(fnName) || entries.some(([k]) => !IDENT.test(k))) throw new Error('bad rpc name');
      const args = entries.map(([k], i) => `${k} => $${i + 1}`).join(', ');
      const { rows } = await testDb.query(`select * from public.${fnName}(${args})`, entries.map(([, v]) => v));
      return rows;
    }
    const { data, error } = await getSupabaseAdmin().rpc(fnName, Object.fromEntries(entries));
    if (error) throw error;
    return data || [];
  } catch (err) {
    throw _mapError(err);
  }
}

/** What is left of one hold: { remaining, status } ('active' | 'closed'), or null when there is no such hold. */
export async function holdRemaining(holdId) {
  text(holdId, 'holdId');
  if (testDb) {
    const { rows } = await testDb.query('select remaining, status from public.credit_holds where id = $1', [holdId]);
    return rows[0] ? { remaining: rows[0].remaining, status: rows[0].status } : null;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('credit_holds')
    .select('remaining, status')
    .eq('id', holdId)
    .limit(1);
  if (error) throw error;
  const row = (data || [])[0];
  return row ? { remaining: row.remaining, status: row.status } : null;
}

/** Credits charged on one project (spends and settles of its holds), for the screen's "spent on this video". */
export async function projectCharged({ userId, projectId }) {
  text(userId, 'userId');
  text(projectId, 'projectId');
  if (testDb) {
    const { rows } = await testDb.query(
      "select coalesce(sum(amount), 0)::int as total from public.credit_ledger where user_id = $1 and project_id = $2 and op in ('spend', 'settle')",
      [userId, projectId]
    );
    return rows[0].total;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('credit_ledger')
    .select('amount')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .in('op', ['spend', 'settle']);
  if (error) throw error;
  return (data || []).reduce((n, r) => n + (r.amount || 0), 0);
}
