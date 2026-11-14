// uses tests/helpers/storyEnv.js useRegexOnlyModeration()
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';

const entitlement = vi.hoisted(() => ({ value: { tier: 'none' } }));
vi.mock('../../lib/entitlement.js', () => ({
  getEntitlement: vi.fn(async () => entitlement.value),
}));
vi.mock('../../lib/supabaseServer.js', () => ({
  getSupabaseAdmin: () => ({ fake: 'admin' }),
  getUserFromRequest: async () => null,
}));

const { setStoryDb } = await import('../../lib/story/db.js');
const { setCreditsDb, grantCredits } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache } = await import('../../lib/pricing.js');
const { getEntitlement } = await import('../../lib/entitlement.js');
const { LimitError, sendError } = await import('../../lib/story/errors.js');
const { ModerationError } = await import('../../lib/moderation.js');
const { createProject, duplicateProject } = await import('../../lib/story/projects.js');
const { assertAllowed, isPaidUser, LIMIT_ACTIONS, PAID_ONLY_ACTIONS, setLimitsDeps } = await import('../../lib/story/limits.js');
const { makeRes } = await import('../helpers/apiMock');

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
}, 60_000);

afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  await raw?.close();
});

beforeEach(async () => {
  await raw.query('delete from public.pricing_config');
  _resetPricingCache();
});

const setConfig = async (key, value) => {
  await raw.query(
    'insert into public.pricing_config (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value',
    [key, JSON.stringify(value)]
  );
  _resetPricingCache();
};

const free = () => accounts.set({ paid: false, verified: true });
const input = { purpose: 'app', seconds: 30 };

describe('assertAllowed', () => {
  it("stops a free user's fourth project in a day with a LimitError (429)", async () => {
    free();
    const userId = randomUUID();
    for (let i = 0; i < 3; i += 1) await createProject({ userId, input });
    const err = await createProject({ userId, input }).catch((e) => e);
    expect(err).toBeInstanceOf(LimitError);
    expect(err).toMatchObject({ status: 429, code: 'daily_limit' });
    const res = makeRes();
    sendError(res, err);
    expect(res.statusCode).toBe(429);
    expect(res.body.message).toMatch(/3 videos a day/);
  });

  it('counts a duplicate as a new project', async () => {
    free();
    const userId = randomUUID();
    const p = await createProject({ userId, input });
    await duplicateProject({ userId, id: p.id });
    await duplicateProject({ userId, id: p.id });
    await expect(duplicateProject({ userId, id: p.id })).rejects.toMatchObject({ code: 'daily_limit' });
  });

  it('does not use up the daily count on a request that fails moderation', async () => {
    free();
    const userId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await expect(createProject({ userId, input: { ...input, title: 'nude' } })).rejects.toBeInstanceOf(ModerationError);
    }
    for (let i = 0; i < 3; i += 1) await createProject({ userId, input });
  });

  it('lets a paid user make as many projects as they like', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 5; i += 1) await createProject({ userId, input });
  });

  it('allows one reference analysis a day on a free account', async () => {
    free();
    const userId = randomUUID();
    await assertAllowed({ userId, action: 'reference_analysis' });
    await expect(assertAllowed({ userId, action: 'reference_analysis' })).rejects.toMatchObject({ status: 429, code: 'daily_limit' });
  });

  it('needs a verified email on a free account', async () => {
    accounts.set({ paid: false, verified: false });
    await expect(assertAllowed({ userId: randomUUID(), action: 'project_create' })).rejects.toMatchObject({ status: 403, code: 'email_unverified' });
    accounts.set({ paid: true, verified: false });
    await expect(assertAllowed({ userId: randomUUID(), action: 'project_create' })).resolves.toBeUndefined();
  });

  it('uses the session user when one is passed instead of looking the account up', async () => {
    const getUser = vi.fn();
    setLimitsDeps({ isPaidUser: async () => false, getUser });
    await assertAllowed({ userId: randomUUID(), action: 'script_write', user: { email: 'x@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } });
    expect(getUser).not.toHaveBeenCalled();
  });

  it('throws plan_required (402) for paid only actions on a free account', async () => {
    free();
    for (const action of PAID_ONLY_ACTIONS) {
      const err = await assertAllowed({ userId: randomUUID(), action }).catch((e) => e);
      expect(err).toMatchObject({ status: 402, code: 'plan_required' });
      const res = makeRes();
      sendError(res, err);
      expect(res.statusCode).toBe(402);
      expect(res.body.error).toBe('plan_required');
    }
    accounts.set({ paid: true });
    await expect(assertAllowed({ userId: randomUUID(), action: 'cast_generate' })).resolves.toBeUndefined();
  });

  it('caps chat messages per project: 30 free, the included 150 when paid', async () => {
    await setConfig('free_limits', { chatPerProject: 2 });
    await setConfig('included', { chat: 3 });
    free();
    const userId = randomUUID();
    const projectId = randomUUID();
    await assertAllowed({ userId, action: 'chat_message', projectId });
    await assertAllowed({ userId, action: 'chat_message', projectId });
    await expect(assertAllowed({ userId, action: 'chat_message', projectId })).rejects.toMatchObject({ status: 429, code: 'chat_limit' });
    await assertAllowed({ userId, action: 'chat_message', projectId: randomUUID() });
    accounts.set({ paid: true });
    await assertAllowed({ userId, action: 'chat_message', projectId });
    await expect(assertAllowed({ userId, action: 'chat_message', projectId })).rejects.toMatchObject({ code: 'chat_limit' });
    await expect(assertAllowed({ userId, action: 'chat_message' })).rejects.toThrow(/projectId/);
  });

  it('reads the default caps from spec section 8', () => {
    expect(LIMIT_ACTIONS.project_create).toMatchObject({ freeCap: 'projectsPerDay' });
    expect(LIMIT_ACTIONS.reference_analysis).toMatchObject({ freeCap: 'analysesPerDay' });
  });

  it('rejects an unknown action', async () => {
    await expect(assertAllowed({ userId: randomUUID(), action: 'teleport' })).rejects.toThrow(/Unknown/);
  });
});

describe('isPaidUser', () => {
  beforeEach(() => setLimitsDeps({ getUser: async () => ({ email: 'x@example.test', email_confirmed_at: 'x' }) }));

  it('reads the existing entitlement when billing v2 is off', async () => {
    entitlement.value = { tier: 'none' };
    expect(await isPaidUser(randomUUID(), { email: 'x@example.test' })).toBe(false);
    entitlement.value = { tier: 'monthly', status: 'active' };
    expect(await isPaidUser(randomUUID(), { email: 'x@example.test' })).toBe(true);
    expect(getEntitlement).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'x@example.test', supabase: { fake: 'admin' } }));
  });

  it('reads the credit balance when billing v2 is on', async () => {
    await setConfig('billing_v2', true);
    entitlement.value = { tier: 'monthly', status: 'active' };
    const userId = randomUUID();
    expect(await isPaidUser(userId, {})).toBe(false);
    await grantCredits({ userId, currency: 'video', amount: 5, bucket: 'topup', reason: 'test', ref: randomUUID() });
    expect(await isPaidUser(userId, {})).toBe(true);
  });
});
