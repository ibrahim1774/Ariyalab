// Test setup shared by the story tests.
import { afterAll, beforeAll, vi } from 'vitest';

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
