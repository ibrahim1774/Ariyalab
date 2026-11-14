import { describe, it, expect } from 'vitest';
import { validateEditPlan } from '../lib/editPlan';

function planWithColor(color) {
  return {
    sourceUrl: 'https://example.com/v.mp4',
    duration: 10,
    width: 1080,
    height: 1920,
    operations: [
      { id: 'op_1', type: 'textOverlay', text: 'Hi', start: 0, end: 2, color },
    ],
  };
}

describe('validateEditPlan overlay color', () => {
  it('rejects overlay color "red:fontfile=/etc/passwd"', () => {
    const r = validateEditPlan(planWithColor('red:fontfile=/etc/passwd'));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/color/);
  });

  it('accepts #FFAA00 and #fa0', () => {
    expect(validateEditPlan(planWithColor('#FFAA00')).valid).toBe(true);
    expect(validateEditPlan(planWithColor('#fa0')).valid).toBe(true);
  });

  it('accepts a missing color', () => {
    expect(validateEditPlan(planWithColor(undefined)).valid).toBe(true);
  });
});
