import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPricing, quoteShot, quoteProject, setPricingDb, _resetPricingCache,
  PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2,
} from '../lib/pricing.js';
import { QUALITY_LABELS } from '../lib/pricingConstants.js';
import { isBillingV2 } from '../lib/billingFlags.js';

function fakeDb(rows, { fail = false } = {}) {
  const query = vi.fn(async () => {
    if (fail) throw new Error('db down');
    return { rows };
  });
  return { query };
}

beforeEach(() => {
  setPricingDb(fakeDb([]));
});
afterEach(() => {
  setPricingDb(null);
  vi.useRealTimers();
});

describe('quoting', () => {
  it('applies the 3 second minimum', async () => {
    expect(await quoteShot({ quality: 'pro_narrated', seconds: 2.2 })).toBe(42);
  });
  it('rounds seconds up', async () => {
    expect(await quoteShot({ quality: 'standard', seconds: 4.1 })).toBe(55);
  });
  it('throws on unknown quality or bad seconds', async () => {
    await expect(quoteShot({ quality: 'ultra', seconds: 5 })).rejects.toThrow(/quality/);
    await expect(quoteShot({ quality: 'economy', seconds: 0 })).rejects.toThrow(/seconds/);
    await expect(quoteShot({ quality: 'economy', seconds: NaN })).rejects.toThrow(/seconds/);
  });
  it('quotes 15 pro_narrated 3 second shots plus the fee as 720', async () => {
    const shots = Array.from({ length: 15 }, () => ({ quality: 'pro_narrated', seconds: 3 }));
    const q = await quoteProject({ shots, feeAlreadyCharged: false });
    expect(q.total).toBe(720);
    expect(q.lines.reduce((n, l) => n + l.credits, 0)).toBe(720);
    expect(q.lines.some((l) => /fee/i.test(l.label) && l.credits === 90)).toBe(true);
    expect(q.lines.map((l) => l.label)).toContain('15 Pro narrated shots');
  });
  it('omits the fee when already charged', async () => {
    const q = await quoteProject({ shots: [{ quality: 'economy', seconds: 5 }], feeAlreadyCharged: true });
    expect(q.total).toBe(40);
    expect(q.lines).toHaveLength(1);
  });
});

describe('getPricing', () => {
  it('returns defaults when pricing_config is empty', async () => {
    setPricingDb(fakeDb([]));
    const p = await getPricing();
    expect(p.perSecond).toEqual({ economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 });
    expect(p.projectFee).toBe(90);
    expect(p.included).toEqual({ castRegenPerCharacter: 2, narration: 3, music: 3, chat: 150 });
  });
  it('merges rows over defaults: scalars replace, objects shallow-merge, unknown keys ignored', async () => {
    setPricingDb(fakeDb([
      { key: 'projectFee', value: 100 },
      { key: 'perSecond', value: { economy: 9 } },
      { key: 'billing_v2', value: true },
    ]));
    const p = await getPricing();
    expect(p.projectFee).toBe(100);
    expect(p.perSecond).toEqual({ economy: 9, standard: 11, pro_narrated: 14, pro_talking: 21 });
    expect(p.billing_v2).toBeUndefined();
    expect(await quoteShot({ quality: 'economy', seconds: 3 })).toBe(27);
  });
  it('caches for 60 seconds and can be reset', async () => {
    vi.useFakeTimers();
    const db = fakeDb([]);
    setPricingDb(db);
    await getPricing();
    await getPricing();
    expect(db.query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(59_000);
    await getPricing();
    expect(db.query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await getPricing();
    expect(db.query).toHaveBeenCalledTimes(2);
    _resetPricingCache();
    await getPricing();
    expect(db.query).toHaveBeenCalledTimes(3);
  });
  it('falls back to defaults when the read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPricingDb(fakeDb([], { fail: true }));
    const p = await getPricing();
    expect(p.projectFee).toBe(90);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
  it('keeps the last good rows when a later read fails', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { fail: false };
    setPricingDb({ query: async () => { if (state.fail) throw new Error('down'); return { rows: [{ key: 'billing_v2', value: true }, { key: 'projectFee', value: 100 }] }; } });
    expect(await isBillingV2()).toBe(true);
    state.fail = true;
    vi.advanceTimersByTime(61_000);
    expect(await isBillingV2()).toBe(true);
    expect((await getPricing()).projectFee).toBe(100);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
  it('first-ever failed read returns defaults and retries after 5 seconds', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { fail: true, calls: 0 };
    setPricingDb({ query: async () => { state.calls++; if (state.fail) throw new Error('down'); return { rows: [{ key: 'billing_v2', value: true }] }; } });
    expect(await isBillingV2()).toBe(false);
    state.fail = false;
    vi.advanceTimersByTime(4_000);
    expect(await isBillingV2()).toBe(false);
    expect(state.calls).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(await isBillingV2()).toBe(true);
    expect(state.calls).toBe(2);
    err.mockRestore();
  });
  it('does not let callers mutate the defaults', async () => {
    setPricingDb(fakeDb([]));
    (await getPricing()).perSecond.economy = 1;
    _resetPricingCache();
    expect((await getPricing()).perSecond.economy).toBe(8);
  });
});

describe('constants', () => {
  it('exposes the v2 plans, topups and discounts', () => {
    expect(PLANS_V2.starter).toEqual({ usd: 29, credits: 1500 });
    expect(PLANS_V2.studio).toEqual({ usd: 99, credits: 5400 });
    expect(TOPUPS_V2.l).toEqual({ usd: 100, credits: 5000 });
    expect(YEARLY_DISCOUNT).toBe(0.2);
    expect(LEGACY_TO_V2).toBe(21 / 100);
  });
});

describe('isBillingV2', () => {
  it('defaults to false', async () => {
    setPricingDb(fakeDb([]));
    expect(await isBillingV2()).toBe(false);
  });
  it('reads the billing_v2 key', async () => {
    setPricingDb(fakeDb([{ key: 'billing_v2', value: true }]));
    expect(await isBillingV2()).toBe(true);
  });
  it('is false when the read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPricingDb(fakeDb([], { fail: true }));
    expect(await isBillingV2()).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('shares the 60 second cache with getPricing', async () => {
    const db = fakeDb([{ key: 'billing_v2', value: true }]);
    setPricingDb(db);
    await getPricing();
    await isBillingV2();
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('labels', () => {
  it('has display names', () => {
    expect(QUALITY_LABELS).toEqual({ economy: 'Economy', standard: 'Standard', pro_narrated: 'Pro narrated', pro_talking: 'Pro talking' });
  });
});
