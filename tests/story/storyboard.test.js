// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, InsufficientCreditsError } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { registerMock } from '../../lib/providers/mock.js';
import { ModerationError } from '../../lib/moderation.js';
import { FORBIDDEN_NAMES, updateScene } from '../../lib/story/script.js';
import { STYLES } from '../../lib/story/prompts/styles.js';
import { storyShotsMock } from '../../lib/story/mocks.js';
import { buildShotsSystem, buildShotsMessage, stillPrompt, SHOTS_SCHEMA, MAX_CAST_REFS } from '../../lib/story/prompts/shot.js';
import {
  buildShotList, generateStills, updateShot, markStale, listShots, fitSeconds, stillAttemptCost,
  _setStoryboardDeps, FREE_FIRST_TRIES, STALE_CLAIM_MS,
} from '../../lib/story/storyboard.js';
import { holdCredits } from '../../lib/credits.js';
import { enqueue } from '../../lib/story/runner.js';
import { stillHandler } from '../../lib/story/stillJobs.js';
import { tick, _handlerCallScope } from '../../lib/story/runner.js';
import { KINDS_REGISTERED_LATER } from '../../lib/story/handlers.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__shotTestSession ?? null),
}));

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
  _resetPricingCache();
  await raw?.close();
});
beforeEach(() => {
  _resetPricingCache();
});
afterEach(async () => {
  _setStoryboardDeps();
  registerMock('story_shots', storyShotsMock);
  globalThis.__shotTestSession = null;
  await raw.query(`delete from pricing_config where key = 'stillReroll'`).catch(() => {});
});

// ---------------------------------------------------------------- fixtures

const SCENES = [
  { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }, { speaker: 'narrator', text: 'Maya kept sweeping anyway.' }] },
  { id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees and Maya laughs.', lines: [{ speaker: 'narrator', text: 'Then Leo walked in with coffee.' }, { speaker: 'narrator', text: 'He sat down and stayed.' }] },
  { id: 's3', title: 'Morning', visual: 'A line of people waits outside at sunrise.', lines: [{ speaker: 'narrator', text: 'By morning there was a line.' }, { speaker: 'narrator', text: 'And it never went away.' }] },
];
const FIVE = ['Maya', 'Leo', 'Ana', 'Sam', 'Rosa'];

async function newProject({ scenes = SCENES, funds = 1000, cast = ['Maya', 'Leo'], product = false, seconds = 18 } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Storyboard test', style: '3d_family', step: 'cast', seconds, quality: 'standard' });
  if (scenes) await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes, source: 'brief' });
  if (cast.length) {
    await storyDb().insert('story_cast', cast.map((name, ord) => ({
      project_id: project.id, ord, name, description: `${name} looks friendly.`, status: 'ready',
      image_url: `/pick/${name}.png`, image_key: `pick-${name}`,
      sheet: { url: `/sheet/${name}.png`, key: `sheet-${name}`, from_key: `pick-${name}` },
    })));
  }
  if (product) {
    const [asset] = await storyDb().insert('story_assets', { user_id: userId, kind: 'product_photo', url: '/product/bottle.png' });
    await storyDb().insert('story_project_assets', { project_id: project.id, asset_id: asset.id, role: 'product' });
  }
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}

const shotRows = (projectId) => storyDb().select('story_shots', { project_id: projectId }, { order: 'ord' });
const shotRow = async (id) => (await storyDb().select('story_shots', { id }))[0];
const stillJobs = (projectId) => storyDb().select('story_jobs', { project_id: projectId, kind: 'still' }, { order: ['created_at', 'id'] });
const balance = (userId) => getBalance(userId);

const T0 = Date.parse('2026-11-14T12:00:00.000Z');
let clock = T0;
/** Runs this project's jobs to the end with the mock provider (submit, pending, done). */
async function finishJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 6; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}

async function builtProject(opts) {
  const ctx = await newProject(opts);
  await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
  return { ...ctx, shots: await shotRows(ctx.project.id) };
}

/** A project whose shots all have a first still (made free). */
async function stilledProject(opts) {
  const ctx = await builtProject(opts);
  await generateStills({ userId: ctx.userId, projectId: ctx.project.id });
  await finishJobs(ctx.project.id);
  return { ...ctx, shots: await shotRows(ctx.project.id) };
}

/** Makes the next still job of a shot fail at the provider. */
async function makeNextStillFail(shotId) {
  await storyDb().update('story_shots', { id: shotId }, { description: `${(await shotRow(shotId)).description} [[mock:fail]]` });
}

// ---------------------------------------------------------------- prompts

describe('shot prompts', () => {
  it('never names a studio, a famous character or a person', () => {
    const text = [
      buildShotsSystem({ seconds: 30 }),
      buildShotsMessage({ scenes: SCENES, seconds: 30, cast: [{ name: 'Maya', description: 'd' }], current: [] }),
      ...Object.values(STYLES).map((s) => stillPrompt({ style: s.promptFragment, description: 'A barber at work.', castNames: ['Maya'], product: true })),
    ].join('\n').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    for (const name of FORBIDDEN_NAMES) expect(text, name).not.toContain(` ${name.replace(/[^a-z0-9]+/g, ' ')} `);
  });

  it('asks for 3 to 6 second shots near the target length and describes the schema', () => {
    const system = buildShotsSystem({ seconds: 30 });
    expect(system).toMatch(/3 to 6 seconds/);
    expect(system).toMatch(/27/);
    expect(system).toMatch(/33/);
    expect(SHOTS_SCHEMA.properties.shots.items.required).toEqual(['sceneId', 'description', 'line', 'seconds', 'cast']);
  });

  it('puts the current shots in the message so unchanged scenes come back word for word', () => {
    const msg = buildShotsMessage({ scenes: SCENES, seconds: 30, cast: [], current: [{ sceneId: 's1', description: 'Old shot', line: 'x', seconds: 3, cast: [] }] });
    expect(msg).toContain('Old shot');
    expect(buildShotsSystem({ seconds: 30 })).toMatch(/word for word/i);
  });

  it('still prompts carry the style, the description, the references and no text', () => {
    const p = stillPrompt({ style: 'Soft clay look.', description: 'Maya sweeps.', castNames: ['Maya', 'Leo'], product: true });
    expect(p).toContain('Soft clay look.');
    expect(p).toContain('Maya sweeps.');
    expect(p).toMatch(/Maya/);
    expect(p).toMatch(/product/i);
    expect(p).toMatch(/no text/i);
  });
});

