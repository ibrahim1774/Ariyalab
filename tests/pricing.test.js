import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPricing, quoteShot, quoteProject, setPricingDb, _resetPricingCache,
  PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2,
} from '../lib/pricing.js';
import {
  QUALITY_LABELS, PROVIDER_COSTS_USD, costOfVideoUsd, creditsForVideo, videosPerPlan, markup,
  DEFAULTS, SIMPLE_LENGTHS, projectFeeFor,
} from '../lib/pricingConstants.js';
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
    expect(q.lines.map((l) => l.label)).toContain('15 Pro shots');
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
    expect(p.included).toEqual({ castRegenPerCharacter: 2, narration: 3, music: 3, chat: 150, render: 1 });
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
    // economy clips are at least 4 seconds (DEFAULTS.minSeconds), so a 3 second shot is priced as 4.
    expect(await quoteShot({ quality: 'economy', seconds: 3 })).toBe(36);
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
    expect(PLANS_V2.starter).toEqual({ usd: 29, credits: 900 });
    expect(PLANS_V2.studio).toEqual({ usd: 99, credits: 3100 });
    expect(TOPUPS_V2.l).toEqual({ usd: 100, credits: 3100 });
    expect(YEARLY_DISCOUNT).toBe(0.15); // owner decision 2026-11-16: 15% off yearly
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

describe('short video fee', () => {
  it('lists the five simple lengths; the default short fee is the lowest that keeps 70% margin (90 today, see the 70% rule)', () => {
    expect(SIMPLE_LENGTHS).toEqual([7, 10, 30, 60, 120]);
    expect(DEFAULTS.projectFeeShort).toBe(90);
    expect(DEFAULTS.projectFee).toBe(90);
  });
  it('projectFeeFor: 10 seconds or less pays the short fee, longer pays the full fee', () => {
    const pricing = { projectFee: 90, projectFeeShort: 45 };
    expect(projectFeeFor(pricing, 7)).toBe(45);
    expect(projectFeeFor(pricing, 10)).toBe(45);
    expect(projectFeeFor(pricing, 11)).toBe(90);
    expect(projectFeeFor(pricing, 30)).toBe(90);
    expect(projectFeeFor(pricing, 120)).toBe(90);
  });
  it('projectFeeFor falls back to the full fee when the short fee is not a whole number of 0 or more', () => {
    for (const bad of [undefined, null, -1, 4.5, '45', NaN]) {
      expect(projectFeeFor({ projectFee: 90, projectFeeShort: bad }, 7)).toBe(90);
    }
    expect(projectFeeFor({ projectFee: 90, projectFeeShort: 0 }, 7)).toBe(0);
    expect(projectFeeFor({ projectFee: 100, projectFeeShort: 45 }, undefined)).toBe(100);
  });
  it('quoteProject shows the same fee a project of that length is charged', async () => {
    setPricingDb(fakeDb([{ key: 'projectFeeShort', value: 45 }]));
    const shots = [{ quality: 'standard', seconds: 5 }];
    const short = await quoteProject({ shots, feeAlreadyCharged: false, seconds: 10 });
    expect(short.lines[0]).toEqual({ label: 'Project fee', credits: 45 });
    const long = await quoteProject({ shots, feeAlreadyCharged: false, seconds: 30 });
    expect(long.lines[0]).toEqual({ label: 'Project fee', credits: 90 });
    expect(short.total).toBe(45 + 55);
  });
  it('getPricing reads projectFeeShort from pricing_config', async () => {
    setPricingDb(fakeDb([{ key: 'projectFeeShort', value: 50 }]));
    expect((await getPricing()).projectFeeShort).toBe(50);
  });
});

describe('labels', () => {
  it('has display names', () => {
    expect(QUALITY_LABELS).toEqual({ economy: 'Budget', standard: 'Standard', pro_narrated: 'Pro', pro_talking: 'Pro talking' });
  });
});

describe('the 70% rule', () => {
  const QUALITIES = ['economy', 'standard', 'pro_narrated', 'pro_talking'];
  const LENGTHS = [7, 10, 30, 60, 120];
  const OFFERS = [...Object.values(PLANS_V2), ...Object.values(TOPUPS_V2)];
  const net = (usd) => usd - 0.029 * usd - 0.3; // after Stripe's 2.9% + $0.30

  it('keeps provider costs as agreed', () => {
    expect(PROVIDER_COSTS_USD.projectFixed).toBe(0.84);
    expect(PROVIDER_COSTS_USD.rerollAllowance).toBe(0.2);
  });
  it('keeps at least 70% margin on every plan and top-up when every credit is used', () => {
    for (const offer of OFFERS) {
      for (const quality of QUALITIES) {
        for (const seconds of LENGTHS) {
          const costPerCredit = costOfVideoUsd({ quality, seconds }) / creditsForVideo({ quality, seconds });
          const margin = 1 - (offer.credits * costPerCredit) / net(offer.usd);
          expect(margin, `${offer.usd} ${quality} ${seconds}s`).toBeGreaterThanOrEqual(0.7);
        }
      }
    }
  });
  it('shows what the owner\'s 45 credit short fee would do: under 70% at 7 and 10 seconds, so it is not the default', () => {
    const at45 = { ...DEFAULTS, projectFeeShort: 45 };
    const margin = (offer, seconds) => {
      const credits = projectFeeFor(at45, seconds) + DEFAULTS.perSecond.standard * Math.ceil(seconds / 3) * 3;
      return 1 - (offer.credits * costOfVideoUsd({ quality: 'standard', seconds }) / credits) / net(offer.usd);
    };
    expect(margin(PLANS_V2.studio, 7)).toBeLessThan(0.7);
    expect(margin(PLANS_V2.studio, 10)).toBeLessThan(0.7);
  });
  it('stays under 80% on the Starter plan for standard video (credits not cut too far)', () => {
    const costPerCredit = costOfVideoUsd({ quality: 'standard', seconds: 30 }) / creditsForVideo({ quality: 'standard', seconds: 30 });
    expect(1 - (PLANS_V2.starter.credits * costPerCredit) / net(PLANS_V2.starter.usd)).toBeLessThan(0.8);
  });
  it('computes exact credits per video', () => {
    expect(creditsForVideo({ quality: 'pro_narrated', seconds: 45 })).toBe(720);
    expect(creditsForVideo({ quality: 'standard', seconds: 30 })).toBe(420);
    expect(creditsForVideo({ quality: 'pro_talking', seconds: 60 })).toBe(1350);
  });
  it('rounds generated seconds up to whole shots', () => {
    expect(creditsForVideo({ quality: 'standard', seconds: 10 })).toBe(90 + 11 * 12);
    expect(creditsForVideo({ quality: 'standard', seconds: 10, shotSeconds: 5 })).toBe(90 + 11 * 10);
    expect(costOfVideoUsd({ quality: 'standard', seconds: 30 })).toBeCloseTo((0.0755 * 30 + 0.02 * 10) * 1.2 + 0.84, 10);
  });
  it('counts whole videos per plan', () => {
    expect(videosPerPlan({ credits: 1500, quality: 'pro_narrated', seconds: 45 })).toBe(2);
    expect(videosPerPlan({ credits: 2600, quality: 'standard', seconds: 30 })).toBe(6);
    expect(videosPerPlan({ credits: 5400, quality: 'pro_talking', seconds: 60 })).toBe(4);
  });
});
