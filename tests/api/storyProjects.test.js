import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration } from '../helpers/storyEnv.js';

let currentUser = null;
vi.mock('../../lib/supabaseServer.js', () => ({
  getUserFromRequest: async () => (currentUser ? { user: currentUser, supabase: {} } : null),
  getSupabaseAdmin: () => {
    throw new Error('service-role client must not be used in tests');
  },
}));

// Only the classifier-unavailable test reaches the SDK (the others run without a key).
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = {
        create: async () => {
          throw new Error('network down');
        },
      };
    }
  },
}));

const { setStoryDb } = await import('../../lib/story/db.js');
const listHandler = (await import('../../pages/api/story/projects/index.js')).default;
const itemHandler = (await import('../../pages/api/story/projects/[id]/index.js')).default;

useRegexOnlyModeration();

let raw;
const ALICE = { id: randomUUID(), email: 'alice@example.test' };
const BOB = { id: randomUUID(), email: 'bob@example.test' };

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
}, 60_000);

afterAll(async () => {
  setStoryDb(null);
  await raw?.close();
});

beforeEach(() => {
  currentUser = ALICE;
});

const call = async (handler, opts) => {
  const res = makeRes();
  await handler(makeReq(opts), res);
  return res;
};

const create = (body = { purpose: 'service', seconds: 30 }) => call(listHandler, { method: 'POST', body });

describe('/api/story/projects', () => {
  it('returns 401 JSON without a session', async () => {
    currentUser = null;
    for (const [h, method] of [[listHandler, 'GET'], [listHandler, 'POST'], [itemHandler, 'GET'], [itemHandler, 'PATCH'], [itemHandler, 'DELETE']]) {
      const res = await call(h, { method, query: { id: randomUUID() } });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBeTruthy();
    }
  });

  it('POST creates (201) and GET lists only my projects', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.body.project).toMatchObject({ purpose: 'service', step: 'brief' });
    currentUser = BOB;
    await create();
    currentUser = ALICE;
    const list = await call(listHandler, { method: 'GET' });
    expect(list.statusCode).toBe(200);
    expect(list.body.projects.every((p) => p.user_id === ALICE.id)).toBe(true);
    expect(list.body.projects.map((p) => p.id)).toContain(res.body.project.id);
  });

  it('POST returns 422 for invalid input', async () => {
    const res = await create({ seconds: 5 });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ error: 'validation_failed', field: 'seconds' });
  });

  it('POST returns the moderation response for blocked text', async () => {
    const res = await create({ title: 'nude' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('BLOCKED_NSFW');
  });

  it('returns 503 when the classifier is unavailable', async () => {
    vi.stubEnv('STORY_MOCK', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await create({ title: 'Fresh fades for busy dads' });
      expect(res.statusCode).toBe(503);
      expect(res.body.code).toBe('MODERATION_UNAVAILABLE');
    } finally {
      warn.mockRestore();
      vi.stubEnv('STORY_MOCK', '1');
      vi.stubEnv('ANTHROPIC_API_KEY', '');
    }
  });

  it('rejects other methods with 405', async () => {
    expect((await call(listHandler, { method: 'PUT' })).statusCode).toBe(405);
    expect((await call(itemHandler, { method: 'POST', query: { id: randomUUID() } })).statusCode).toBe(405);
  });
});

describe('/api/story/projects/[id]', () => {
  it('GET, PATCH and DELETE my project', async () => {
    const { id } = (await create()).body.project;
    const got = await call(itemHandler, { method: 'GET', query: { id } });
    expect(got.statusCode).toBe(200);
    expect(got.body.project.id).toBe(id);

    const patched = await call(itemHandler, { method: 'PATCH', query: { id }, body: { title: 'Fresh fade' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.project.title).toBe('Fresh fade');

    const bad = await call(itemHandler, { method: 'PATCH', query: { id }, body: { step: 'done' } });
    expect(bad.statusCode).toBe(422);

    const del = await call(itemHandler, { method: 'DELETE', query: { id } });
    expect(del.statusCode).toBe(200);
    expect((await call(itemHandler, { method: 'GET', query: { id } })).statusCode).toBe(404);
  });

  it("another user's project is 404 for every method", async () => {
    const { id } = (await create()).body.project;
    currentUser = BOB;
    for (const [method, body] of [['GET'], ['PATCH', { title: 'x' }], ['DELETE']]) {
      const res = await call(itemHandler, { method, query: { id }, body });
      expect(res.statusCode, method).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
  });

  it('DELETE with a running job is 409', async () => {
    const { id } = (await create()).body.project;
    await raw.query(`insert into story_jobs (project_id, user_id, kind, status) values ($1, $2, 'clip', 'queued')`, [id, ALICE.id]);
    const res = await call(itemHandler, { method: 'DELETE', query: { id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('conflict');
  });
});
