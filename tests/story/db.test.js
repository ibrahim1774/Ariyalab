import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import {
  createPgAdapter,
  createSupabaseAdapter,
  DATE_COLUMNS,
  setStoryDb,
  STORY_TABLES,
  storyDb,
  TIMESTAMP_COLUMNS,
} from '../../lib/story/db.js';

let raw;
const adapters = {};

beforeAll(async () => {
  raw = await createTestDb();
  adapters.pglite = createPgAdapter(raw);
  adapters.supabase = createSupabaseAdapter(createFakeSupabase(raw));
}, 60_000);

afterAll(async () => {
  await raw?.close();
});

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('the fake supabase client is PostgREST-like', () => {
  it('defaults missing keys to NULL unless defaultToNull is false', async () => {
    const fake = createFakeSupabase(raw);
    const [p] = (await fake.from('story_projects').insert([{ user_id: randomUUID() }]).select()).data;
    const mixed = [{ project_id: p.id, ord: 0, description: 'a' }, { project_id: p.id, ord: 1, status: 'still_ready' }];
    const nulls = await fake.from('story_shots').insert(mixed).select();
    expect(nulls.error?.message).toMatch(/null value/);
    const defaults = await fake.from('story_shots').insert(mixed, { defaultToNull: false }).select();
    expect(defaults.error).toBeNull();
    expect(defaults.data[0].created_at).toMatch(/\+00:00$/);
  });
});

