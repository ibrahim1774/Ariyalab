import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPricing, quoteShot, quoteProject, setPricingDb, _resetPricingCache,
  PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2,
} from '../lib/pricing.js';
import {
  QUALITY_LABELS, PROVIDER_COSTS_USD, costOfVideoUsd, creditsForVideo, videosPerPlan, markup,
  DEFAULTS, SIMPLE_LENGTHS, projectFeeFor, PICTURE_USD, USD_PER_CREDIT, creditsForMargin, PICTURES_PER_CAST_REDRAW, PICTURES_PER_CAST_FROM_PICTURE, freeRedrawsExpectedUsd,
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
    expect(await quoteShot({ quality: 'pro_narrated', seconds: 2.2 })).toBe(48);
  });
  it('rounds seconds up', async () => {
    expect(await quoteShot({ quality: 'standard', seconds: 4.1 })).toBe(40);
  });
  it('throws on unknown quality or bad seconds', async () => {
    await expect(quoteShot({ quality: 'ultra', seconds: 5 })).rejects.toThrow(/quality/);
    await expect(quoteShot({ quality: 'economy', seconds: 0 })).rejects.toThrow(/seconds/);
    await expect(quoteShot({ quality: 'economy', seconds: NaN })).rejects.toThrow(/seconds/);
  });
  it('quotes 15 pro_narrated 3 second shots plus the fee as 720', async () => {
    const shots = Array.from({ length: 15 }, () => ({ quality: 'pro_narrated', seconds: 3 }));
    const q = await quoteProject({ shots, feeAlreadyCharged: false });
    expect(q.total).toBe(810);
    expect(q.lines.reduce((n, l) => n + l.credits, 0)).toBe(810);
    expect(q.lines.some((l) => /fee/i.test(l.label) && l.credits === 90)).toBe(true);
    expect(q.lines.map((l) => l.label)).toContain('15 Pro shots');
  });
  it('omits the fee when already charged', async () => {
    const q = await quoteProject({ shots: [{ quality: 'economy', seconds: 5 }], feeAlreadyCharged: true });
    expect(q.total).toBe(35);
    expect(q.lines).toHaveLength(1);
  });
});

describe('getPricing', () => {
  it('carries the redraw and the look-alike prices; a saved row overrides either', async () => {
    setPricingDb(fakeDb([]));
    const p = await getPricing();
    expect(p.castRegen).toBe(19);
    expect(p.castFromPicture).toBe(19);
    setPricingDb(fakeDb([{ key: 'castFromPicture', value: 25 }]));
    _resetPricingCache();
    expect((await getPricing()).castFromPicture).toBe(25);
    expect((await getPricing()).castRegen).toBe(19);
  });
  it('returns defaults when pricing_config is empty', async () => {
    setPricingDb(fakeDb([]));
    const p = await getPricing();
    expect(p.perSecond).toEqual({ economy: 7, standard: 8, pro_narrated: 16, pro_talking: 21 });
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
    expect(p.perSecond).toEqual({ economy: 9, standard: 8, pro_narrated: 16, pro_talking: 21 });
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
    expect((await getPricing()).perSecond.economy).toBe(7);
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
    expect(short.total).toBe(45 + 40);
  });
  it('getPricing reads projectFeeShort from pricing_config', async () => {
    setPricingDb(fakeDb([{ key: 'projectFeeShort', value: 50 }]));
    expect((await getPricing()).projectFeeShort).toBe(50);
  });
});

describe('labels', () => {
  it('has display names', () => {
    expect(QUALITY_LABELS).toEqual({ economy: 'Budget', standard: 'Standard', pro_narrated: 'Pro', pro_talking: 'Pro Max' });
  });
});

