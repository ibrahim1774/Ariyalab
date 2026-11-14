import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/story/errors.js';
import { ModerationError } from '../../lib/moderation.js';
import {
  createProject,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  updateProject,
} from '../../lib/story/projects.js';

let raw;

beforeAll(async () => {
  // mockEnv sets a fake ANTHROPIC_API_KEY, which would make screenText call
  // the real classifier. Without a key, STORY_MOCK=1 skips that layer.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  raw = await createTestDb();
  setStoryDb(raw);
}, 60_000);

afterAll(async () => {
  setStoryDb(null);
  vi.unstubAllEnvs();
  await raw?.close();
});

const BRIEF = {
  purpose: 'coaching',
  offer: 'A six week course that helps new barbers fill their chair.',
  style: '3d_family',
  seconds: 45,
  aspect: '9:16',
  quality: 'pro_narrated',
};

const userA = () => randomUUID();

describe('createProject', () => {
  it('creates a project at the brief step', async () => {
    const userId = userA();
    const project = await createProject({ userId, input: BRIEF });
    expect(project).toMatchObject({ ...BRIEF, user_id: userId, step: 'brief', status: 'draft', mode: 'narrated' });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('defaults mode to talking for pro_talking', async () => {
    const project = await createProject({ userId: userA(), input: { quality: 'pro_talking' } });
    expect(project.mode).toBe('talking');
  });

  it.each([
    [{ seconds: 14 }],
    [{ seconds: 76 }],
    [{ seconds: 30.5 }],
    [{ seconds: '30' }],
    [{ purpose: 'crypto' }],
    [{ style: 'photoreal' }],
    [{ quality: 'ultra' }],
    [{ aspect: '4:3' }],
    [{ mode: 'silent' }],
    [{ title: 'x'.repeat(121) }],
    [{ step: 'done' }],
    [{ fee_charged: true }],
  ])('rejects %j', async (input) => {
    await expect(createProject({ userId: userA(), input })).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts the length bounds', async () => {
    const userId = userA();
    expect((await createProject({ userId, input: { seconds: 15 } })).seconds).toBe(15);
    expect((await createProject({ userId, input: { seconds: 75 } })).seconds).toBe(75);
  });

  it('screens customer text', async () => {
    await expect(
      createProject({ userId: userA(), input: { ...BRIEF, offer: 'nude photos' } })
    ).rejects.toBeInstanceOf(ModerationError);
  });
});

describe('getProject / listProjects', () => {
  it("another user's getProject throws NotFoundError", async () => {
    const project = await createProject({ userId: userA(), input: BRIEF });
    await expect(getProject({ userId: userA(), id: project.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a malformed id is not found', async () => {
    await expect(getProject({ userId: userA(), id: 'not-a-uuid' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists only the caller’s projects, most recently updated first', async () => {
    const userId = userA();
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const first = await createProject({ userId, input: { title: 'First' } });
    await tick();
    const second = await createProject({ userId, input: { title: 'Second' } });
    await createProject({ userId: userA(), input: { title: 'Other' } });
    expect((await listProjects({ userId })).map((p) => p.id)).toEqual([second.id, first.id]);
    await tick();
    await updateProject({ userId, id: first.id, patch: { title: 'First again' } });
    expect((await listProjects({ userId })).map((p) => p.id)).toEqual([first.id, second.id]);
  });
});

describe('updateProject', () => {
  it('updates allowed fields', async () => {
    const userId = userA();
    const p = await createProject({ userId, input: BRIEF });
    const next = await updateProject({ userId, id: p.id, patch: { title: 'Chair', seconds: 60, style: 'custom', style_custom: 'paper cut' } });
    expect(next).toMatchObject({ title: 'Chair', seconds: 60, style: 'custom', style_custom: 'paper cut' });
  });

  it('rejects fields outside the patch list and bad values', async () => {
    const userId = userA();
    const p = await createProject({ userId, input: BRIEF });
    for (const patch of [{ step: 'done' }, { status: 'finished' }, { fee_charged: true }, { user_id: userA() }, { seconds: 90 }, {}]) {
      await expect(updateProject({ userId, id: p.id, patch })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('screens changed text and refuses other owners', async () => {
    const userId = userA();
    const p = await createProject({ userId, input: BRIEF });
    await expect(updateProject({ userId, id: p.id, patch: { title: 'porn' } })).rejects.toBeInstanceOf(ModerationError);
    await expect(updateProject({ userId: userA(), id: p.id, patch: { title: 'Mine now' } })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getProject({ userId, id: p.id })).title).not.toBe('Mine now');
  });
});

async function seedChildren(project) {
  const db = storyDb();
  await db.insert('story_scripts', [
    { project_id: project.id, version: 1, scenes: [{ id: 's1', title: 'Old', visual: 'v', lines: [] }] },
    { project_id: project.id, version: 2, scenes: [{ id: 's1', title: 'New', visual: 'v', lines: [{ speaker: 'narrator', text: 'Hi' }] }] },
  ]);
  await db.insert('story_cast', {
    project_id: project.id,
    name: 'Sam',
    description: 'A barber',
    image_url: 'https://example.test/sam.png',
    sheet: { front: 'f.png', three_quarter: 't.png', face: 'c.png' },
    candidates: [{ url: 'a.png' }, { url: 'b.png' }, { url: 'c.png' }],
  });
  await db.insert('story_shots', [
    { project_id: project.id, ord: 0, scene_id: 's1', description: 'Opening', still_url: 's0.png', clip_url: 'c0.mp4', status: 'ready', attempts: 2 },
    { project_id: project.id, ord: 1, scene_id: 's1', description: 'Close', status: 'draft' },
  ]);
}

describe('deleteProject', () => {
  it('removes the project and its child rows', async () => {
    const userId = userA();
    const p = await createProject({ userId, input: BRIEF });
    await seedChildren(p);
    await deleteProject({ userId, id: p.id });
    await expect(getProject({ userId, id: p.id })).rejects.toBeInstanceOf(NotFoundError);
    for (const table of ['story_scripts', 'story_cast', 'story_shots']) {
      expect(await storyDb().select(table, { project_id: p.id }), table).toEqual([]);
    }
  });

  it('refuses another owner and in-flight jobs', async () => {
    const userId = userA();
    const p = await createProject({ userId, input: BRIEF });
    await expect(deleteProject({ userId: userA(), id: p.id })).rejects.toBeInstanceOf(NotFoundError);
    const [job] = await storyDb().insert('story_jobs', { project_id: p.id, user_id: userId, kind: 'clip', status: 'running' });
    await expect(deleteProject({ userId, id: p.id })).rejects.toBeInstanceOf(ConflictError);
    await storyDb().update('story_jobs', { id: job.id }, { status: 'done' });
    await deleteProject({ userId, id: p.id });
  });
});

describe('duplicateProject', () => {
  it('copies the latest script and the cast but not clips', async () => {
    const userId = userA();
    const src = await createProject({ userId, input: { ...BRIEF, title: 'Chair' } });
    await storyDb().update('story_projects', { id: src.id }, { step: 'review', status: 'finished', fee_charged: true, rerolls_used: 3 });
    await seedChildren(src);

    const copy = await duplicateProject({ userId, id: src.id });
    expect(copy.id).not.toBe(src.id);
    expect(copy).toMatchObject({
      title: 'Chair copy', purpose: 'coaching', style: '3d_family', seconds: 45, quality: 'pro_narrated',
      step: 'storyboard', status: 'draft', fee_charged: false, rerolls_used: 0, user_id: userId,
    });

    const scripts = await storyDb().select('story_scripts', { project_id: copy.id });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].scenes[0].title).toBe('New');

    const cast = await storyDb().select('story_cast', { project_id: copy.id });
    expect(cast).toHaveLength(1);
    expect(cast[0]).toMatchObject({
      name: 'Sam', image_url: 'https://example.test/sam.png',
      sheet: { front: 'f.png', three_quarter: 't.png', face: 'c.png' },
    });
    expect(cast[0].candidates).toHaveLength(3);

    const shots = await storyDb().select('story_shots', { project_id: copy.id }, { order: 'ord' });
    expect(shots.map((s) => [s.description, s.clip_url, s.still_url, s.status, s.attempts])).toEqual([
      ['Opening', null, 's0.png', 'still_ready', 0],
      ['Close', null, null, 'draft', 0],
    ]);

    // The source is untouched.
    const srcShots = await storyDb().select('story_shots', { project_id: src.id }, { order: 'ord' });
    expect(srcShots[0].clip_url).toBe('c0.mp4');
  });

  it('keeps an early step when there are no shots and copies the reference', async () => {
    const userId = userA();
    const src = await createProject({ userId, input: BRIEF });
    const [ref] = await storyDb().insert('story_references', {
      project_id: src.id, source_type: 'link', source_url: 'https://example.test/v', beat_sheet: [{ ord: 0, start: 0, end: 2, visual: 'v', said: 's', why: 'w' }],
    });
    await storyDb().update('story_projects', { id: src.id }, { step: 'script', reference_id: ref.id });
    const copy = await duplicateProject({ userId, id: src.id });
    expect(copy.step).toBe('script');
    expect(copy.reference_id).not.toBe(ref.id);
    const [copiedRef] = await storyDb().select('story_references', { id: copy.reference_id });
    expect(copiedRef).toMatchObject({ project_id: copy.id, source_url: 'https://example.test/v' });
    expect(copiedRef.beat_sheet).toHaveLength(1);
  });

  it("refuses another user's project", async () => {
    const src = await createProject({ userId: userA(), input: BRIEF });
    await expect(duplicateProject({ userId: userA(), id: src.id })).rejects.toBeInstanceOf(NotFoundError);
  });
});
