import { randomUUID } from 'node:crypto';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { setStoryDb } from '../../lib/story/db.js';
import { runRetention, ORPHAN_AGE_MS } from '../../lib/story/retention.js';
import { listObjects, mockStoragePath } from '../../lib/providers/storage.js';
import cleanupCron from '../../pages/api/cron/story-cleanup.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  setStoryDb(db);
  process.env.CRON_SECRET = 'cron_test_secret';
}, 60_000);
afterAll(async () => {
  setStoryDb(null);
  await db?.close();
});

// In-memory object store: key -> uploadedAt.
const store = new Map();
const deleted = [];
const list = async ({ prefix, cursor }) => {
  const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
  const from = cursor ? Number(cursor) : 0;
  return { objects: all.slice(from, from + 2).map((key) => ({ key, uploadedAt: store.get(key) })), cursor: from + 2 < all.length ? String(from + 2) : null };
};
const del = async ({ keys }) => {
  for (const k of keys) {
    deleted.push(k);
    store.delete(k);
  }
  return keys.length;
};
const put = (key, ageMs = 0) => store.set(key, new Date(Date.now() - ageMs).toISOString());
const run = (opts = {}) => runRetention({ list, del, ...opts });
beforeEach(() => {
  store.clear();
  deleted.length = 0;
});

async function project(userId, { expired = true, status = 'finished' } = {}) {
  const { rows } = await db.query(
    `insert into public.story_projects (user_id, status, files_expire_at)
     values ($1, $2, now() + case when $3 then interval '-1 day' else interval '10 days' end) returning id`,
    [userId, status, expired]
  );
  return rows[0].id;
}
const expiresAt = async (id) => (await db.query('select files_expire_at from public.story_projects where id = $1', [id])).rows[0].files_expire_at;
const status = async (id) => (await db.query('select status from public.story_projects where id = $1', [id])).rows[0].status;

