import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.js';

const admin = vi.hoisted(() => ({ current: null }));
vi.mock('../lib/supabaseServer.js', () => ({ getSupabaseAdmin: () => admin.current }));
import {
  setCreditsDb, getBalance, grantCredits, renewPlanCredits, spendCredits, holdCredits,
  settleHold, releaseHold, clawback, listStaleHolds, _mapError,
  InsufficientCreditsError, RefConflictError, HoldClosedError, HoldExceededError,
} from '../lib/credits.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(db);
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  await db?.close();
});

const newUser = () => randomUUID();
const g = (userId, amount, bucket = 'plan', extra = {}) =>
  grantCredits({ userId, currency: 'video', amount, bucket, reason: 'test_grant', ref: randomUUID(), ...extra });

describe('balance, grant, spend', () => {
  it('returns zeros for a new user', async () => {
    expect(await getBalance(newUser())).toEqual({ plan: 0, topup: 0, held: 0, available: 0 });
  });
  it('grants idempotently on (reason, ref)', async () => {
    const userId = newUser();
    const ref = randomUUID();
    const args = { userId, currency: 'video', amount: 100, bucket: 'topup', reason: 'purchase', ref };
    expect((await grantCredits(args)).topup).toBe(100);
    expect((await grantCredits(args)).topup).toBe(100);
  });
  it('spends plan first, then topup', async () => {
    const userId = newUser();
    await g(userId, 30, 'plan');
    await g(userId, 50, 'topup');
    const b = await spendCredits({ userId, currency: 'video', amount: 40, reason: 'shot', ref: randomUUID() });
    expect(b).toMatchObject({ plan: 0, topup: 40, available: 40 });
  });
  it('defaults currency to video and supports image', async () => {
    const userId = newUser();
    await grantCredits({ userId, currency: 'image', amount: 7, bucket: 'plan', reason: 'x', ref: 'r1' });
    expect((await getBalance(userId, 'image')).plan).toBe(7);
    expect((await getBalance(userId)).plan).toBe(0);
  });
  it('throws InsufficientCreditsError with needed and available', async () => {
    const userId = newUser();
    await g(userId, 10);
    const err = await spendCredits({ userId, currency: 'video', amount: 25, reason: 'shot', ref: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err.needed).toBe(25);
    expect(err.available).toBe(10);
  });
});

describe('renew', () => {
  it('caps plan at the allotment then adds it, idempotent on ref', async () => {
    const userId = newUser();
    await g(userId, 2000);
    expect((await renewPlanCredits({ userId, allotment: 1500, ref: 'inv_1' })).plan).toBe(3000);
    expect((await renewPlanCredits({ userId, allotment: 1500, ref: 'inv_1' })).plan).toBe(3000);
  });
});

describe('holds', () => {
  it('generates a hold id, settles and releases the rest', async () => {
    const userId = newUser();
    await g(userId, 200);
    const holdId = await holdCredits({ userId, currency: 'video', amount: 100, projectId: randomUUID() });
    expect(holdId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getBalance(userId)).toMatchObject({ held: 100, available: 100 });
    const s = await settleHold({ holdId, amount: 60, reason: 'shot', ref: 'shot-1' });
    expect(s).toMatchObject({ plan: 140, held: 40 });
    const r = await releaseHold({ holdId });
    expect(r).toMatchObject({ held: 0, available: 140 });
    await expect(releaseHold({ holdId })).resolves.toMatchObject({ held: 0 });
  });
  it('a retried hold with the same id returns the same hold', async () => {
    const userId = newUser();
    await g(userId, 200);
    const holdId = randomUUID();
    const projectId = randomUUID();
    const a = await holdCredits({ userId, currency: 'video', amount: 50, projectId, holdId });
    const b = await holdCredits({ userId, currency: 'video', amount: 50, projectId, holdId });
    expect(a).toBe(holdId);
    expect(b).toBe(holdId);
    expect((await getBalance(userId)).held).toBe(50);
  });
  it('throws InsufficientCreditsError when holding too much', async () => {
    const userId = newUser();
    await g(userId, 10);
    const err = await holdCredits({ userId, currency: 'video', amount: 11, projectId: randomUUID() }).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err.needed).toBe(11);
    expect(err.available).toBe(10);
  });
  it('partial release needs a ref and is idempotent', async () => {
    const userId = newUser();
    await g(userId, 100);
    const holdId = await holdCredits({ userId, currency: 'video', amount: 100, projectId: randomUUID() });
    await expect(releaseHold({ holdId, amount: 40 })).rejects.toThrow(/ref/);
    await releaseHold({ holdId, amount: 40, ref: 'rel-1' });
    const b = await releaseHold({ holdId, amount: 40, ref: 'rel-1' });
    expect(b.held).toBe(60);
  });
  it('maps hold_exceeded and hold_closed', async () => {
    const userId = newUser();
    await g(userId, 100);
    const holdId = await holdCredits({ userId, currency: 'video', amount: 30, projectId: randomUUID() });
    const over = await settleHold({ holdId, amount: 31, reason: 'shot', ref: 'big' }).catch((e) => e);
    expect(over).toBeInstanceOf(HoldExceededError);
    await settleHold({ holdId, amount: 30, reason: 'shot', ref: 'all' });
    const closed = await settleHold({ holdId, amount: 1, reason: 'shot', ref: 'late' }).catch((e) => e);
    expect(closed).toBeInstanceOf(HoldClosedError);
  });
});

