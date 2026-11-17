import { describe, it, expect } from 'vitest';

import { DEFAULTS, SIMPLE_LENGTHS, plannedShotSeconds } from '../../lib/pricingConstants.js';
import { creditsForShot, projectFeeFor } from '../../lib/pricing.js';
import { storyScriptMock, storyShotsMock } from '../../lib/story/mocks.js';
import { estimateCredits } from '../../components/maker/steps.js';

const QUALITIES = ['economy', 'standard', 'pro_narrated', 'pro_talking'];

const mockPlan = (seconds) => {
  const brief = { seconds, mode: 'narrated', purpose: 'story', offer: 'A barber turns a bad haircut into a comeback' };
  const { scenes } = storyScriptMock({ messages: [{ role: 'user', content: `<brief>\n${JSON.stringify(brief)}\n</brief>` }] });
  const { shots } = storyShotsMock({ messages: [{ role: 'user', content: `<shot_brief>\n${JSON.stringify({ seconds, scenes, cast: [] })}\n</shot_brief>` }] });
  return { scenes, shots };
};

// The mock storyboard's split BEFORE it shared plannedShotSeconds (as it was in git at 4511ba1): at least ceil(ceil(0.9 x length) / 6)
// shots, one per script line otherwise, seconds spread evenly and clamped to 3..6.
const oldMockSeconds = (total, lineShots) => {
  const n = Math.max(lineShots, Math.ceil(Math.ceil(total * 0.9) / 6));
  return Array.from({ length: n }, (_, i) => Math.min(6, Math.max(3, Math.floor(total / n) + (i < total % n ? 1 : 0))));
};

describe('the mock storyboard keeps what a default STORY_MOCK project is charged', () => {
  for (const seconds of SIMPLE_LENGTHS) {
    it(`${seconds} s: the default script gets exactly the shots it got before`, () => {
      const { scenes, shots } = mockPlan(seconds);
      // The shots the script itself asks for: one per line, or one for a scene with no words.
      const lineShots = scenes.reduce((n, sc) => n + Math.max(1, (sc.lines || []).length), 0);
      expect(shots.map((x) => x.seconds)).toEqual(oldMockSeconds(seconds, lineShots));
      expect(shots.reduce((n, x) => n + x.seconds, 0)).toBe(seconds);
    });
  }
});

// What the plan step charges for a default plan: the mock script writer's own script for this length, split into shots by the
// mock storyboard, each shot priced by the server's creditsForShot, plus the project fee.
function planStepPrice({ quality, seconds, feeCharged }) {
  const { shots } = mockPlan(seconds);
  const clips = shots.reduce((n, x) => n + creditsForShot(DEFAULTS, quality, x.seconds), 0);
  return clips + (feeCharged ? 0 : projectFeeFor(DEFAULTS, seconds));
}

describe('the length picker estimate equals the plan step price for a default plan', () => {
  // Standard and both Pro qualities: every shot is 3 s or more, so the price is the shot seconds x the rate whatever the split.
  // Exact for every length, against the mock script writer's real script.
  for (const seconds of SIMPLE_LENGTHS) {
    for (const quality of ['standard', 'pro_narrated', 'pro_talking']) {
      it(`${seconds} s ${quality}`, () => {
        expect(estimateCredits({ seconds, quality, fee_charged: false })).toBe(planStepPrice({ quality, seconds, feeCharged: false }));
        // After the fee is paid the remaining cost follows the same rule.
        expect(estimateCredits({ seconds, quality, fee_charged: true })).toBe(planStepPrice({ quality, seconds, feeCharged: true }));
      });
    }
  }

  // Budget makes 4 s at least, so a script that cuts the length into shots shorter than 4 s is billed more than the length: the
  // price depends on how many shots the script has, which is unknown before it exists. The estimate is the lowest honest price (as
  // few shots as reach the length) and stays labelled "Estimated"; it is exact when the plan is that split (7 s and 10 s).
  for (const seconds of SIMPLE_LENGTHS) {
    it(`${seconds} s economy is a lower bound of the plan price, exact when the shots are 4 s or longer`, () => {
      const est = estimateCredits({ seconds, quality: 'economy', fee_charged: false });
      const plan = planStepPrice({ quality: 'economy', seconds, feeCharged: false });
      expect(est).toBeLessThanOrEqual(plan);
      if (seconds <= 10) expect(est).toBe(plan);
      expect(plan - est).toBeLessThanOrEqual(Math.ceil(est * 0.15));
    });
  }

  it('10 s Standard is 170 (90 fee + 2 shots of 5 s at 8)', () => {
    expect(estimateCredits({ seconds: 10, quality: 'standard' })).toBe(170);
    expect(estimateCredits({ seconds: 10, quality: 'standard', fee_charged: true })).toBe(80);
  });

  it('plans whole seconds of 3 to 6 per shot that add up to the length', () => {
    for (const seconds of SIMPLE_LENGTHS) {
      const plan = plannedShotSeconds(seconds);
      expect(plan.reduce((a, b) => a + b, 0)).toBe(seconds);
      expect(Math.min(...plan)).toBeGreaterThanOrEqual(3);
      expect(Math.max(...plan)).toBeLessThanOrEqual(6);
    }
  });

  it('a shot shorter than the quality minimum is priced at the minimum (Budget makes 4 s at least)', () => {
    // 7 s is 4 s + 3 s: the 3 s shot is made and priced as 4 s.
    expect(plannedShotSeconds(7)).toEqual([4, 3]);
    expect(estimateCredits({ seconds: 7, quality: 'economy', fee_charged: true })).toBe(8 * DEFAULTS.perSecond.economy);
  });
});
