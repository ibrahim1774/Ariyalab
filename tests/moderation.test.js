import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setMockEnv } from './helpers/mockEnv';

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

const { screenText, screenImage, ModerationError, MODERATION_UNAVAILABLE, __test } = await import('../lib/moderation');

beforeEach(() => {
  create.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setMockEnv();
});

describe('regexCheck', () => {
  it('gives the same answer three times in a row', () => {
    const blocked = Array.from({ length: 3 }, () => __test.regexCheck('a naked person'));
    expect(blocked.every((r) => r !== null)).toBe(true);
    expect(blocked[1]).toEqual(blocked[0]);
    expect(blocked[2]).toEqual(blocked[0]);
    const clean = Array.from({ length: 3 }, () => __test.regexCheck('a cat on a sofa'));
    expect(clean).toEqual([null, null, null]);
  });
});

describe('screenText', () => {
  it('rejects when the LLM check throws', async () => {
    create.mockRejectedValue(new Error('network down'));
    const err = await screenText('a cat on a sofa').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe(MODERATION_UNAVAILABLE);
  });

  it('passes a clean prompt when the LLM check succeeds', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: '{"sexual": false, "minor": false, "reason": "ok"}' }],
    });
    await expect(screenText('a cat on a sofa')).resolves.toEqual({ ok: true });
  });
});

describe('screenText fail-closed config and responses', () => {
  it('rejects when ANTHROPIC_API_KEY is missing and not in mock mode', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.STORY_MOCK;
    const err = await screenText('a cat on a sofa').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe(MODERATION_UNAVAILABLE);
  });

  it('passes when ANTHROPIC_API_KEY is missing in STORY_MOCK mode', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.STORY_MOCK = '1';
    await expect(screenText('a cat on a sofa')).resolves.toEqual({ ok: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects when the response has no text block', async () => {
    create.mockResolvedValue({ content: [] });
    const err = await screenText('a cat on a sofa').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe(MODERATION_UNAVAILABLE);
  });

  it('rejects when the JSON is not an object', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'null' }] });
    const err = await screenText('a cat on a sofa').catch((e) => e);
    expect(err.reason).toBe(MODERATION_UNAVAILABLE);
  });
});

describe('screenImage', () => {
  it('rejects when the LLM image call throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    create.mockRejectedValue(new Error('api down'));
    const err = await screenImage('https://example.com/b.jpg').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe(MODERATION_UNAVAILABLE);
  });

  it('rejects when the image cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const err = await screenImage('https://example.com/a.jpg').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.reason).toBe(MODERATION_UNAVAILABLE);
  });
});