describe.each(['pglite', 'supabase'])('storyDb over %s', (name) => {
  const db = () => adapters[name];
  const newProject = async (extra = {}) => (await db().insert('story_projects', { user_id: randomUUID(), ...extra }))[0];

  it('bulk insert with different keys applies column defaults and returns rows in order', async () => {
    const p = await newProject();
    const rows = await db().insert('story_shots', [
      { project_id: p.id, ord: 0, description: 'a' },
      { project_id: p.id, ord: 1, status: 'still_ready', cast_ids: [p.id] },
    ]);
    expect(rows.map((r) => [r.ord, r.description, r.status, r.stale, r.cast_ids])).toEqual([
      [0, 'a', 'draft', false, []],
      [1, null, 'still_ready', false, [p.id]],
    ]);
  });

  it('bulk insert is all or nothing', async () => {
    const p = await newProject();
    await expect(
      db().insert('story_shots', [{ project_id: p.id, ord: 0 }, { project_id: p.id, ord: 1, status: 'bogus' }])
    ).rejects.toThrow(/check/);
    expect(await db().select('story_shots', { project_id: p.id })).toEqual([]);
  });

  it('rejects undefined in rows, patches and matches', async () => {
    const p = await newProject();
    await expect(db().insert('story_projects', { user_id: randomUUID(), title: undefined })).rejects.toThrow(TypeError);
    await expect(db().update('story_projects', { id: p.id }, { title: undefined })).rejects.toThrow(TypeError);
    await expect(db().select('story_projects', { id: undefined })).rejects.toThrow(TypeError);
    await expect(db().update('story_projects', { id: undefined }, { title: 'x' })).rejects.toThrow(TypeError);
    await expect(db().remove('story_brand', { user_id: undefined })).rejects.toThrow(TypeError);
    await expect(db().select('story_projects', { id: [p.id, undefined] })).rejects.toThrow(TypeError);
    expect((await db().select('story_projects', { id: p.id }))[0].title).toBe('Untitled video');
  });

  it('matches equality, null and IN; an empty IN matches nothing', async () => {
    const p = await newProject();
    await db().insert('story_shots', [
      { project_id: p.id, ord: 2, description: 'c', still_url: 'u' },
      { project_id: p.id, ord: 0, description: 'a' },
      { project_id: p.id, ord: 1, description: 'b' },
    ]);
    const noStill = await db().select('story_shots', { project_id: p.id, still_url: null }, { order: 'ord' });
    expect(noStill.map((r) => r.ord)).toEqual([0, 1]);
    const some = await db().select('story_shots', { project_id: p.id, ord: [0, 2] }, { order: 'ord' });
    expect(some.map((r) => r.ord)).toEqual([0, 2]);
    expect(await db().select('story_shots', { project_id: p.id, ord: [] })).toEqual([]);
    expect(await db().update('story_shots', { ord: [] }, { stale: true })).toEqual([]);
    expect(await db().remove('story_shots', { ord: [] })).toEqual([]);
    expect(await db().select('story_shots', { project_id: p.id })).toHaveLength(3);
  });

  it('orders, limits and selects columns', async () => {
    const p = await newProject();
    await db().insert('story_shots', [0, 1, 2].map((ord) => ({ project_id: p.id, ord })));
    expect(await db().select('story_shots', { project_id: p.id }, { order: ['-ord'], limit: 2, columns: ['ord'] })).toEqual([
      { ord: 2 },
      { ord: 1 },
    ]);
  });

  it('defaults to 1000 rows and pages above that with an order', async () => {
    const p = await newProject();
    await db().insert(
      'story_chat',
      Array.from({ length: 1001 }, (_, i) => ({ project_id: p.id, role: 'user', content: `m${i}` }))
    );
    expect(await db().select('story_chat', { project_id: p.id }, { columns: ['id'] })).toHaveLength(1000);
    const all = await db().select('story_chat', { project_id: p.id }, { columns: ['id', 'content'], order: 'id', limit: 5000 });
    expect(all).toHaveLength(1001);
    expect(new Set(all.map((r) => r.id)).size).toBe(1001);
    await expect(db().select('story_chat', { project_id: p.id }, { limit: 1001 })).rejects.toThrow(/order/);
  });

  it('update and remove return affected rows and need a match', async () => {
    const p = await newProject({ title: 'Before' });
    const [u] = await db().update('story_projects', { id: p.id }, { title: 'After', audio_plan: { music: 'none' } });
    expect(u).toMatchObject({ title: 'After', audio_plan: { music: 'none' } });
    await expect(db().update('story_projects', {}, { title: 'x' })).rejects.toThrow(/match/);
    await expect(db().remove('story_projects', {})).rejects.toThrow(/match/);
    expect((await db().remove('story_projects', { id: p.id })).map((r) => r.id)).toEqual([p.id]);
    expect(await db().select('story_projects', { id: p.id })).toEqual([]);
  });

  it('round-trips jsonb, arrays, and normalises timestamps and dates', async () => {
    const userId = randomUUID();
    const p = await newProject({ audio_plan: { voice: 'v1', captions: { on: true } } });
    expect(p.audio_plan).toEqual({ voice: 'v1', captions: { on: true } });
    expect(p.created_at).toMatch(ISO_MS);
    const scenes = [{ id: 's1', title: 'Open', visual: 'A shop', lines: [{ speaker: 'narrator', text: 'Hi' }] }];
    const [s] = await db().insert('story_scripts', { project_id: p.id, version: 1, scenes });
    expect(s.scenes).toEqual(scenes);
    const [b] = await db().insert('story_brand', { user_id: userId, avoid: ['free'], colors: ['#111'] });
    expect([b.avoid, b.colors]).toEqual([['free'], ['#111']]);
    const [c] = await db().insert('story_chat', { project_id: p.id, role: 'assistant', content: 'plain text' });
    expect(c.content).toBe('plain text');
    expect(await db().rpc('story_usage_take', { p_user: userId, p_action: 'analysis', p_limit: 1 })).toBe(true);
    const [usage] = await db().select('story_usage', { user_id: userId });
    expect(usage.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rpc returns rows for set functions, values for scalars, and SQL errors by message', async () => {
    const p = await newProject();
    await db().insert('story_jobs', { project_id: p.id, user_id: p.user_id, kind: 'still' });
    const jobs = await db().rpc('story_claim_jobs', { p_project: p.id, p_limit: 5 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].locked_until).toMatch(ISO_MS);
    await expect(db().rpc('story_delete_project', { p_user: p.user_id, p_project: p.id })).rejects.toThrow('project_busy');
    expect(await db().rpc('story_delete_project', { p_user: randomUUID(), p_project: p.id })).toBe(false);
  });

  it('rejects tables, columns and functions outside the allow-list', async () => {
    await expect(db().select('profiles', {})).rejects.toThrow(/table/);
    await expect(db().select('credit_ledger', {})).rejects.toThrow(/table/);
    await expect(db().insert('story_projects', { 'title; drop table x': 'a' })).rejects.toThrow(/column/);
    await expect(db().select('story_projects', { 'id or 1=1': 1 })).rejects.toThrow(/column/);
    await expect(db().select('story_projects', {}, { order: 'id desc' })).rejects.toThrow(/column/);
    await expect(db().rpc('credit_grant', {})).rejects.toThrow(/function/);
  });
});

describe('storyDb wiring', () => {
  it('setStoryDb wraps a { query } handle', async () => {
    setStoryDb(raw);
    const [p] = await storyDb().insert('story_projects', { user_id: randomUUID(), title: 'Wrapped' });
    expect(p.title).toBe('Wrapped');
    setStoryDb(null);
  });

  it('the allow-list and normalised column lists match the schema', async () => {
    const { rows: tables } = await raw.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'story\\_%'`
    );
    expect([...STORY_TABLES].sort()).toEqual(tables.map((t) => t.table_name).sort());
    const { rows } = await raw.query(
      `select distinct column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name like 'story\\_%'
          and data_type in ('timestamp with time zone', 'date')`
    );
    const ts = rows.filter((r) => r.data_type !== 'date').map((r) => r.column_name);
    const dates = rows.filter((r) => r.data_type === 'date').map((r) => r.column_name);
    expect([...TIMESTAMP_COLUMNS].sort()).toEqual([...new Set(ts)].sort());
    expect([...DATE_COLUMNS].sort()).toEqual([...new Set(dates)].sort());
  });
});
