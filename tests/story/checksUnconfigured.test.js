import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/providers/stt.js', () => ({ transcribe: vi.fn(async () => { throw new Error('should not be called'); }) }));
vi.mock('../../lib/providers/capabilities.js', async (importOriginal) => ({ ...(await importOriginal()), transcriptionConfigured: () => false }));

const { transcribe } = await import('../../lib/providers/stt.js');
const checks = await import('../../lib/story/checks.js');
const path = await import('node:path');

afterEach(() => vi.restoreAllMocks());

describe('word check without a transcription key', () => {
  it('is skipped quietly: no words_unchecked warning for the customer, a log line for us', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const render = path.resolve('tests/fixtures/reference.mp4');
    const out = await checks.run({ renderPath: render, scriptWords: ['once', 'upon', 'a', 'time'] });
    expect(transcribe).not.toHaveBeenCalled();
    expect(out.failures.map((f) => f.code)).not.toContain('words_unchecked');
    expect(out.failures.map((f) => f.code)).not.toContain('words');
    expect(out.measures.coverage).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/speech transcription.*not configured/);
  }, 60_000);
});
