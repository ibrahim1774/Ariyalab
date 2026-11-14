import { describe, it, expect } from 'vitest';
import { visibleTools, LEGACY_TOOLS } from '../lib/legacyTools';

describe('visibleTools', () => {
  it.each([
    [false, false, 1],
    [true, false, LEGACY_TOOLS.length],
    [false, true, LEGACY_TOOLS.length],
    [true, true, LEGACY_TOOLS.length],
  ])('tabsEnabled=%s isAdmin=%s shows %s tools', (tabsEnabled, isAdmin, n) => {
    const tools = visibleTools({ tabsEnabled, isAdmin });
    expect(tools).toHaveLength(n);
    expect(tools[0].href).toBe('/legacy-home');
  });

  it('lists the six tools plus history', () => {
    expect(LEGACY_TOOLS.map((t) => t.label)).toEqual([
      'Image to Video', 'Face Swap', 'UGC Creator', 'Glow Up', 'Interior Design', 'Video Editor', 'History',
    ]);
  });
});
