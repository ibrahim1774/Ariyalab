import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() {
      this.messages = { create };
    }
  },
}));

vi.mock('../lib/supabaseServer', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      upsert: async () => ({}),
    }),
  }),
}));

const { screenText, screenImage, ModerationError, __test } = await import('../lib/moderation');

beforeEach(() => {
  create.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('regexCheck', () => {
  it('gives the same answer three times in a row', () => {
    const blocked = 'a naked person';
    const clean = 'a cat on a sofa';
    const first = [__test.regexCheck(blocked), __test.regexCheck(clean)];
    expect(first[0]).not.toBeNull();
    expect(first[1]).toBeNull();
    for (let i = 0; i < 2; i++) {
      expect(__test.regexCheck(blocked)).toEqual(first[0]);
      expect(__test.regexCheck(clean)).toBeNull();
    }
  });
});

describe('screenText', () => {
  it('rejects when the LLM check throws', async () => {
    create.mockRejectedValue(new Error('network down'));
    const err = await screenText('a cat on a sofa').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe('unavailable');
  });

  it('passes a clean prompt when the LLM check succeeds', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: '{"sexual": false, "minor": false, "reason": "ok"}' }],
    });
    await expect(screenText('a cat on a sofa')).resolves.toEqual({ ok: true });
  });
});

describe('screenImage', () => {
  it('rejects when the image cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const err = await screenImage('https://example.com/a.jpg').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe('unavailable');
    vi.unstubAllGlobals();
  });
});
