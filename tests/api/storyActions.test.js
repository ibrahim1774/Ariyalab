// uses tests/helpers/storyEnv.js useRegexOnlyModeration()
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';

let currentUser = null;
vi.mock('../../lib/supabaseServer.js', () => ({
  getUserFromRequest: async () => (currentUser ? { user: currentUser, supabase: {} } : null),
  getSupabaseAdmin: () => {
    throw new Error('service-role client must not be used in tests');
  },
}));

const { setStoryDb, storyDb } = await import('../../lib/story/db.js');
const { setCreditsDb } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache } = await import('../../lib/pricing.js');
const { createProject } = await import('../../lib/story/projects.js');
const { registerAction, getActionMethods } = await import('../../lib/story/actions.js');
const { assertAllowed } = await import('../../lib/story/limits.js');
const route = await import('../../pages/api/story/projects/[id]/[action].js');
const scriptRoute = await import('../../pages/api/story/projects/[id]/script.js');
const reviseRoute = await import('../../pages/api/story/projects/[id]/revise.js');
// Next serves the static files before [action]: script and revise have their own.
const ROUTES = { script: scriptRoute.default, revise: reviseRoute.default };

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
const verified = '2026-01-01T00:00:00.000Z';
const ALICE = { id: randomUUID(), email: 'alice@example.test', email_confirmed_at: verified };
const BOB = { id: randomUUID(), email: 'bob@example.test', email_confirmed_at: verified };

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
  _resetPricingCache();
  await raw?.close();
});

beforeEach(() => {
  currentUser = ALICE;
});

const call = async ({ id, action, method = 'POST', body = {} }) => {
  const res = makeRes();
  const handler = ROUTES[action] || route.default;
  await handler(makeReq({ method, body, query: ROUTES[action] ? { id } : { id, action } }), res);
  return res;
};

const newProject = (userId = ALICE.id, input = {}) =>
  createProject({ userId, input: { purpose: 'app', offer: 'A booking app for barbers.', seconds: 30, ...input } });

const scripts = (projectId) => storyDb().select('story_scripts', { project_id: projectId });

