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

  it('round 2: the v2 per-second rate is not rounded (it agrees with the charged total)', () => {
    const v2 = renderToStaticMarkup(<ResolutionPicker model="standard" resolution="480p" audio billing="v2" />);
    expect(v2).toContain('3.15 cr/sec'); // 15/s x 0.21; 5 s is charged ceil(15.75) = 16
  });

  it('round 2: /ugc-3 passes the billing flag to its pickers', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../pages/ugc-3/index.js', import.meta.url), 'utf8');
    const tags = src.match(/<(DurationSlider|ResolutionPicker)\b[^>]*/g) || [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('billing={entitlement?.billing}');
    expect(src).not.toMatch(/costForDuration\(duration, model, resolution, audio\)/);
  });
});