describe('the 70% rule', () => {
  const QUALITIES = ['economy', 'standard', 'pro_narrated', 'pro_talking'];
  const LENGTHS = [7, 10, 30, 60, 120];
  const OFFERS = [...Object.values(PLANS_V2), ...Object.values(TOPUPS_V2)];
  const net = (usd) => usd - 0.029 * usd - 0.3; // after Stripe's 2.9% + $0.30

  it('keeps provider costs as agreed', () => {
    // Measured 2026-11-17: kie.ai charged 18 credits = 0.09 dollars for every picture.
    expect(PROVIDER_COSTS_USD.still).toBe(0.09);
    expect(PICTURE_USD).toBe(0.09);
    // 4 pictures (2 characters x (1 picture + 1 sheet)) x 0.09, plus the 0.68 the old 0.84 held besides its 8 pictures at 0.02
    // (script and analysis calls, narration, music, render: not zeroed, still the earlier assumption). Was 8 pictures (3 options + sheet) = 1.40.
    expect(PROVIDER_COSTS_USD.projectFixed).toBeCloseTo(4 * 0.09 + 0.68, 10);
    expect(PROVIDER_COSTS_USD.projectFixed).toBeCloseTo(1.04, 10);
    // The included free redraws (2 per character, 2 characters, 2 pictures each: the picture and its sheet) at the 20% allowance:
    // 0.144 dollars expected (was 0.288 with 4 pictures each).
    expect(freeRedrawsExpectedUsd()).toBeCloseTo(0.2 * 2 * 2 * 2 * 0.09, 10);
    expect(freeRedrawsExpectedUsd()).toBeCloseTo(0.144, 10);
    expect(PROVIDER_COSTS_USD.rerollAllowance).toBe(0.2);
  });
  it('prices every picture-backed credit price at the smallest whole number that keeps 70% margin, from one place', () => {
    expect(creditsForMargin(0.09)).toBe(10);
    expect(creditsForMargin(0.18)).toBe(19);
    // A redraw is one picture and its sheet; "make them look like a picture" is the same two pictures, so the same price (was 38 for 4).
    expect(PICTURES_PER_CAST_REDRAW).toBe(2);
    expect(PICTURES_PER_CAST_FROM_PICTURE).toBe(2);
    expect(DEFAULTS.stillReroll).toBe(10);
    expect(DEFAULTS.castRegen).toBe(19);
    expect(DEFAULTS.castFromPicture).toBe(19);
    for (const [credits, cost] of [[DEFAULTS.stillReroll, PROVIDER_COSTS_USD.still], [DEFAULTS.castRegen, PICTURES_PER_CAST_REDRAW * PROVIDER_COSTS_USD.still], [DEFAULTS.castFromPicture, PICTURES_PER_CAST_FROM_PICTURE * PROVIDER_COSTS_USD.still]]) {
      expect(1 - cost / (credits * USD_PER_CREDIT)).toBeGreaterThanOrEqual(0.7);
      expect(1 - cost / ((credits - 1) * USD_PER_CREDIT)).toBeLessThan(0.7); // one credit less would break the rule
    }
  });
  // The model's margin per cell (revenue = credits x 29/900, before Stripe's fee; cost = costOfVideoUsd). Every number is
  // pinned, so any change of a cost or a rate turns this red: change the table on purpose, with the owner's decision.
  const MARGIN_PCT = {
    // One picture per character (4 fixed pictures, not 8) and 2 pictures per free redraw (not 4): every cell is about 1 to 9 points higher.
    economy: { 10: 60.7, 30: 61.3, 60: 61.7, 120: 61.9 },
    standard: { 10: 61.0, 30: 61.8, 60: 62.2, 120: 62.5 },
    pro_narrated: { 10: 64.2, 30: 65.4, 60: 66.0, 120: 66.3 },
    pro_talking: { 10: 65.6, 30: 66.8, 60: 67.3, 120: 67.6 },
  };
  const marginPct = (quality, seconds) => 100 * (1 - costOfVideoUsd({ quality, seconds }) / (creditsForVideo({ quality, seconds }) * USD_PER_CREDIT));
  it('pins the margin of every quality at 10, 30, 60 and 120 seconds to the table (within 0.2 points)', () => {
    for (const quality of QUALITIES) {
      for (const seconds of [10, 30, 60, 120]) {
        expect(Math.abs(marginPct(quality, seconds) - MARGIN_PCT[quality][seconds]), `${quality} ${seconds}s is ${marginPct(quality, seconds).toFixed(2)}%`).toBeLessThanOrEqual(0.2);
      }
    }
  });
  // KNOWN BREACH of the 70% rule (owner decision pending): all 16 cells. When prices change, edit this list and the table above.
  const KNOWN_BELOW_70 = QUALITIES.flatMap((q) => [10, 30, 60, 120].map((s) => `${q} ${s}s`));
  it('lists exactly the cells under 70% as the known breach', () => {
    const below = QUALITIES.flatMap((q) => LENGTHS.filter((s) => [10, 30, 60, 120].includes(s)).map((s) => [q, s])).filter(([q, s]) => marginPct(q, s) < 70).map(([q, s]) => `${q} ${s}s`);
    expect(below).toEqual(KNOWN_BELOW_70);
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
    expect(creditsForVideo({ quality: 'pro_narrated', seconds: 45 })).toBe(810);
    expect(creditsForVideo({ quality: 'standard', seconds: 30 })).toBe(330);
    expect(creditsForVideo({ quality: 'pro_talking', seconds: 60 })).toBe(1350);
  });
  it('rounds generated seconds up to whole shots', () => {
    expect(creditsForVideo({ quality: 'standard', seconds: 10 })).toBe(90 + 8 * 12);
    expect(creditsForVideo({ quality: 'standard', seconds: 10, shotSeconds: 5 })).toBe(90 + 8 * 10);
    expect(costOfVideoUsd({ quality: 'standard', seconds: 30 })).toBeCloseTo((0.05 * 30 + 0.09 * 10) * 1.2 + 1.04 + 0.144, 10);
  });
  it('counts whole videos per plan', () => {
    expect(videosPerPlan({ credits: 1500, quality: 'pro_narrated', seconds: 45 })).toBe(1);
    expect(videosPerPlan({ credits: 2600, quality: 'standard', seconds: 30 })).toBe(7);
    expect(videosPerPlan({ credits: 5400, quality: 'pro_talking', seconds: 60 })).toBe(4);
  });
});