describe('retention cleanup', () => {
  it('deletes every file an expired project names or holds under its prefixes, then marks it expired', async () => {
    const user = randomUUID();
    const p = await project(user);
    const k = (name) => `story/${p}/${name}`;
    await db.query('update public.story_projects set narration_key = $2, music_key = $3, thumbnail_key = $4 where id = $1', [p, k('n.mp3'), k('m.mp3'), k('t.jpg')]);
    await db.query('insert into public.story_shots (project_id, ord, still_key, clip_key) values ($1, 0, $2, $3)', [p, k('s.png'), k('c.mp4')]);
    await db.query(
      `insert into public.story_cast (project_id, name, image_key, candidates, sheet) values ($1, 'Mia', $2, $3::jsonb, $4::jsonb)`,
      [p, k('cast.png'), JSON.stringify([{ slot: 0, url: 'u', key: k('cand0.png') }]), JSON.stringify({ url: 'u', key: k('sheet.png'), from_key: k('cand0.png') })]
    );
    await db.query('insert into public.story_renders (project_id, version, storage_key) values ($1, 1, $2)', [p, k('render.mp4')]);
    await db.query(
      `insert into public.story_references (project_id, source_type, storage_key, frames) values ($1, 'upload', $2, $3::jsonb)`,
      [p, `story-uploads/${p}/ref.mp4`, JSON.stringify([{ ord: 0, url: 'u', key: k('beat-0.jpg') }])]
    );
    await db.query(`insert into public.story_jobs (project_id, user_id, kind, status, result) values ($1, $2, 'music', 'done', $3::jsonb)`, [p, user, JSON.stringify({ file: { key: k('job.mp3') } })]);
    // Objects no row names: an aborted upload and a stray file.
    put(`story-uploads/${p}/aborted.mp4`);
    put(k('stray.jpg'));

    const summary = await run();
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    expect(new Set(deleted)).toEqual(new Set([
      k('n.mp3'), k('m.mp3'), k('t.jpg'), k('s.png'), k('c.mp4'), k('cast.png'), k('cand0.png'), k('sheet.png'),
      k('render.mp4'), `story-uploads/${p}/ref.mp4`, k('beat-0.jpg'), k('job.mp3'), `story-uploads/${p}/aborted.mp4`, k('stray.jpg'),
    ]));
    expect(await status(p)).toBe('expired');

    // A second run changes nothing (already expired).
    deleted.length = 0;
    await run();
    expect(deleted).toEqual([]);
  });

  it('keeps a key an unexpired duplicate still names (refcount), and deletes it once that one expires too', async () => {
    const user = randomUUID();
    const src = await project(user);
    const copy = await project(user, { expired: false });
    const shared = `story/${src}/still.png`;
    for (const id of [src, copy]) await db.query('insert into public.story_shots (project_id, ord, still_key) values ($1, 0, $2)', [id, shared]);
    put(shared);
    await run();
    expect(deleted).not.toContain(shared);
    expect(await status(src)).toBe('expired');
    expect(await status(copy)).toBe('finished');

    await db.query("update public.story_projects set files_expire_at = now() - interval '1 hour' where id = $1", [copy]);
    await run();
    expect(deleted).toContain(shared);
    expect(await status(copy)).toBe('expired');
  });

  it('never deletes a story_assets key (own-picture cast rows reuse it as image_key; the brand kit does not expire)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const assetKey = `story-brand/${user}/me.png`;
    await db.query(`insert into public.story_assets (user_id, kind, url, storage_key, in_brand_kit) values ($1, 'image', $2, $3, false)`, [user, `https://blob.test/${assetKey}`, assetKey]);
    await db.query(`insert into public.story_cast (project_id, name, image_key) values ($1, 'Me', $2)`, [p, assetKey]);
    // An asset row with no storage_key still owns the object its url names.
    const urlOnly = `story-uploads/${p}/ref-asset.mp4`;
    await db.query(`insert into public.story_assets (user_id, kind, url) values ($1, 'reference_video', $2)`, [user, `https://blob.test/${urlOnly}`]);
    put(urlOnly);
    put(assetKey, 2 * ORPHAN_AGE_MS);
    await run();
    expect(deleted).not.toContain(assetKey);
    expect(deleted).not.toContain(urlOnly);
    expect(await status(p)).toBe('expired');
  });

  it('leaves unexpired projects and projects with a running job alone', async () => {
    const user = randomUUID();
    const live = await project(user, { expired: false });
    const busy = await project(user);
    await db.query(`insert into public.story_jobs (project_id, user_id, kind, status) values ($1, $2, 'render', 'running')`, [busy, user]);
    put(`story/${live}/a.png`);
    put(`story/${busy}/b.png`);
    await run();
    expect(deleted).toEqual([]);
    expect(await status(busy)).toBe('finished');
  });

  it('sweeps brand and audio uploads older than a day that no asset names', async () => {
    const user = randomUUID();
    const registered = `story-audio/${user}/voice.mp3`;
    await db.query(`insert into public.story_assets (user_id, kind, url, storage_key) values ($1, 'voice_sample', 'https://blob.test/x', $2)`, [user, registered]);
    put(registered, 2 * ORPHAN_AGE_MS);
    put(`story-audio/${user}/failed.mp3`, 2 * ORPHAN_AGE_MS);
    put(`story-brand/${user}/moderation-503.png`, 2 * ORPHAN_AGE_MS);
    put(`story-brand/${user}/uploading-now.png`, 60_000);
    const summary = await run();
    expect(new Set(deleted)).toEqual(new Set([`story-audio/${user}/failed.mp3`, `story-brand/${user}/moderation-503.png`]));
    expect(summary.orphans).toBe(2);
  });

  it('a delete that fails keeps the project due: the next run deletes what is left', async () => {
    const user = randomUUID();
    const p = await project(user);
    await db.query('update public.story_projects set narration_key = $2 where id = $1', [p, `story/${p}/n.mp3`]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const summary = await runRetention({ list, del: async () => { throw new Error('blob down'); } });
    err.mockRestore();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(await status(p)).toBe('expired');
    expect(await expiresAt(p)).not.toBeNull();
    await run();
    expect(deleted).toContain(`story/${p}/n.mp3`);
    expect(await expiresAt(p)).toBeNull();
  });

  it('O5: a file stored after the cleanup (a fresh window) survives the next run', async () => {
    const user = randomUUID();
    const p = await project(user);
    await db.query('update public.story_projects set narration_key = $2 where id = $1', [p, `story/${p}/n.mp3`]);
    await run();
    expect(await expiresAt(p)).toBeNull();
    // A render that was already under way lands later: the runner sets files_expire_at only when it is null.
    const late = `story/${p}/render/late.mp4`;
    await db.query("insert into public.story_renders (project_id, version, storage_key) values ($1, 1, $2)", [p, late]);
    await db.query("update public.story_projects set files_expire_at = now() + interval '30 days' where id = $1 and files_expire_at is null", [p]);
    put(late);
    deleted.length = 0;
    await run();
    expect(deleted).not.toContain(late);
  });

  it('F-M2 (Fable R1): a job started during the run keeps the project files (checked before each delete)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const still = `story/${p}/still/a.png`;
    await db.query(`insert into public.story_shots (project_id, ord, still_key, still_url, status) values ($1, 0, $2, 'u', 'still_ready')`, [p, still]);
    put(still);
    let started = false;
    const racing = async (args) => {
      if (!started && args.prefix.startsWith('story/')) {
        started = true;
        await db.query(`insert into public.story_jobs (project_id, user_id, kind, status, cost_credits, payload) values ($1, $2, 'clip', 'queued', 33, $3::jsonb)`, [p, user, JSON.stringify({ stillKey: still })]);
      }
      return list(args);
    };
    await runRetention({ list: racing, del });
    expect(deleted).toEqual([]);
    expect(await expiresAt(p)).not.toBeNull(); // still due: tried again once the job is done
  });

  it('F-M2: a project with a running job is not even marked expired', async () => {
    const user = randomUUID();
    const p = await project(user);
    await db.query(`insert into public.story_jobs (project_id, user_id, kind, status) values ($1, $2, 'render', 'running')`, [p, user]);
    const { rows } = await db.query('select public.story_expire_project($1) as ok', [p]);
    expect(rows[0].ok).toBe(false);
    expect(await status(p)).toBe('finished');
  });

  it('F-M2 (Fable R2): a copy that names a shared key before the delete keeps it', async () => {
    const user = randomUUID();
    const src = await project(user);
    const still = `story/${src}/still/a.png`;
    await db.query(`insert into public.story_shots (project_id, ord, still_key, still_url, status) values ($1, 0, $2, 'u', 'still_ready')`, [src, still]);
    put(still);
    let copy = null;
    const racing = async (args) => {
      if (!copy) {
        ({ rows: [copy] } = await db.query(`insert into public.story_projects (user_id, files_expire_at) values ($1, now() + interval '30 days') returning id`, [user]));
        await db.query(`insert into public.story_shots (project_id, ord, still_key, still_url, status) values ($1, 0, $2, 'u', 'still_ready')`, [copy.id, still]);
      }
      return list(args);
    };
    await runRetention({ list: racing, del });
    expect(deleted).not.toContain(still);
  });

  it('the cron needs CRON_SECRET', async () => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
    await cleanupCron({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('listObjects (mock backend)', () => {
  it('lists keys under a prefix with their upload time, paged', async () => {
    vi.stubEnv('STORY_MOCK', '1');
    const prefix = `story-brand/${randomUUID()}/`;
    const keys = [`${prefix}a.png`, `${prefix}b/c.png`, `${prefix}d.png`];
    for (const key of keys) {
      const file = mockStoragePath(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'x');
    }
    const old = new Date(Date.now() - 3 * ORPHAN_AGE_MS);
    await utimes(mockStoragePath(keys[0]), old, old);
    const first = await listObjects({ prefix, limit: 2 });
    const second = await listObjects({ prefix, limit: 2, cursor: first.cursor });
    expect([...first.objects, ...second.objects].map((o) => o.key)).toEqual(keys);
    expect(second.cursor).toBeNull();
    expect(Date.parse(first.objects[0].uploadedAt)).toBeLessThan(Date.now() - 2 * ORPHAN_AGE_MS);
    await expect(listObjects({ prefix: '../' })).rejects.toThrow();
    await rm(mockStoragePath(`${prefix}a.png`).replace(/a\.png$/, ''), { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
});
