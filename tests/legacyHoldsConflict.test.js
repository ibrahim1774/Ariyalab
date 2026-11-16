import { beforeEach, describe, expect, it, vi } from 'vitest';

// chargeClosedHold (lib/legacyHolds.js) in isolation: the ledger calls are stubbed so the
// conflict a real database rarely produces (the settle passes, the direct charge conflicts) is forced.
const calls = vi.hoisted(() => ({ list: [], chargeError: null }));
vi.mock('../lib/credits.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    settleHold: async () => {
      throw new actual.HoldClosedError();
    },
    releaseHold: async () => ({}),
    callCreditFunction: async (fn, params) => {
      calls.list.push({ fn, params });
      if (fn === 'credit_hold_charged') return false;
      if (fn === 'credit_charge_closed_hold' && calls.chargeError) throw calls.chargeError();
      return null;
    },
  };
});

import { RefConflictError } from '../lib/credits.js';
import { endHold } from '../lib/legacyHolds.js';

const hold = { holdId: '00000000-0000-4000-8000-000000000001', amount: 10, route: 'image-to-video', userId: 'u1', currency: 'video' };
const marks = () => calls.list.filter((c) => c.fn === 'credit_legacy_hold_mark').map((c) => c.params.p_status);

beforeEach(() => {
  calls.list.length = 0;
  calls.chargeError = null;
});

describe('chargeClosedHold: only a spend under the job ref counts as paid (Task 6 carry)', () => {
  it('a conflict whose existing row is a spend: settled', async () => {
    calls.chargeError = () => new RefConflictError({ existing_op: 'spend' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await endHold({ hold, jobId: 'j1', failed: false })).toBe('settled');
    warn.mockRestore();
    expect(marks()).toEqual(['settled']);
  });

  it('a conflict whose existing row is a settle (or anything else): not paid, recorded for retry', async () => {
    calls.chargeError = () => new RefConflictError({ existing_op: 'settle' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await endHold({ hold, jobId: 'j1', failed: false })).toBe('retry');
    await expect(endHold({ hold, jobId: 'j1', failed: false, throwOnRetry: true })).rejects.toBeInstanceOf(RefConflictError);
    err.mockRestore();
    expect(marks()).toEqual(['settle_retry', 'settle_retry']);
  });
});