// ---------------------------------------------------------------- seconds

describe('fitSeconds', () => {
  it('keeps every shot an integer from 3 to 6 and the sum within 10% of the target', () => {
    const out = fitSeconds([{ seconds: 2.2 }, { seconds: 9 }, { seconds: 4.6 }, { seconds: 5 }, { seconds: 1 }], 30);
    expect(out.every((s) => Number.isInteger(s) && s >= 3 && s <= 6)).toBe(true);
    const sum = out.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(27);
    expect(sum).toBeLessThanOrEqual(33);
  });

  it('does not change fixed (preserved) shots', () => {
    const out = fitSeconds([{ seconds: 3, fixed: true }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }], 20);
    expect(out[0]).toBe(3);
    expect(out.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(18);
  });

  it('returns null when no split of 3 to 6 seconds can reach the target', () => {
    expect(fitSeconds([{ seconds: 6 }, { seconds: 6 }], 60)).toBeNull();
  });
});

// ---------------------------------------------------------------- buildShotList

describe('buildShotList', () => {
  it('turns scenes into shots with seconds 3 to 6, cast ids and the project quality, and moves to the storyboard step', async () => {
    const { userId, project } = await newProject();
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.length).toBe(6);
    expect(shots.map((s) => s.ord)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(shots.map((s) => s.scene_id)).toEqual(['s1', 's1', 's2', 's2', 's3', 's3']);
    const sum = shots.reduce((n, s) => n + s.seconds, 0);
    expect(sum).toBeGreaterThanOrEqual(Math.ceil(18 * 0.9));
    expect(sum).toBeLessThanOrEqual(Math.floor(18 * 1.1));
    expect(shots.every((s) => s.seconds >= 3 && s.seconds <= 6 && s.quality === 'standard' && s.status === 'draft')).toBe(true);
    const cast = await storyDb().select('story_cast', { project_id: project.id }, { order: 'ord' });
    expect(shots[2].cast_ids.sort()).toEqual(cast.map((c) => c.id).sort());
    expect(shots[0].cast_ids).toEqual([cast[0].id]);
    expect((await storyDb().select('story_projects', { id: project.id }))[0].step).toBe('storyboard');
  });

  it('asks the smart model, and fixes seconds the model got wrong', async () => {
    const calls = [];
    registerMock('story_shots', (args) => {
      calls.push(args);
      return { shots: SCENES.map((s) => ({ sceneId: s.id, description: s.visual, line: s.lines[0].text, seconds: 12, cast: [] })) };
    });
    const { userId, project } = await newProject();
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(calls).toHaveLength(1);
    expect(calls[0].tier).toBe('smart');
    expect(shots.map((s) => s.seconds)).toEqual([6, 6, 6]);
  });

  it('drops shots for scenes that do not exist and names that are not in the cast', async () => {
    registerMock('story_shots', () => ({ shots: [
      { sceneId: 's1', description: 'One', line: 'a', seconds: 6, cast: ['maya', 'Nobody'] },
      { sceneId: 'zz', description: 'Ghost', line: 'b', seconds: 6, cast: [] },
      { sceneId: 's2', description: 'Two', line: '', seconds: 6, cast: [] },
      { sceneId: 's3', description: 'Three', line: 'c', seconds: 6, cast: [] },
    ] }));
    const { userId, project } = await newProject();
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.map((s) => s.description)).toEqual(['One', 'Two', 'Three']);
    expect(shots[0].cast_ids).toHaveLength(1);
    expect(shots[1].line).toBeNull();
  });

  it('screens the descriptions and lines, retries once family friendly, then 422 shots_blocked', async () => {
    const systems = [];
    registerMock('story_shots', ({ system }) => {
      systems.push(system);
      return { shots: SCENES.map((s) => ({ sceneId: s.id, description: 'They have sex in the shop.', line: 'x', seconds: 6, cast: [] })) };
    });
    const { userId, project } = await newProject();
    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject({ status: 422, code: 'shots_blocked' });
    expect(systems).toHaveLength(2);
    expect(systems[1]).toMatch(/family friendly/i);
    expect(await shotRows(project.id)).toEqual([]);
  });

  it('needs a script, and a free account gets 402 plan_required', async () => {
    const none = await newProject({ scenes: null });
    await expect(buildShotList({ userId: none.userId, projectId: none.project.id })).rejects.toMatchObject({ status: 422 });
    accounts.set({ paid: false });
    const free = await newProject();
    await expect(buildShotList({ userId: free.userId, projectId: free.project.id })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });

  it("another user's project is a 404", async () => {
    const { project } = await newProject();
    await expect(buildShotList({ userId: randomUUID(), projectId: project.id })).rejects.toMatchObject({ status: 404 });
  });

  it('preserved shots keep clip_url after a one-scene edit and the edited scene\'s shots are stale', async () => {
    const { userId, project, shots } = await builtProject();
    for (const s of shots) {
      await storyDb().update('story_shots', { id: s.id }, { still_url: `/still/${s.id}.png`, still_key: `still-${s.id}`, clip_url: `/clip/${s.id}.mp4`, clip_key: `clip-${s.id}`, status: 'ready' });
    }
    await updateScene({ userId, projectId: project.id, sceneId: 's2', patch: { visual: 'Leo walks in soaked from the rain.' } });

    const afterEdit = await shotRows(project.id);
    expect(afterEdit.filter((s) => s.scene_id === 's2').every((s) => s.stale)).toBe(true);
    expect(afterEdit.filter((s) => s.scene_id !== 's2').every((s) => !s.stale)).toBe(true);

    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject({ status: 409, code: 'rebuild_loses_clips', extra: { count: 2 } });
    await buildShotList({ userId, projectId: project.id, confirm: true });
    const after = await shotRows(project.id);
    const kept = shots.filter((s) => s.scene_id !== 's2');
    for (const old of kept) {
      const now = after.find((s) => s.id === old.id);
      expect(now, old.description).toBeTruthy();
      expect(now.clip_url).toBe(`/clip/${old.id}.mp4`);
      expect(now.still_url).toBe(`/still/${old.id}.png`);
      expect(now.stale).toBe(false);
    }
    const s2 = after.filter((s) => s.scene_id === 's2');
    expect(s2.length).toBe(2);
    expect(s2.every((s) => !shots.some((o) => o.id === s.id) && !s.clip_url && !s.still_url)).toBe(true);
    expect(after.map((s) => s.ord)).toEqual(after.map((_, i) => i));
  });

  it('keeps the quality and seconds the customer set on a preserved shot', async () => {
    const { userId, project, shots } = await builtProject();
    await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { quality: 'pro_narrated' } });
    await buildShotList({ userId, projectId: project.id });
    const now = await shotRow(shots[0].id);
    expect(now.quality).toBe('pro_narrated');
    expect(now.seconds).toBe(shots[0].seconds);
  });

  it('is a 409 while a still is being made, and changes nothing', async () => {
    const { userId, project, shots } = await builtProject();
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject({ status: 409 });
    expect((await shotRows(project.id)).map((s) => s.id)).toEqual(shots.map((s) => s.id));
  });

  it('two builds at once leave one shot list', async () => {
    const { userId, project } = await newProject();
    await Promise.allSettled([buildShotList({ userId, projectId: project.id }), buildShotList({ userId, projectId: project.id })]);
    expect(await shotRows(project.id)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------- markStale

describe('markStale', () => {
  it('flags only the shots of the given scenes whose scene changed', async () => {
    const { project } = await builtProject();
    const changed = SCENES.map((sc) => (sc.id === 'two' ? sc : { ...sc, title: sc.id === 's2' ? sc.title : `${sc.title} again` }));
    await storyDb().insert('story_scripts', { project_id: project.id, version: 2, scenes: changed, source: 'edit' });
    await markStale({ projectId: project.id, sceneIds: ['s1', 's2', 's3'] });
    const rows = await shotRows(project.id);
    expect(rows.map((s) => [s.scene_id, s.stale])).toEqual([['s1', true], ['s1', true], ['s2', false], ['s2', false], ['s3', true], ['s3', true]]);
    expect(await markStale({ projectId: project.id, sceneIds: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------- generateStills

describe('generateStills', () => {
  it('queues one still job per shot, free, with the cast sheets and the product photo as references', async () => {
    const { userId, project, shots } = await builtProject({ product: true });
    const out = await generateStills({ userId, projectId: project.id });
    expect(out.charged).toBe(0);
    expect(out.queued.sort()).toEqual(shots.map((s) => s.id).sort());
    const jobs = await stillJobs(project.id);
    expect(jobs).toHaveLength(6);
    const first = jobs.find((j) => j.shot_id === shots[0].id);
    expect(first.payload.refs).toEqual(['/sheet/Maya.png', '/product/bottle.png']);
    expect(first.hold_id).toBeNull();
    expect(first.payload.aspect).toBe('9:16');
    expect((await shotRows(project.id)).every((s) => s.status === 'still_pending')).toBe(true);
    await finishJobs(project.id);
    const done = await shotRows(project.id);
    expect(done.every((s) => s.status === 'still_ready' && s.still_url && s.still_key)).toBe(true);
    expect((await balance(userId)).available).toBe(1000);
  });

  it('still refs never exceed 3 cast sheets', async () => {
    const scenes = [{ id: 's1', title: 'Crowd', visual: `${FIVE.join(', ')} all dance in the shop.`, lines: [{ speaker: 'narrator', text: 'Everyone came.' }] },
      { id: 's2', title: 'Two', visual: 'The shop is quiet.', lines: [{ speaker: 'narrator', text: 'Then it was quiet.' }] },
      { id: 's3', title: 'Three', visual: 'The door closes.', lines: [{ speaker: 'narrator', text: 'Goodnight.' }] }];
    const { userId, project } = await builtProject({ scenes, cast: FIVE, product: true, seconds: 15 });
    const [crowd] = await shotRows(project.id);
    expect(crowd.cast_ids).toHaveLength(5);
    await generateStills({ userId, projectId: project.id, shotIds: [crowd.id] });
    const [job] = await stillJobs(project.id);
    const sheets = job.payload.refs.filter((r) => r.startsWith('/sheet/'));
    expect(sheets).toHaveLength(MAX_CAST_REFS);
    expect(MAX_CAST_REFS).toBe(3);
    expect(job.payload.refs).toContain('/product/bottle.png');
  });

  it('falls back to the picked picture when a character has no sheet yet', async () => {
    const { userId, project, shots } = await builtProject();
    await storyDb().update('story_cast', { project_id: project.id, name: 'Maya' }, { sheet: {} });
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    expect((await stillJobs(project.id))[0].payload.refs).toEqual(['/pick/Maya.png']);
  });

  it('a shot with source footage gets no still job', async () => {
    const { userId, project, shots } = await builtProject();
    await storyDb().update('story_shots', { id: shots[1].id }, { source: 'footage' });
    const out = await generateStills({ userId, projectId: project.id });
    const jobs = await stillJobs(project.id);
    expect(jobs).toHaveLength(5);
    expect(jobs.some((j) => j.shot_id === shots[1].id)).toBe(false);
    expect(out.refused).toContainEqual({ shotId: shots[1].id, reason: 'footage' });
    const only = await generateStills({ userId, projectId: project.id, shotIds: [shots[1].id] });
    expect(only.queued).toEqual([]);
    expect(await stillJobs(project.id)).toHaveLength(5);
  });

  it('re-roll charges 2', async () => {
    const { userId, project, shots } = await stilledProject();
    const before = await balance(userId);
    const out = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    expect(out.charged).toBe(2);
    const job = (await stillJobs(project.id)).at(-1);
    expect(job.cost_credits).toBe(2);
    expect(job.hold_id).toBeTruthy();
    expect((await balance(userId)).held).toBe(2);
    await finishJobs(project.id);
    const after = await balance(userId);
    expect(after.held).toBe(0);
    expect(before.available - after.available).toBe(2);
  });

  it('reads the re-roll price from pricing', async () => {
    const { userId, project, shots } = await stilledProject();
    await raw.query(`insert into pricing_config (key, value) values ('stillReroll', '7'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    const out = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    expect(out.charged).toBe(7);
  });

  it('without enough credits a re-roll is a 402 and nothing is queued or claimed', async () => {
    const { userId, project, shots } = await stilledProject({ funds: 1 });
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[0].id, shots[1].id] })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await stillJobs(project.id)).toHaveLength(6);
    expect((await shotRow(shots[0].id)).status).toBe('still_ready');
  });

  it('a free account gets 402 plan_required', async () => {
    const { userId, project } = await builtProject();
    accounts.set({ paid: false });
    await expect(generateStills({ userId, projectId: project.id })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });

  it('two requests at once make one job and one charge', async () => {
    const { userId, project, shots } = await stilledProject();
    const results = await Promise.allSettled([
      generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] }),
      generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.queued.length === 1)).toHaveLength(1);
    expect((await stillJobs(project.id)).filter((j) => j.shot_id === shots[0].id)).toHaveLength(2);
    expect((await balance(userId)).held).toBe(2);
  });

  it('is a 409 for a shot whose still is still being made', async () => {
    const { userId, project, shots } = await builtProject();
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] })).rejects.toMatchObject({ status: 409 });
  });

  it("another user's shot is a 404", async () => {
    const a = await builtProject();
    const b = await builtProject();
    await expect(generateStills({ userId: a.userId, projectId: a.project.id, shotIds: [b.shots[0].id] })).rejects.toMatchObject({ status: 404 });
  });

  it('a failed first still leaves the shot failed and is not charged; the next make is still the free first one', async () => {
    const { userId, project, shots } = await builtProject();
    await makeNextStillFail(shots[0].id);
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await finishJobs(project.id);
    const row = await shotRow(shots[0].id);
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();
    expect((await balance(userId)).available).toBe(1000);
    const again = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    expect(again.charged).toBe(0);
  });
});

// ---------------------------------------------------------------- retry

describe('retry', () => {
  it('after a failed free first still it is free and makes the same request again', async () => {
    const { userId, project, shots } = await builtProject();
    await makeNextStillFail(shots[0].id);
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await finishJobs(project.id);
    const failedJob = (await stillJobs(project.id)).at(-1);

    const out = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id], retry: true });
    expect(out.charged).toBe(0);
    const job = (await stillJobs(project.id)).at(-1);
    expect(job.id).not.toBe(failedJob.id);
    expect(job.payload.prompt).toBe(failedJob.payload.prompt);
    expect(job.payload.kind).toBe('retry');
    expect(job.hold_id).toBeNull();
  });

  it('a retry does not count as the free first still: the make after it is a paid re-roll', async () => {
    const { userId, project, shots } = await builtProject();
    await makeNextStillFail(shots[0].id);
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await finishJobs(project.id);
    // The retry repeats the failed prompt, so take the fail token out of the stored job first.
    const failed = (await stillJobs(project.id)).at(-1);
    await storyDb().update('story_jobs', { id: failed.id }, { payload: { ...failed.payload, prompt: failed.payload.prompt.replace(' [[mock:fail]]', '') } });
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id], retry: true });
    await finishJobs(project.id);
    expect((await shotRow(shots[0].id)).status).toBe('still_ready');
    const out = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    expect(out.charged).toBe(2);
  });

  it('a paid re-roll that fails is refunded, and its retry holds the same price again (a retry never charges twice)', async () => {
    const { userId, project, shots } = await stilledProject();
    await makeNextStillFail(shots[0].id);
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await finishJobs(project.id);
    let bal = await balance(userId);
    expect(bal.available).toBe(1000);
    expect(bal.held).toBe(0);
    const views = (await listShots({ userId, projectId: project.id })).shots;
    expect(views.find((s) => s.id === shots[0].id).retry_credits).toBe(2);

    const out = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id], retry: true });
    expect(out.charged).toBe(2);
    const job = (await stillJobs(project.id)).at(-1);
    expect(job.payload.kind).toBe('retry');
    expect(job.cost_credits).toBe(2);
    bal = await balance(userId);
    expect(bal.held).toBe(2);
  });

  it('is refused when the last attempt did not fail, is pending, was blocked, or never happened', async () => {
    const { userId, project, shots } = await stilledProject();
    // last attempt succeeded
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[0].id], retry: true })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
    // never happened
    const fresh = await builtProject();
    await expect(generateStills({ userId: fresh.userId, projectId: fresh.project.id, shotIds: [fresh.shots[0].id], retry: true })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
    // blocked
    await storyDb().update('story_shots', { id: shots[1].id }, { description: `${shots[1].description} [[mock:blocked]]` });
    await generateStills({ userId, projectId: project.id, shotIds: [shots[1].id] });
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[1].id], retry: true })).rejects.toMatchObject({ status: 409 });
    await finishJobs(project.id);
    expect((await shotRow(shots[1].id)).status).toBe('blocked');
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[1].id], retry: true })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
  });

  it('is refused after the description changed since the failure', async () => {
    const { userId, project, shots } = await builtProject();
    await makeNextStillFail(shots[0].id);
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await finishJobs(project.id);
    await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { description: 'A new idea for this shot.' } });
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[0].id], retry: true })).rejects.toMatchObject({ code: 'retry_not_available' });
  });
});

describe('stillAttemptCost', () => {
  const pricing = { stillReroll: 2 };
  const shot = { still_round: 3 };
  it('first still free, re-roll after a delivered still costs stillReroll', () => {
    expect(stillAttemptCost({ shot, jobs: [], retry: false, pricing })).toEqual({ credits: 0, kind: 'first' });
    expect(stillAttemptCost({ shot, jobs: [{ status: 'failed', payload: { round: 3, kind: 'first', credits: 0 } }], retry: false, pricing })).toEqual({ credits: 0, kind: 'first' });
    expect(stillAttemptCost({ shot, jobs: [{ status: 'done', payload: { round: 1, kind: 'first', credits: 0 } }], retry: false, pricing })).toEqual({ credits: 2, kind: 'reroll' });
  });
  it('a retry costs what the failed attempt cost', () => {
    const jobs = [{ status: 'done', payload: { round: 1 } }, { status: 'failed', cost_credits: 2, payload: { round: 3, kind: 'reroll', credits: 2 } }];
    expect(stillAttemptCost({ shot, jobs, retry: true, pricing: { stillReroll: 9 } })).toEqual({ credits: 2, kind: 'retry' });
    const free = [{ status: 'failed', payload: { round: 3, kind: 'first', credits: 0 } }];
    expect(stillAttemptCost({ shot, jobs: free, retry: true, pricing })).toEqual({ credits: 0, kind: 'retry' });
  });
});

// ---------------------------------------------------------------- updateShot

describe('updateShot', () => {
  it('patching description clears the still and sets stale on the clip', async () => {
    const { userId, project, shots } = await stilledProject();
    await storyDb().update('story_shots', { id: shots[0].id }, { clip_url: '/clip/a.mp4', clip_key: 'clip-a', status: 'ready' });
    const { shot } = await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { description: 'Maya smiles at the mirror.' } });
    expect(shot.description).toBe('Maya smiles at the mirror.');
    expect(shot.still_url).toBeNull();
    expect(shot.still_key).toBeNull();
    expect(shot.clip_url).toBe('/clip/a.mp4');
    expect(shot.stale).toBe(true);
    expect(shot.status).toBe('draft');
  });

  it('patching description of a shot without a clip does not mark it stale', async () => {
    const { userId, project, shots } = await stilledProject();
    const { shot } = await updateShot({ userId, projectId: project.id, shotId: shots[1].id, patch: { description: 'Close on the broom.' } });
    expect(shot.stale).toBe(false);
    expect(shot.still_url).toBeNull();
  });

  it('patching quality only changes the price', async () => {
    const { userId, project, shots } = await stilledProject();
    const before = await shotRow(shots[0].id);
    const { shot } = await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { quality: 'pro_talking' } });
    expect(shot.quality).toBe('pro_talking');
    expect({ ...shot, quality: before.quality, updated_at: before.updated_at }).toEqual(before);
  });

  it('rejects other keys, bad quality and empty descriptions with 422', async () => {
    const { userId, project, shots } = await builtProject();
    const id = shots[0].id;
    await expect(updateShot({ userId, projectId: project.id, shotId: id, patch: { clip_url: 'x' } })).rejects.toMatchObject({ status: 422 });
    await expect(updateShot({ userId, projectId: project.id, shotId: id, patch: { quality: 'ultra' } })).rejects.toMatchObject({ status: 422 });
    await expect(updateShot({ userId, projectId: project.id, shotId: id, patch: { description: '   ' } })).rejects.toMatchObject({ status: 422 });
    await expect(updateShot({ userId, projectId: project.id, shotId: id, patch: {} })).rejects.toMatchObject({ status: 422 });
  });

  it('screens a new description', async () => {
    const { userId, project, shots } = await builtProject();
    await expect(updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { description: 'They have sex here.' } })).rejects.toBeInstanceOf(ModerationError);
  });

  it('is a 409 while the still is being made', async () => {
    const { userId, project, shots } = await builtProject();
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await expect(updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { description: 'Other.' } })).rejects.toMatchObject({ status: 409 });
  });

  it("another user's shot is a 404", async () => {
    const a = await builtProject();
    await expect(updateShot({ userId: randomUUID(), projectId: a.project.id, shotId: a.shots[0].id, patch: { quality: 'economy' } })).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------- still handler

describe('still handler', () => {
  it('is registered (not listed as a later kind)', () => {
    expect(KINDS_REGISTERED_LATER).not.toContain('still');
  });

  it('is safe to run twice and settles only through settleJob', async () => {
    const { userId, project, shots } = await stilledProject();
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    const job = (await stillJobs(project.id)).at(-1);
    await stillHandler.onDone(job, { url: '/a.png', key: 'a' });
    await stillHandler.onDone(job, { url: '/a.png', key: 'a' });
    expect((await shotRow(shots[0].id)).still_url).toBe('/a.png');
    expect((await balance(userId)).held).toBe(0);
    expect(_handlerCallScope().inHandler).toBe(false);
  });

  it('ignores a job from an older round', async () => {
    const { userId, project, shots } = await stilledProject();
    const old = (await stillJobs(project.id)).find((j) => j.shot_id === shots[0].id);
    await stillHandler.onDone(old, { url: '/late.png', key: 'late' });
    await stillHandler.onFail(old, { blocked: false, error: 'x', final: true });
    const row = await shotRow(shots[0].id);
    expect(row.still_url).not.toBe('/late.png');
    expect(row.status).toBe('still_ready');
  });

  it('onFail only writes the database and marks blocked shots blocked', async () => {
    const { userId, project, shots } = await builtProject();
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    const job = (await stillJobs(project.id)).at(-1);
    await stillHandler.onFail(job, { blocked: true, error: 'no', final: true });
    const row = await shotRow(shots[0].id);
    expect(row.status).toBe('blocked');
    expect(row.error).toMatch(/description/i);
  });

  it('submits the stored prompt, references and aspect', async () => {
    const out = await stillHandler.submit({ payload: { prompt: 'A shop', refs: ['/sheet/Maya.png'], aspect: '9:16' } });
    expect(out.taskId).toBeTruthy();
  });
});

// ---------------------------------------------------------------- actions

describe('actions', () => {
  async function call(name, method, { userId, project, body = {} }) {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    globalThis.__shotTestSession = { user: { id: userId, email: 'test@example.test' } };
    const res = makeRes();
    await handleAction(makeReq({ method, body, query: { id: project.id } }), res, name);
    return res;
  }

  it('registers shots (GET, POST), stills (POST) and shot (PATCH)', async () => {
    const { getActionMethods } = await import('../../lib/story/actions.js');
    await import('../../lib/story/actionRoute.js');
    expect(getActionMethods('shots').sort()).toEqual(['GET', 'POST']);
    expect(getActionMethods('stills')).toEqual(['POST']);
    expect(getActionMethods('shot')).toEqual(['PATCH']);
  });

  it('walks the storyboard through the dispatcher with the shapes the screen uses', async () => {
    const ctx = await newProject();
    let res = await call('shots', 'POST', ctx);
    expect(res.statusCode).toBe(200);
    expect(res.body.shots).toHaveLength(6);
    const ids = res.body.shots.map((s) => s.id);

    res = await call('stills', 'POST', { ...ctx, body: { shotIds: ids } });
    expect(res.statusCode).toBe(200);
    expect(res.body.charged).toBe(0);
    await finishJobs(ctx.project.id);

    res = await call('shots', 'GET', ctx);
    expect(res.body.shots.every((s) => s.status === 'still_ready')).toBe(true);

    res = await call('shot', 'PATCH', { ...ctx, body: { shotId: ids[0], patch: { description: 'A brighter morning.' } } });
    expect(res.statusCode).toBe(200);
    expect(res.body.shot.still_url).toBeNull();

    res = await call('stills', 'POST', { ...ctx, body: { shotIds: [ids[1]], retry: true } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('retry_not_available');
    res = await call('shot', 'PATCH', { ...ctx, body: { patch: { quality: 'economy' } } });
    expect(res.statusCode).toBe(422);
  });

  it('answers 402 insufficient_credits for a re-roll without credits', async () => {
    const ctx = await stilledProject({ funds: 1 });
    const res = await call('stills', 'POST', { ...ctx, body: { shotIds: [ctx.shots[0].id] } });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toBe('insufficient_credits');
  });

  it('has a route file for the shot list with a longer maxDuration', async () => {
    const route = await import('../../pages/api/story/projects/[id]/shots.js');
    expect(route.config.maxDuration).toBeGreaterThanOrEqual(60);
  });
});

// ---------------------------------------------------------------- round 1

const editScene = (ctx, sceneId, visual) => updateScene({ userId: ctx.userId, projectId: ctx.project.id, sceneId, patch: { visual } });
const age = async (table, id, column, ms) => {
  await raw.query(`update public.${table} set ${column} = now() - ($2 || ' milliseconds')::interval where id = $1`, [id, String(ms)]);
};

describe('round 1: holds are never left behind (S1, S7)', () => {
  it('a hold that throws after the claim puts the shot back as it was', async () => {
    const { userId, project, shots } = await stilledProject();
    _setStoryboardDeps({ holdCredits: async () => { throw new Error('ledger down'); } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] })).rejects.toThrow('ledger down');
    errors.mockRestore();
    const row = await shotRow(shots[0].id);
    expect(row).toMatchObject({ status: 'still_ready', still_round: shots[0].still_round + 1, still_hold_id: null, stale: false });
    expect(await stillJobs(project.id)).toHaveLength(6);
  });

  it('an enqueue that throws releases the hold and restores status and stale', async () => {
    const { userId, project, shots } = await stilledProject();
    await storyDb().update('story_shots', { id: shots[0].id }, { clip_url: '/clip/a.mp4', status: 'ready' });
    _setStoryboardDeps({ enqueue: async () => { throw new Error('queue down'); } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] })).rejects.toThrow('queue down');
    errors.mockRestore();
    const row = await shotRow(shots[0].id);
    expect(row).toMatchObject({ status: 'ready', stale: false, clip_mismatch: false, still_round: shots[0].still_round + 1, still_hold_id: null });
    expect((await balance(userId)).held).toBe(0);
  });

  it('a batch where one enqueue fails returns the shots that were queued and refuses the other', async () => {
    const { userId, project, shots } = await builtProject();
    let n = 0;
    _setStoryboardDeps({ enqueue: async (args) => { n += 1; if (n === 2) throw new Error('queue down'); return enqueue(args); } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id, shots[1].id] });
    errors.mockRestore();
    expect(out.queued).toEqual([shots[0].id]);
    expect(out.refused).toEqual([{ shotId: shots[1].id, reason: 'failed' }]);
    expect((await shotRow(shots[1].id)).status).toBe('draft');
  });

  async function crashedAfterHold() {
    const ctx = await stilledProject();
    const shot = ctx.shots[0];
    const holdId = randomUUID();
    await holdCredits({ userId: ctx.userId, currency: 'video', amount: 2, projectId: ctx.project.id, holdId });
    await storyDb().update('story_shots', { id: shot.id }, {
      status: 'still_pending', still_round: shot.still_round + 1, still_hold_id: holdId,
      still_claimed_at: new Date().toISOString(), still_prev: { status: 'still_ready', stale: false, error: null },
    });
    return { ...ctx, shot };
  }

  for (const [name, run] of [
    ['generateStills', (c) => generateStills({ userId: c.userId, projectId: c.project.id, shotIds: [c.shots[1].id] })],
    ['updateShot', (c) => updateShot({ userId: c.userId, projectId: c.project.id, shotId: c.shots[1].id, patch: { quality: 'economy' } })],
    ['buildShotList', (c) => buildShotList({ userId: c.userId, projectId: c.project.id })],
  ]) {
    it(`a claim left by a crash (hold made, no job) is released and reset by ${name}`, async () => {
      const ctx = await crashedAfterHold();
      expect((await balance(ctx.userId)).held).toBe(2);
      await age('story_shots', ctx.shot.id, 'still_claimed_at', STALE_CLAIM_MS + 1000);
      await run(ctx);
      expect((await balance(ctx.userId)).held).toBe(name === 'generateStills' ? 2 : 0);
      const row = await shotRow(ctx.shot.id);
      expect(row).toMatchObject({ status: 'still_ready', still_round: ctx.shot.still_round + 1, still_hold_id: null });
    });
  }

  it('a fresh claim, or one whose job exists, is left alone', async () => {
    const ctx = await crashedAfterHold();
    await expect(generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [ctx.shot.id] })).rejects.toMatchObject({ status: 409 });
    expect((await shotRow(ctx.shot.id)).status).toBe('still_pending');
    const b = await stilledProject();
    await generateStills({ userId: b.userId, projectId: b.project.id, shotIds: [b.shots[0].id] });
    await age('story_shots', b.shots[0].id, 'still_claimed_at', STALE_CLAIM_MS + 1000);
    await updateShot({ userId: b.userId, projectId: b.project.id, shotId: b.shots[1].id, patch: { quality: 'economy' } });
    expect((await shotRow(b.shots[0].id)).status).toBe('still_pending');
    expect((await balance(b.userId)).held).toBe(2);
  });
});

describe('round 1: rebuilds (S2, S10)', () => {
  it('only changed scenes go to the model; unchanged scenes keep their shots without asking', async () => {
    const ctx = await builtProject();
    const asked = [];
    registerMock('story_shots', (args) => { asked.push(args); return storyShotsMock(args); });
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect(asked).toHaveLength(1);
    const brief = JSON.parse(/<shot_brief>\n([\s\S]*?)\n<\/shot_brief>/.exec(asked[0].messages[0].content)[1]);
    expect(brief.scenes.map((s) => s.id)).toEqual(['s2']);
    const after = await shotRows(ctx.project.id);
    for (const old of ctx.shots.filter((s) => s.scene_id !== 's2')) expect(after.some((s) => s.id === old.id)).toBe(true);
  });

  it('a rebuild with nothing changed asks nothing and counts nothing', async () => {
    const ctx = await builtProject();
    const builds = async () => (await storyDb().select('story_usage', { user_id: ctx.userId })).filter((u) => u.action.startsWith('shots_build')).reduce((n, u) => n + u.count, 0);
    expect(await builds()).toBe(1);
    const asked = [];
    registerMock('story_shots', (args) => { asked.push(args); return storyShotsMock(args); });
    const { shots } = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect(asked).toHaveLength(0);
    expect(shots.map((s) => s.id)).toEqual(ctx.shots.map((s) => s.id));
    expect(await builds()).toBe(1);
  });

  it('replacement shots of a scene that already had pictures are paid; a first build is free', async () => {
    const ctx = await stilledProject();
    const first = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    expect(first.every((s) => s.still_credits === 2)).toBe(true);
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    const { shots } = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    const s2 = shots.filter((s) => s.scene_id === 's2');
    expect(s2.every((s) => !s.still_url && s.still_credits === 2)).toBe(true);
    await editScene(ctx, 's2', 'Leo walks in dry this time.');
    const again = (await buildShotList({ userId: ctx.userId, projectId: ctx.project.id })).shots.filter((s) => s.scene_id === 's2');
    expect(again.every((s) => s.still_credits === 2)).toBe(true);
    const out = await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [again[0].id] });
    expect(out.charged).toBe(2);
    const fresh = await builtProject();
    expect((await listShots({ userId: fresh.userId, projectId: fresh.project.id })).shots.every((s) => s.still_credits === 0)).toBe(true);
  });

  it('at most 10 shot-list builds per project per day, then 429 daily_limit', async () => {
    const ctx = await builtProject(); // build 1
    for (let i = 2; i <= 10; i += 1) {
      await editScene(ctx, 's1', `Maya sweeps the shop, take ${i}.`);
      await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    }
    await editScene(ctx, 's1', 'Maya sweeps the shop, take 11.');
    await expect(buildShotList({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 429, code: 'daily_limit', extra: { limit: 10 } });
  });

  it('the swap refuses a list whose seconds do not add up under the lock', async () => {
    const ctx = await newProject();
    await expect(storyDb().rpc('story_shots_replace', {
      p_project: ctx.project.id, p_shots: [{ sceneId: 's1', description: 'x', line: null, seconds: 3, quality: 'standard', castIds: [] }], p_confirm: false, p_min: 16, p_max: 19,
    })).rejects.toThrow(/shots_changed/);
    expect(await shotRows(ctx.project.id)).toEqual([]);
  });
});

describe('round 1: prices and caps (S3, S6, S8, S9, S5)', () => {
  it('still_credits is null for footage', async () => {
    const ctx = await builtProject();
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { source: 'footage' });
    const { shots } = await listShots({ userId: ctx.userId, projectId: ctx.project.id });
    expect(shots[0].still_credits).toBeNull();
    expect(shots[1].still_credits).toBe(0);
  });

  it('a batch queues the free shots and refuses the paid one it cannot pay for (200, no 402)', async () => {
    const ctx = await builtProject({ funds: 1 });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { still_delivered: true });
    const out = await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [ctx.shots[0].id, ctx.shots[1].id] });
    expect(out.queued).toEqual([ctx.shots[1].id]);
    expect(out.refused).toEqual([{ shotId: ctx.shots[0].id, reason: 'insufficient_credits' }]);
    expect((await shotRow(ctx.shots[0].id)).status).toBe('draft');
  });

  it('updateShot answers 409 for a busy shot before screening the text', async () => {
    const ctx = await builtProject();
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [ctx.shots[0].id] });
    await expect(updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id, patch: { description: 'They have sex here.' } })).rejects.toMatchObject({ status: 409 });
  });

  it(`free makes after failed first stills stop after ${FREE_FIRST_TRIES}; then a make costs stillReroll`, async () => {
    const ctx = await builtProject();
    const id = ctx.shots[0].id;
    await makeNextStillFail(id);
    for (let i = 0; i < FREE_FIRST_TRIES; i += 1) {
      const out = await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] });
      expect(out.charged).toBe(0);
      await finishJobs(ctx.project.id);
      expect((await shotRow(id)).status).toBe('failed');
    }
    const view = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots[0];
    expect(view.still_credits).toBe(2);
    expect(view.retry_credits).toBe(0);
    expect((await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] })).charged).toBe(2);
  });

  it('onDone for a shot that is gone releases the hold instead of settling', async () => {
    const ctx = await stilledProject();
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [ctx.shots[0].id] });
    const job = (await stillJobs(ctx.project.id)).at(-1);
    expect((await balance(ctx.userId)).held).toBe(2);
    await storyDb().remove('story_shots', { id: ctx.shots[0].id });
    await stillHandler.onDone(job, { url: '/x.png', key: 'x' });
    const bal = await balance(ctx.userId);
    expect(bal.held).toBe(0);
    expect(bal.available).toBe(1000);
  });
});

// ---------------------------------------------------------------- round 1 follow-up

describe('round 1 follow-up', () => {
  it('a rebuild after removing a scene returns a length note when the video falls outside 10% of the length', async () => {
    const ctx = await builtProject();
    const first = await listShots({ userId: ctx.userId, projectId: ctx.project.id });
    expect(first.length_note).toBeUndefined();
    await storyDb().insert('story_scripts', { project_id: ctx.project.id, version: 2, scenes: SCENES.slice(0, 2), source: 'edit' });
    const out = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect(out.shots).toHaveLength(4);
    expect(out.length_note).toEqual({ totalSeconds: 12, targetSeconds: 18 });
  });

  it('no length note when the total is within 10%', async () => {
    const ctx = await newProject();
    const out = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect(out.length_note).toBeUndefined();
  });

  it(`free retries of free attempts stop after ${FREE_FIRST_TRIES}; then a retry costs stillReroll`, async () => {
    const ctx = await builtProject();
    const id = ctx.shots[0].id;
    await makeNextStillFail(id);
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] });
    await finishJobs(ctx.project.id);
    for (let i = 0; i < FREE_FIRST_TRIES; i += 1) {
      const out = await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id], retry: true });
      expect(out.charged).toBe(0);
      await finishJobs(ctx.project.id);
    }
    expect((await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots[0].retry_credits).toBe(2);
    expect((await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id], retry: true })).charged).toBe(2);
  });

  it('stillAttemptCost: a retry of a free attempt after 3 free retries costs stillReroll; a paid retry keeps its price', () => {
    const failedFree = { status: 'failed', payload: { round: 5, kind: 'retry', credits: 0 } };
    const freeRetries = [1, 2, 3].map(() => ({ status: 'failed', payload: { round: 1, kind: 'retry', credits: 0 } }));
    expect(stillAttemptCost({ shot: { still_round: 5 }, jobs: [...freeRetries, failedFree], retry: true, pricing: { stillReroll: 2 } })).toEqual({ credits: 2, kind: 'retry' });
    expect(stillAttemptCost({ shot: { still_round: 5 }, jobs: [freeRetries[0], failedFree], retry: true, pricing: { stillReroll: 2 } })).toEqual({ credits: 0, kind: 'retry' });
  });
});

// ---------------------------------------------------------------- round 2

describe('round 2', () => {
  it('T1: GET shots recovers a claim left by a crash and releases its hold', async () => {
    const ctx = await stilledProject();
    const shot = ctx.shots[0];
    const holdId = randomUUID();
    await holdCredits({ userId: ctx.userId, currency: 'video', amount: 2, projectId: ctx.project.id, holdId });
    await storyDb().update('story_shots', { id: shot.id }, {
      status: 'still_pending', still_round: shot.still_round + 1, still_hold_id: holdId,
      still_claimed_at: new Date().toISOString(), still_prev: { status: 'still_ready', stale: false, error: null },
    });
    await age('story_shots', shot.id, 'still_claimed_at', STALE_CLAIM_MS + 1000);
    const { shots } = await listShots({ userId: ctx.userId, projectId: ctx.project.id });
    expect(shots[0].status).toBe('still_ready');
    expect((await balance(ctx.userId)).held).toBe(0);
  });

  it('T2: rounds only move forward, so a late orphan job of an aborted start never lands', async () => {
    const ctx = await stilledProject();
    const id = ctx.shots[0].id;
    const start = ctx.shots[0].still_round;
    _setStoryboardDeps({ enqueue: async (args) => { await enqueue(args); throw new Error('lost the answer'); } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] })).rejects.toThrow('lost the answer');
    errors.mockRestore();
    _setStoryboardDeps();
    expect((await shotRow(id)).still_round).toBe(start + 1);
    const orphan = (await stillJobs(ctx.project.id)).at(-1);
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] });
    const fresh = (await stillJobs(ctx.project.id)).at(-1);
    expect(fresh.payload.round).toBe(start + 2);
    await finishJobs(ctx.project.id);
    const row = await shotRow(id);
    expect(row.still_key).toContain(fresh.id);
    expect(row.still_key).not.toContain(orphan.id);
    const bal = await balance(ctx.userId);
    expect(bal.held).toBe(0);
    expect(bal.available).toBe(1000 - 2);
  });

  it('T3: a title edit re-plans the scene, keeps verbatim shots and their clips, and asks nothing about clips (T6)', async () => {
    const ctx = await builtProject();
    for (const s of ctx.shots.filter((x) => x.scene_id === 's2')) await storyDb().update('story_shots', { id: s.id }, { clip_url: `/clip/${s.id}.mp4`, status: 'ready', still_url: '/s.png' });
    await updateScene({ userId: ctx.userId, projectId: ctx.project.id, sceneId: 's2', patch: { title: 'The coffee visit' } });
    let view = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    expect(view.filter((s) => s.scene_id === 's2').every((s) => s.stale && s.needs_rebuild)).toBe(true);
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    view = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    const s2 = view.filter((s) => s.scene_id === 's2');
    expect(s2.map((s) => s.id).sort()).toEqual(ctx.shots.filter((x) => x.scene_id === 's2').map((x) => x.id).sort());
    expect(s2.every((s) => s.clip_url && !s.stale && !s.needs_rebuild)).toBe(true);
  });

  it('T3: an edit and its undo (A to B to A) leave nothing stale and nothing to rebuild', async () => {
    const ctx = await builtProject();
    const before = SCENES[1].visual;
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    expect((await shotRows(ctx.project.id)).filter((s) => s.scene_id === 's2').every((s) => s.stale)).toBe(true);
    await editScene(ctx, 's2', before);
    const view = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    expect(view.every((s) => !s.stale && !s.needs_rebuild)).toBe(true);
  });

  it('T3: an edited description on a clipped shot stays stale through a rebuild and does not ask for one', async () => {
    const ctx = await stilledProject();
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { clip_url: '/clip/a.mp4', status: 'ready' });
    await updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id, patch: { description: 'A new angle.' } });
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    const [first] = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    expect(first).toMatchObject({ stale: true, clip_mismatch: true, needs_rebuild: false });
  });

  it('T3: a new scene with no shots yet asks for a rebuild', async () => {
    const ctx = await builtProject();
    await storyDb().insert('story_scripts', { project_id: ctx.project.id, version: 2, scenes: [...SCENES, { id: 's4', title: 'Later', visual: 'The shop at noon.', lines: [] }], source: 'edit' });
    const view = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    expect(view.some((s) => s.needs_rebuild)).toBe(true);
  });

  it('T4: a build that asked the model counts even when it ends blocked', async () => {
    registerMock('story_shots', () => ({ shots: SCENES.map((sc) => ({ sceneId: sc.id, description: 'They have sex in the shop.', line: 'x', seconds: 6, cast: [] })) }));
    const ctx = await newProject();
    await expect(buildShotList({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ code: 'shots_blocked' });
    const usage = await storyDb().select('story_usage', { user_id: ctx.userId });
    expect(usage.filter((u) => u.action.startsWith('shots_build')).reduce((n, u) => n + u.count, 0)).toBe(1);
  });

  it('T5: making pictures for every shot leaves out blocked shots', async () => {
    const ctx = await builtProject();
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { status: 'blocked', error: 'Blocked.' });
    const out = await generateStills({ userId: ctx.userId, projectId: ctx.project.id });
    expect(out.queued).not.toContain(ctx.shots[0].id);
    expect(out.queued).toHaveLength(5);
  });
});