describe('/api/story/projects/[id]/[action]', () => {
  it('caps the request body, and only the model routes get a long duration', () => {
    expect(route.config.api.bodyParser.sizeLimit).toBe('64kb');
    // Task 16 round 1: 25 s, below the clip claim's 30 s stall threshold (lib/story/shots.js STALE_CLAIM_MS).
    expect(route.config.maxDuration).toBe(25);
    for (const r of [scriptRoute, reviseRoute]) {
      expect(r.config.api.bodyParser.sizeLimit).toBe('64kb');
      expect(r.config.maxDuration).toBe(120);
    }
  });

  it('authenticates before resolving the action (401, not 404 or 405)', async () => {
    currentUser = null;
    expect((await call({ id: randomUUID(), action: 'teleport' })).statusCode).toBe(401);
    expect((await call({ id: randomUUID(), action: 'revise', method: 'DELETE' })).statusCode).toBe(401);
  });

  it("checks project ownership before any handler runs", async () => {
    const spy = vi.fn(async () => ({ ok: true }));
    registerAction('test-no-check', { method: 'POST', handler: spy });
    const bobs = await newProject(BOB.id);
    const res = await call({ id: bobs.id, action: 'test-no-check' });
    expect(res.statusCode).toBe(404);
    expect((await call({ id: 'not-a-uuid', action: 'test-no-check' })).statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    const mine = await newProject();
    expect((await call({ id: mine.id, action: 'test-no-check' })).statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ projectId: mine.id, project: expect.objectContaining({ id: mine.id }) }));
  });

  it('returns 401 without a session for every registered action', async () => {
    currentUser = null;
    for (const [action, method] of [['script', 'POST'], ['revise', 'POST'], ['scene', 'PATCH'], ['duplicate', 'POST']]) {
      const res = await call({ id: randomUUID(), action, method });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    }
  });

  it('returns 404 for an unknown action and 405 for a wrong method', async () => {
    const p = await newProject();
    expect((await call({ id: p.id, action: 'teleport' })).statusCode).toBe(404);
    const res = await call({ id: p.id, action: 'revise', method: 'DELETE' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(getActionMethods('script').sort()).toEqual(['GET', 'POST']);
  });

  it('POST script writes the script, GET script reads it back', async () => {
    const p = await newProject();
    const res = await call({ id: p.id, action: 'script' });
    expect(res.statusCode).toBe(200);
    expect(res.body.script).toMatchObject({ version: 1, violations: [] });
    const get = await call({ id: p.id, action: 'script', method: 'GET' });
    expect(get.statusCode).toBe(200);
    expect(get.body.script.version).toBe(1);
  });

  it("returns 404 for another user's project on every action", async () => {
    const p = await newProject(BOB.id);
    for (const [action, method, body] of [
      ['script', 'POST', {}],
      ['script', 'GET', {}],
      ['revise', 'POST', { instruction: 'Funnier' }],
      ['scene', 'PATCH', { sceneId: 's1', patch: { title: 'x' } }],
      ['duplicate', 'POST', {}],
    ]) {
      const res = await call({ id: p.id, action, method, body });
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
  });

  it('POST revise returns the new script and the changed scene ids', async () => {
    const p = await newProject();
    const first = (await call({ id: p.id, action: 'script' })).body.script;
    const target = first.scenes[1].id;
    const res = await call({ id: p.id, action: 'revise', body: { instruction: `Punchier [[mock:edit:${target}]]` } });
    expect(res.statusCode).toBe(200);
    expect(res.body.script.version).toBe(2);
    expect(res.body.changedSceneIds).toEqual([target]);
  });

  it('PATCH scene edits one scene', async () => {
    const p = await newProject();
    const first = (await call({ id: p.id, action: 'script' })).body.script;
    const sceneId = first.scenes[0].id;
    const res = await call({ id: p.id, action: 'scene', method: 'PATCH', body: { sceneId, patch: { title: 'Cold open' } } });
    expect(res.statusCode).toBe(200);
    expect(res.body.script.scenes[0].title).toBe('Cold open');
    expect(res.body.changedSceneIds).toEqual([sceneId]);
  });

  it('POST duplicate copies the project (201)', async () => {
    const p = await newProject();
    await call({ id: p.id, action: 'script' });
    const res = await call({ id: p.id, action: 'duplicate' });
    expect(res.statusCode).toBe(201);
    expect(res.body.project).toMatchObject({ title: `${p.title} copy`, user_id: ALICE.id });
    expect(await scripts(res.body.project.id)).toHaveLength(1);
  });

  it('returns the moderation response (400) and stores nothing', async () => {
    const p = await newProject();
    await call({ id: p.id, action: 'script' });
    const revise = await call({ id: p.id, action: 'revise', body: { instruction: 'make everyone nude' } });
    expect(revise.statusCode).toBe(400);
    expect(revise.body.code).toBe('BLOCKED_NSFW');
    const sceneId = (await scripts(p.id))[0].scenes[0].id;
    const scene = await call({ id: p.id, action: 'scene', method: 'PATCH', body: { sceneId, patch: { title: 'nude' } } });
    expect(scene.statusCode).toBe(400);
    expect(await scripts(p.id)).toHaveLength(1);
  });

  it('returns 422 for invalid input', async () => {
    const p = await newProject();
    await call({ id: p.id, action: 'script' });
    const revise = await call({ id: p.id, action: 'revise', body: {} });
    expect(revise.statusCode).toBe(422);
    expect(revise.body).toMatchObject({ error: 'validation_failed', field: 'instruction' });
    const scene = await call({ id: p.id, action: 'scene', method: 'PATCH', body: { sceneId: 's1', patch: 'nope' } });
    expect(scene.statusCode).toBe(422);
  });

  it('returns 402 plan_required when a free account reaches a paid step', async () => {
    registerAction('test-paid-step', {
      method: 'POST',
      handler: async ({ userId, user, projectId }) => {
        await assertAllowed({ userId, user, projectId, action: 'cast_generate' });
        return { ok: true };
      },
    });
    const p = await newProject();
    accounts.set({ paid: false });
    const res = await call({ id: p.id, action: 'test-paid-step' });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toBe('plan_required');
    accounts.set({ paid: true });
    expect((await call({ id: p.id, action: 'test-paid-step' })).statusCode).toBe(200);
  });

  it('returns 429 when a free account duplicates past the daily project cap', async () => {
    const user = { id: randomUUID(), email: 'c@example.test', email_confirmed_at: verified };
    currentUser = user;
    accounts.set({ paid: false });
    const p = await newProject(user.id);
    await call({ id: p.id, action: 'duplicate' });
    await call({ id: p.id, action: 'duplicate' });
    const res = await call({ id: p.id, action: 'duplicate' });
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('daily_limit');
  });

  it('returns 403 when a free account has not verified its email', async () => {
    const p = await newProject();
    currentUser = { ...ALICE, email_confirmed_at: null };
    accounts.set({ paid: false });
    const res = await call({ id: p.id, action: 'script' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('email_unverified');
    expect(await scripts(p.id)).toHaveLength(0);
  });
});
