import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createPgAdapter, createSupabaseAdapter, setStoryDb, storyDb } from '../../lib/story/db.js';

let raw;
let db;

beforeAll(async () => {
  raw = await createTestDb();
  db = createPgAdapter(raw);
}, 60_000);

afterAll(async () => {
  await raw?.close();
});

describe('storyDb over PGlite', () => {
  it('setStoryDb wraps a { query } handle', async () => {
    setStoryDb(raw);
    const [p] = await storyDb().insert('story_projects', { user_id: randomUUID(), title: 'Wrapped' });
    expect(p.title).toBe('Wrapped');
    setStoryDb(null);
  });

  it('round-trips jsonb arrays, objects, text[] and timestamps', async () => {
    const userId = randomUUID();
    const [p] = await db.insert('story_projects', { user_id: userId, audio_plan: { voice: 'v1', captions: { on: true } } });
    expect(p.audio_plan).toEqual({ voice: 'v1', captions: { on: true } });
    expect(typeof p.created_at).toBe('string');
    expect(new Date(p.created_at).toISOString()).toBe(p.created_at);

    const scenes = [{ id: 's1', title: 'Open', visual: 'A shop', lines: [{ speaker: 'narrator', text: 'Hi' }] }];
    const [s] = await db.insert('story_scripts', { project_id: p.id, version: 1, scenes });
    expect(s.scenes).toEqual(scenes);

    const [b] = await db.insert('story_brand', { user_id: userId, avoid: ['free', 'guaranteed'], colors: ['#111', '#eee'] });
    expect(b.avoid).toEqual(['free', 'guaranteed']);
    expect(b.colors).toEqual(['#111', '#eee']);

    const [c] = await db.insert('story_cast', { project_id: p.id, name: 'Sam', candidates: [] });
    expect(c.candidates).toEqual([]);
  });

  it('select supports equality, null, in, order, limit and columns', async () => {
    const userId = randomUUID();
    const [p] = await db.insert('story_projects', { user_id: userId });
    await db.insert('story_shots', [
      { project_id: p.id, ord: 2, description: 'c', still_url: 'u' },
      { project_id: p.id, ord: 0, description: 'a' },
      { project_id: p.id, ord: 1, description: 'b' },
    ]);
    const all = await db.select('story_shots', { project_id: p.id }, { order: 'ord' });
    expect(all.map((r) => r.description)).toEqual(['a', 'b', 'c']);
    const desc = await db.select('story_shots', { project_id: p.id }, { order: ['-ord'], limit: 2, columns: ['ord'] });
    expect(desc).toEqual([{ ord: 2 }, { ord: 1 }]);
    const noStill = await db.select('story_shots', { project_id: p.id, still_url: null }, { order: 'ord' });
    expect(noStill.map((r) => r.ord)).toEqual([0, 1]);
    const some = await db.select('story_shots', { project_id: p.id, ord: [0, 2] }, { order: 'ord' });
    expect(some.map((r) => r.ord)).toEqual([0, 2]);
    expect(await db.select('story_shots', { project_id: p.id, ord: [] })).toEqual([]);
  });

  it('update and remove return the affected rows and require a match', async () => {
    const [p] = await db.insert('story_projects', { user_id: randomUUID(), title: 'Before' });
    const updated = await db.update('story_projects', { id: p.id }, { title: 'After', audio_plan: { music: 'none' } });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ title: 'After', audio_plan: { music: 'none' } });
    await expect(db.update('story_projects', {}, { title: 'x' })).rejects.toThrow(/match/);
    await expect(db.remove('story_projects', {})).rejects.toThrow(/match/);
    const removed = await db.remove('story_projects', { id: p.id });
    expect(removed.map((r) => r.id)).toEqual([p.id]);
    expect(await db.select('story_projects', { id: p.id })).toEqual([]);
  });

  it('rpc returns rows for set functions and a value for scalar functions', async () => {
    const userId = randomUUID();
    const [p] = await db.insert('story_projects', { user_id: userId });
    await db.insert('story_jobs', { project_id: p.id, user_id: userId, kind: 'still' });
    const jobs = await db.rpc('story_claim_jobs', { p_project: p.id, p_limit: 5 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('running');
    expect(typeof jobs[0].locked_until).toBe('string');
    expect(await db.rpc('story_usage_take', { p_user: userId, p_action: 'analysis', p_limit: 1 })).toBe(true);
    expect(await db.rpc('story_usage_take', { p_user: userId, p_action: 'analysis', p_limit: 1 })).toBe(false);
  });

  it('rejects tables, columns and functions outside the allow-list', async () => {
    await expect(db.select('profiles', {})).rejects.toThrow(/table/);
    await expect(db.select('credit_ledger', {})).rejects.toThrow(/table/);
    await expect(db.insert('story_projects', { 'title; drop table x': 'a' })).rejects.toThrow(/column/);
    await expect(db.select('story_projects', { 'id or 1=1': 1 })).rejects.toThrow(/column/);
    await expect(db.select('story_projects', {}, { order: 'id desc' })).rejects.toThrow(/column/);
    await expect(db.rpc('credit_grant', {})).rejects.toThrow(/function/);
  });
});

