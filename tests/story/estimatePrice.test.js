import { describe, it, expect } from 'vitest';

import { DEFAULTS, SIMPLE_LENGTHS, plannedShotSeconds } from '../../lib/pricingConstants.js';
import { creditsForShot, projectFeeFor } from '../../lib/pricing.js';
import { storyShotsMock } from '../../lib/story/mocks.js';
import { estimateCredits } from '../../components/maker/steps.js';

const QUALITIES = ['economy', 'standard', 'pro_narrated', 'pro_talking'];

// What the plan step charges for a default plan: the planner's shots, each priced by the server's creditsForShot.
function planStepPrice({ quality, seconds, feeCharged }) {
  const scenes = [{ id: 's1', title: 'One', visual: 'A.', lines: [{ speaker: 'narrator', text: 'Hello.' }] }, { id: 's2', title: 'Two', visual: 'B.', lines: [{ speaker: 'narrator', text: 'Bye.' }] }];
  const { shots } = storyShotsMock({ messages: [{ role: 'user', content: `<shot_brief>\n${JSON.stringify({ seconds, scenes, cast: [] })}\n</shot_brief>` }] });
  const clips = shots.reduce((n, s) => n + creditsForShot(DEFAULTS, quality, s.seconds), 0);
  return clips + (feeCharged ? 0 : projectFeeFor(DEFAULTS, seconds));
}

describe('the length picker estimate equals the plan step price for a default plan', () => {
  for (const seconds of SIMPLE_LENGTHS) {
    for (const quality of QUALITIES) {
      it(`${seconds} s ${quality}`, () => {
        expect(estimateCredits({ seconds, quality, fee_charged: false })).toBe(planStepPrice({ quality, seconds, feeCharged: false }));
        // After the fee is paid the remaining cost follows the same rule.
        expect(estimateCredits({ seconds, quality, fee_charged: true })).toBe(planStepPrice({ quality, seconds, feeCharged: true }));
      });
    }
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
