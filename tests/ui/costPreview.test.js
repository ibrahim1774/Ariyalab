// Client cost previews show what the server will charge: the entitlement's
// `billing` flag picks legacy or v2 prices from lib/cost.js (the function
// the routes use). Round-1 finding I5.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DurationSlider, { costForDuration } from '../../components/DurationSlider';
import ResolutionPicker from '../../components/ResolutionPicker';
import { costForGeneration, v2CostForGeneration } from '../../lib/cost';

describe('cost previews follow the billing flag', () => {
  it('costForDuration is the server price for that billing', () => {
    expect(costForDuration(5, 'standard', '480p', true)).toBe(costForGeneration({ seconds: 5, audio: true }));
    expect(costForDuration(5, 'standard', '480p', true, 'v2')).toBe(v2CostForGeneration({ seconds: 5, audio: true }));
    expect(costForDuration(5, 'standard', '480p', true, 'v2')).toBe(16);
  });

  it('DurationSlider labels v2 prices as new credits', () => {
    const legacy = renderToStaticMarkup(<DurationSlider value={5} onChange={() => {}} audio />);
    expect(legacy).toContain('75 credits');
    const v2 = renderToStaticMarkup(<DurationSlider value={5} onChange={() => {}} audio billing="v2" />);
    expect(v2).toContain('16 credits');
    expect(v2).not.toContain('75 credits');
  });

  it('ResolutionPicker shows the v2 rate when billing is v2', () => {
    const legacy = renderToStaticMarkup(<ResolutionPicker model="studio-pro" resolution="1080p" audio />);
    expect(legacy).toContain('100 cr/sec');
    const v2 = renderToStaticMarkup(<ResolutionPicker model="studio-pro" resolution="1080p" audio billing="v2" />);
    expect(v2).toContain('21 cr/sec');
  });
});
