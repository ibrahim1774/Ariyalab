// Test setup shared by the story tests.
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Only the regex layer of lib/moderation.js screenText runs. mockEnv sets a
 * fake ANTHROPIC_API_KEY, and with a key present the classifier layer would
 * call Anthropic; with no key and STORY_MOCK=1 that layer is skipped.
 * Call at the top level of a test file.
 */
export function useRegexOnlyModeration() {
  beforeAll(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
}

/**
 * Injects the account checks lib/story/limits.js makes, so tests never reach
 * Stripe or the Supabase admin API. Every test starts as a paid account with
 * a verified email; `accounts.set({ paid, verified })` changes that for the
 * current test. Call at the top level of a test file.
 */
export function useTestAccounts() {
  const state = { paid: true, verified: true };
  beforeEach(async () => {
    state.paid = true;
    state.verified = true;
    const { setLimitsDeps } = await import('../../lib/story/limits.js');
    setLimitsDeps({
      isPaidUser: async () => state.paid,
      getUser: async (id) => ({ id, email: 'test@example.test', email_confirmed_at: state.verified ? '2026-01-01T00:00:00.000Z' : null }),
    });
  });
  afterAll(async () => {
    const { setLimitsDeps } = await import('../../lib/story/limits.js');
    setLimitsDeps();
  });
  return { set: (patch) => Object.assign(state, patch) };
}