// A fake supabase-js client that records the builder calls it receives.
function fakeSupabase(result) {
  const calls = [];
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(result);
        return (...args) => {
          calls.push([prop, ...args]);
          return builder;
        };
      },
    }
  );
  return {
    calls,
    from: (table) => {
      calls.push(['from', table]);
      return builder;
    },
    rpc: async (fn, params) => {
      calls.push(['rpc', fn, params]);
      return result;
    },
  };
}

describe('storyDb over supabase-js', () => {
  it('maps select matches, order and limit onto the builder', async () => {
    const client = fakeSupabase({ data: [{ id: 1 }], error: null });
    const rows = await createSupabaseAdapter(client).select(
      'story_shots',
      { project_id: 'p', still_url: null, ord: [1, 2] },
      { columns: ['id', 'ord'], order: ['ord', '-created_at'], limit: 3 }
    );
    expect(rows).toEqual([{ id: 1 }]);
    expect(client.calls).toEqual([
      ['from', 'story_shots'],
      ['select', 'id,ord'],
      ['eq', 'project_id', 'p'],
      ['is', 'still_url', null],
      ['in', 'ord', [1, 2]],
      ['order', 'ord', { ascending: true }],
      ['order', 'created_at', { ascending: false }],
      ['limit', 3],
    ]);
  });

  it('insert, update and remove ask for the rows back', async () => {
    const client = fakeSupabase({ data: [{ id: 1 }], error: null });
    const a = createSupabaseAdapter(client);
    await a.insert('story_projects', { user_id: 'u' });
    await a.update('story_projects', { id: 'x' }, { title: 't' });
    await a.remove('story_projects', { id: 'x' });
    expect(client.calls).toEqual([
      ['from', 'story_projects'], ['insert', [{ user_id: 'u' }]], ['select'],
      ['from', 'story_projects'], ['update', { title: 't' }], ['eq', 'id', 'x'], ['select'],
      ['from', 'story_projects'], ['delete'], ['eq', 'id', 'x'], ['select'],
    ]);
  });

  it('an empty IN list matches nothing without a request', async () => {
    const client = fakeSupabase({ data: [{ id: 1 }], error: null });
    const a = createSupabaseAdapter(client);
    expect(await a.select('story_shots', { id: [] })).toEqual([]);
    expect(await a.update('story_shots', { id: [] }, { stale: true })).toEqual([]);
    expect(await a.remove('story_shots', { id: [] })).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it('throws the PostgREST error and passes rpc through', async () => {
    const failing = createSupabaseAdapter(fakeSupabase({ data: null, error: { message: 'boom' } }));
    await expect(failing.select('story_projects', {})).rejects.toThrow('boom');
    const client = fakeSupabase({ data: true, error: null });
    expect(await createSupabaseAdapter(client).rpc('story_usage_take', { p_user: 'u', p_action: 'a', p_limit: 1 })).toBe(true);
    expect(client.calls).toEqual([['rpc', 'story_usage_take', { p_user: 'u', p_action: 'a', p_limit: 1 }]]);
  });
});