describe('clawback', () => {
  it('returns taken and owed; defers the part on hold', async () => {
    const userId = newUser();
    await g(userId, 100, 'topup');
    const holdId = await holdCredits({ userId, currency: 'video', amount: 60, projectId: randomUUID() });
    const c = await clawback({ userId, currency: 'video', amount: 100, reason: 'refund', ref: 'ch_1' });
    expect(c).toEqual({ taken: 40, owed: 60 });
    expect(await clawback({ userId, currency: 'video', amount: 100, reason: 'refund', ref: 'ch_1' })).toEqual({ taken: 40, owed: 60 });
    await releaseHold({ holdId });
    expect(await getBalance(userId)).toMatchObject({ available: 0, held: 0 });
  });
});

describe('ref conflicts and validation', () => {
  it('maps ref_conflict', async () => {
    const userId = newUser();
    await grantCredits({ userId, currency: 'video', amount: 10, bucket: 'plan', reason: 'dup', ref: 'same' });
    const err = await grantCredits({ userId, currency: 'video', amount: 11, bucket: 'plan', reason: 'dup', ref: 'same' }).catch((e) => e);
    expect(err).toBeInstanceOf(RefConflictError);
  });
  it('rejects empty reason or ref before calling SQL', async () => {
    const userId = newUser();
    await expect(grantCredits({ userId, currency: 'video', amount: 1, bucket: 'plan', reason: '', ref: 'x' })).rejects.toThrow(/reason/);
    await expect(spendCredits({ userId, currency: 'video', amount: 1, reason: 'x', ref: '  ' })).rejects.toThrow(/ref/);
    await expect(spendCredits({ userId, currency: 'video', amount: 0, reason: 'x', ref: 'x' })).rejects.toThrow(/amount/);
    await expect(spendCredits({ userId, currency: 'gold', amount: 1, reason: 'x', ref: 'x' })).rejects.toThrow(/currency/);
  });
  it('rethrows unknown errors', async () => {
    await expect(getBalance('not-a-uuid')).rejects.not.toBeInstanceOf(InsufficientCreditsError);
  });
});

describe('listStaleHolds', () => {
  it('lists active holds older than the cutoff', async () => {
    const userId = newUser();
    await g(userId, 100);
    const oldId = await holdCredits({ userId, currency: 'video', amount: 10, projectId: randomUUID() });
    const freshId = await holdCredits({ userId, currency: 'video', amount: 10, projectId: randomUUID() });
    await db.query("update credit_holds set created_at = now() - interval '2 hours' where id = $1", [oldId]);
    const stale = await listStaleHolds({ olderThanMinutes: 60 });
    const ids = stale.map((h) => h.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(freshId);
    expect(stale.find((h) => h.id === oldId)).toMatchObject({ user_id: userId, currency: 'video', remaining: 10 });
    await releaseHold({ holdId: oldId });
    expect((await listStaleHolds({ olderThanMinutes: 60 })).map((h) => h.id)).not.toContain(oldId);
  });
});

describe('error mapping for PostgREST error objects', () => {
  it('maps a PostgREST shaped error', () => {
    const e = _mapError({ message: 'insufficient_credits', details: '{"needed": 9, "available": 2}', hint: null, code: 'P0001' });
    expect(e).toBeInstanceOf(InsufficientCreditsError);
    expect(e.needed).toBe(9);
    expect(e.available).toBe(2);
  });
  it('maps the other codes and passes through unknowns', () => {
    expect(_mapError({ message: 'ref_conflict', details: '{"reason":"a"}' })).toBeInstanceOf(RefConflictError);
    expect(_mapError({ message: 'hold_closed' })).toBeInstanceOf(HoldClosedError);
    expect(_mapError({ message: 'hold_exceeded', details: '{"requested":5,"remaining":2}' })).toBeInstanceOf(HoldExceededError);
    const other = new Error('boom');
    expect(_mapError(other)).toBe(other);
    expect(_mapError({ message: 'weird' })).toBeInstanceOf(Error);
  });
  it('uses the admin client rpc when no test db is set', async () => {
    setCreditsDb(null);
    const rpc = vi.fn(async () => ({ data: { plan: 1, topup: 2, held: 0, available: 3 }, error: null }));
    admin.current = { rpc };
    try {
      const b = await getBalance('u1');
      expect(b.available).toBe(3);
      expect(rpc).toHaveBeenCalledWith('credit_balance', { p_user: 'u1', p_currency: 'video' });
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'insufficient_credits', details: '{"needed":5,"available":1}', hint: null, code: 'P0001' } });
      await expect(spendCredits({ userId: 'u1', currency: 'video', amount: 5, reason: 'r', ref: 'x' })).rejects.toBeInstanceOf(InsufficientCreditsError);
    } finally {
      admin.current = null;
      setCreditsDb(db);
    }
  });
});
