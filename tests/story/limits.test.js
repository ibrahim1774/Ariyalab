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
const { assertAllowed, isPaidUser, LIMIT_ACTIONS, PAID_ONLY_ACTIONS, releaseAllowance, setLimitsDeps } = await import('../../lib/story/limits.js');
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
    await expect(assertAllowed({ userId: randomUUID(), action: 'project_create' })).resolves.toMatchObject({ counters: [] });
  });

  it('uses the session user when one is passed instead of looking the account up', async () => {
    const getUser = vi.fn();
    setLimitsDeps({ isPaidUser: async () => false, getUser });
    await assertAllowed({ userId: randomUUID(), action: 'script_write', projectId: randomUUID(), user: { email: 'x@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } });
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
    await expect(assertAllowed({ userId: randomUUID(), action: 'cast_generate' })).resolves.toMatchObject({ counters: [] });
  });

  it('says whether credits would pay for the step: yes under billing v2 (credits make an account paid), no for a plan-only world', async () => {
    free();
    const legacy = await assertAllowed({ userId: randomUUID(), action: 'cast_generate' }).catch((e) => e);
    expect(legacy).toMatchObject({ status: 402, code: 'plan_required' });
    expect(legacy.extra.topup_ok).toBe(false);
    await setConfig('billing_v2', true);
    const v2 = await assertAllowed({ userId: randomUUID(), action: 'cast_generate' }).catch((e) => e);
    expect(v2).toMatchObject({ status: 402, code: 'plan_required' });
    expect(v2.extra.topup_ok).toBe(true);
    expect(v2.message).not.toMatch(/paid plan/i);
    const res = makeRes();
    sendError(res, v2);
    expect(res.body).toMatchObject({ error: 'plan_required', topup_ok: true });
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
    entitlement.value = { tier: 'none' };
    const userId = randomUUID();
    expect(await isPaidUser(userId, {})).toBe(false);
    await grantCredits({ userId, currency: 'video', amount: 5, bucket: 'topup', reason: 'test', ref: randomUUID() });
    expect(await isPaidUser(userId, {})).toBe(true);
  });

  it('counts an active or trialing subscriber at zero balance as paid under billing v2', async () => {
    await setConfig('billing_v2', true);
    for (const status of ['active', 'trialing']) {
      entitlement.value = { tier: 'creator', status };
      expect(await isPaidUser(randomUUID(), { email: 'x@example.test' })).toBe(true);
    }
  });
});

describe('fix round 1', () => {
  it('gives the daily project count back when the insert fails', async () => {
    free();
    const userId = randomUUID();
    const { storyDb } = await import('../../lib/story/db.js');
    const db = storyDb();
    const insert = db.insert;
    let failNext = true;
    const spy = vi.spyOn(db, 'insert').mockImplementation(async (table, rows) => {
      if (table === 'story_projects' && failNext) {
        failNext = false;
        throw new Error('insert failed');
      }
      return insert.call(db, table, rows);
    });
    try {
      await expect(createProject({ userId, input })).rejects.toThrow('insert failed');
      for (let i = 0; i < 3; i += 1) await createProject({ userId, input });
      await expect(createProject({ userId, input })).rejects.toMatchObject({ code: 'daily_limit' });
    } finally {
      spy.mockRestore();
    }
  });

  it('releaseAllowance never takes a count below zero', async () => {
    const { releaseAllowance } = await import('../../lib/story/limits.js');
    const userId = randomUUID();
    await releaseAllowance(undefined);
    await releaseAllowance({ userId, counters: [] });
    await releaseAllowance({ userId, counters: [{ key: 'project_create', day: '2026-01-01' }] });
    const { rows } = await raw.query('select count from story_usage where user_id = $1', [userId]);
    expect(rows.every((r) => r.count >= 0)).toBe(true);
  });

  it('caps script_write per project, not per account, and needs a projectId', async () => {
    free();
    const userId = randomUUID();
    const a = randomUUID();
    for (let i = 0; i < 3; i += 1) await assertAllowed({ userId, action: 'script_write', projectId: a });
    await expect(assertAllowed({ userId, action: 'script_write', projectId: a })).rejects.toMatchObject({ code: 'daily_limit' });
    await assertAllowed({ userId, action: 'script_write', projectId: randomUUID() });
    await expect(assertAllowed({ userId, action: 'script_write' })).rejects.toThrow(/projectId/);
    accounts.set({ paid: true });
    await assertAllowed({ userId, action: 'script_write', projectId: a });
  });
});

describe('fix round 2: receipts', () => {
  const usage = async (userId) => (await raw.query('select action, day::text as day, count from story_usage where user_id = $1 order by action', [userId])).rows;

  it('assertAllowed returns the counters it took and releaseAllowance gives exactly those back', async () => {
    free();
    const userId = randomUUID();
    const projectId = randomUUID();
    const receipt = await assertAllowed({ userId, action: 'script_write', projectId });
    expect(receipt.counters).toEqual([{ key: `script_write:${projectId}`, day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect((await usage(userId))[0].count).toBe(1);
    await releaseAllowance(receipt);
    expect((await usage(userId))[0].count).toBe(0);
    await releaseAllowance(receipt); // a second give-back never goes below zero
    expect((await usage(userId))[0].count).toBe(0);
  });

  it('gives a chat or revise count back on the fixed project day', async () => {
    free();
    const userId = randomUUID();
    const projectId = randomUUID();
    const receipt = await assertAllowed({ userId, action: 'script_revise', projectId });
    expect(receipt.counters).toEqual([{ key: `chat_message:${projectId}`, day: '1970-01-01' }]);
    await releaseAllowance(receipt);
    expect(await usage(userId)).toEqual([{ action: `chat_message:${projectId}`, day: '1970-01-01', count: 0 }]);
  });

  it('a paid account takes no daily count, so a give-back changes nothing', async () => {
    const userId = randomUUID();
    await raw.query(`insert into story_usage (user_id, day, action, count) values ($1, current_date, 'project_create', 2)`, [userId]);
    const receipt = await assertAllowed({ userId, action: 'project_create' });
    expect(receipt.counters).toEqual([]);
    await releaseAllowance(receipt);
    expect((await usage(userId))[0].count).toBe(2);
  });
});

describe('task 17 round 4: the daily limit body names the limit', () => {
  it('sends limit and action with a daily_limit, account-wide and per video', async () => {
    free();
    const userId = randomUUID();
    for (let i = 0; i < 3; i += 1) await createProject({ userId, input });
    const res = makeRes();
    sendError(res, await createProject({ userId, input }).catch((e) => e));
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error: 'daily_limit', action: 'project_create', limit: 3 });

    const projectId = randomUUID();
    for (let i = 0; i < 3; i += 1) await assertAllowed({ userId, action: 'script_write', projectId });
    const res2 = makeRes();
    sendError(res2, await assertAllowed({ userId, action: 'script_write', projectId }).catch((e) => e));
    expect(res2.body).toMatchObject({ error: 'daily_limit', action: 'script_write', limit: 3 });
  });
});
