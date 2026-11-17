// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../lib/story/client';
import { describeError } from '../../components/maker/errors';

afterEach(() => vi.unstubAllGlobals());

const refuse = (status, body) => {
  const fn = vi.fn(async () => ({ ok: false, status, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
};

describe('a step refused for lack of credits', () => {
  it('when credits would pay for it, the client says how many credits it needs and offers Get credits, not a plan', async () => {
    refuse(402, { error: 'plan_required', message: 'x', action: 'cast_generate', topup_ok: true });
    const err = await client.startCast('p1', 90).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: 'plan_required', needed: 90, available: 0 });
    const info = describeError(err);
    expect(info.title).toBe('Not enough credits');
    expect(info.message).toBe('You need 90 more credits. This takes 90 and you have 0.');
    expect(info.message).not.toMatch(/plan/i);
    expect(info.action).toEqual({ label: 'Get credits', href: '/app/billing' });
  });

  it('reads the price from every priced call (generate sends confirmTotal)', async () => {
    refuse(402, { error: 'plan_required', topup_ok: true });
    expect(await client.startGeneration('p1', ['s1'], 80).catch((e) => e)).toMatchObject({ needed: 80, available: 0 });
    expect(await client.makeStills('p1', ['s1'], 2).catch((e) => e)).toMatchObject({ needed: 2 });
  });

  it('when the price is unknown or nothing, it still says credits, never a plan', async () => {
    refuse(402, { error: 'plan_required', topup_ok: true });
    for (const err of [await client.buildShots('p1').catch((e) => e), await client.startCast('p1', 0).catch((e) => e)]) {
      const info = describeError(err);
      expect(info.title).toBe('Not enough credits');
      expect(info.message).not.toMatch(/plan/i);
      expect(info.message).not.toMatch(/\b0 more\b/);
      expect(info.action).toEqual({ label: 'Get credits', href: '/app/billing' });
    }
  });

  it('a plan is still asked for when the server says credits would not do (no topup_ok)', async () => {
    refuse(402, { error: 'plan_required', message: 'This step needs a paid plan. Pick a plan to keep going.' });
    const info = describeError(await client.startCast('p1', 90).catch((e) => e));
    expect(info.title).toBe('This step needs a plan');
    expect(info.action).toEqual({ label: 'See plans', href: '/app/billing' });
  });

  it('a plain shortfall says Get credits too', () => {
    const info = describeError({ status: 402, code: 'insufficient_credits', needed: 40, available: 30 });
    expect(info.message).toBe('You need 10 more credits. This takes 40 and you have 30.');
    expect(info.action).toEqual({ label: 'Get credits', href: '/app/billing' });
  });
});
