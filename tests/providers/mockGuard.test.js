// Final review M4: STORY_MOCK must never take effect on the production deployment (real credits would be charged
// for fixture clips and the model layer of moderation skipped).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMock } from '../../lib/providers/mock.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('isMock', () => {
  it('is on with STORY_MOCK=1 outside production', () => {
    vi.stubEnv('STORY_MOCK', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(isMock()).toBe(true);
  });

  it('is off on the production deployment even with STORY_MOCK=1, and says so', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('STORY_MOCK', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(isMock()).toBe(false);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/STORY_MOCK/);
  });
});
