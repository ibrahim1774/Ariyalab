import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.js';
import { setCreditsDb, grantCredits, holdCredits, settleHold, releaseHold, getBalance, callCreditFunction } from '../lib/credits.js';
import { endHold, recordHold, reconcileLegacyHolds, jobRef, LEGACY_TOOL_REASON, OPERATOR_AFTER_ATTEMPTS } from '../lib/legacyHolds.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(db);
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  await db?.close();
});

async function account(credits = 100) {
  const userId = randomUUID();
  await grantCredits({ userId, currency: 'video', amount: credits, bucket: 'topup', reason: 'test_grant', ref: `seed:${userId}` });
  return userId;
}
const available = async (u) => (await getBalance(u, 'video')).available;

describe('credit_charge_closed_hold: atomic guard (Task 6 carry)', () => {
  it('a hold already settled under one ref is never charged again under another', async () => {
    const user = await account();
    const holdId = randomUUID();
    await holdCredits({ userId: user, currency: 'video', amount: 10, projectId: null, holdId });
    await settleHold({ holdId, amount: 10, reason: LEGACY_TOOL_REASON, ref: 'legacy:swap:route-job' });
    expect(await available(user)).toBe(90);
    // The reconciler only knows the hold id and charges under another ref: nothing more is taken.
    await callCreditFunction('credit_charge_closed_hold', {
      p_hold: holdId, p_user: user, p_currency: 'video', p_amount: 10, p_reason: LEGACY_TOOL_REASON, p_ref: `legacy:swap:${holdId}`,
    });
    expect(await available(user)).toBe(90);
    const { rows } = await db.query("select count(*)::int as n from public.credit_ledger where hold_id = $1 and op in ('settle', 'spend')", [holdId]);
    expect(rows[0].n).toBe(1);
  });

  it('a closed, never-charged hold is charged once (and a repeat is a replay)', async () => {
    const user = await account();
    const holdId = randomUUID();
    await holdCredits({ userId: user, currency: 'video', amount: 10, projectId: null, holdId });
    await releaseHold({ holdId });
    const args = { p_hold: holdId, p_user: user, p_currency: 'video', p_amount: 10, p_reason: LEGACY_TOOL_REASON, p_ref: 'legacy:swap:j1' };
    await callCreditFunction('credit_charge_closed_hold', args);
    await callCreditFunction('credit_charge_closed_hold', args);
    expect(await available(user)).toBe(90);
  });
});

describe('a job ref already settled from another hold', () => {
  it('is not taken as paid: the row goes to settle_retry', async () => {
    const user = await account();
    const route = 'image-to-video';
    // Hold A settled the job ref (for example a duplicate poll on another hold).
    const holdA = randomUUID();
    await holdCredits({ userId: user, currency: 'video', amount: 5, projectId: null, holdId: holdA });
    await settleHold({ holdId: holdA, amount: 5, reason: LEGACY_TOOL_REASON, ref: jobRef(route, 'job-7') });
    // Hold B, for the same job id, closed without a charge.
    const holdB = randomUUID();
    await recordHold({ holdId: holdB, userId: user, currency: 'video', amount: 10, route });
    await holdCredits({ userId: user, currency: 'video', amount: 10, projectId: null, holdId: holdB });
    await releaseHold({ holdId: holdB });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await endHold({ hold: { holdId: holdB, amount: 10, route, userId: user, currency: 'video' }, jobId: 'job-7', failed: false });
    err.mockRestore();
    warn.mockRestore();
    expect(outcome).toBe('retry');
    const { rows } = await db.query('select status, attempts from public.credit_legacy_holds where hold_id = $1', [holdB]);
    expect(rows[0]).toMatchObject({ status: 'settle_retry', attempts: 1 });
  });
});

describe('settle_retry rows that cannot settle', () => {
  it(`are logged for an operator once attempts > ${OPERATOR_AFTER_ATTEMPTS}, never released`, async () => {
    const user = await account();
    const holdId = randomUUID();
    await recordHold({ holdId, userId: user, currency: 'video', amount: 10, route: 'ugc-image' });
    await db.query(
      `update public.credit_legacy_holds set status = 'settle_retry', attempts = $2, job_id = 'j9', provider = 'replicate',
         created_at = now() - interval '1 day', last_error = 'db down' where hold_id = $1`,
      [holdId, OPERATOR_AFTER_ATTEMPTS + 1]
    );
    const logs = [];
    const err = vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await reconcileLegacyHolds({ getKie: async () => ({}), renderStatus: async () => null });
    err.mockRestore();
    warn.mockRestore();
    expect(summary.operator).toBe(1);
    expect(logs.some((l) => l.includes('OPERATOR') && l.includes(holdId) && l.includes('Stuck legacy holds'))).toBe(true);
    expect(await available(user)).toBe(100); // never released: the hold here was never taken, nothing was given away
  });
});
