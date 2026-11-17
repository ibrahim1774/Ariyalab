// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, InsufficientCreditsError } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache, getPricing, generatedSeconds } from '../../lib/pricing.js';
import { speakerOfShot } from '../../lib/story/speakers.js';
import { registerMock } from '../../lib/providers/mock.js';
import { ModerationError } from '../../lib/moderation.js';
import { FORBIDDEN_NAMES, updateScene } from '../../lib/story/script.js';
import { STYLES } from '../../lib/story/prompts/styles.js';
import { storyShotsMock } from '../../lib/story/mocks.js';
import { buildShotsSystem, buildShotsMessage, stillPrompt, SHOTS_SCHEMA, MAX_CAST_REFS, MAX_SHOTS } from '../../lib/story/prompts/shot.js';
import {
  buildShotList, generateStills, updateShot, markStale, listShots, fitSeconds, stillAttemptCost,
  _setStoryboardDeps, FREE_FIRST_TRIES, STALE_CLAIM_MS, PENDING_PLAN_MS, sceneSig, _clearSettledStale,
} from '../../lib/story/storyboard.js';
import { holdCredits } from '../../lib/credits.js';
import { readFileSync } from 'node:fs';
import { enqueue } from '../../lib/story/runner.js';
import { stillHandler } from '../../lib/story/stillJobs.js';
import { tick, _handlerCallScope } from '../../lib/story/runner.js';
import { releaseHold } from '../../lib/credits.js';
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

// ---------------------------------------------------------------- consistent_cast false

describe('consistent_cast false: shots are described and pictured on their own', () => {
  it('asks the model with an empty cast (and says each person is described in full), so no shot has cast ids', async () => {
    const { userId, project } = await newProject();
    await storyDb().update('story_projects', { id: project.id }, { consistent_cast: false });
    let seen = null;
    registerMock('story_shots', (input) => { seen = input; return storyShotsMock(input); });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((s) => (s.cast_ids || []).length === 0)).toBe(true);
    expect(seen.messages[0].content).toMatch(/"cast":\[\]/);
    expect(seen.system).toMatch(/on its own|by itself|stands alone/i);
    expect(seen.system).toMatch(/different people|each person/i);
  });

  it('the default keeps the cast in the shot plan', async () => {
    const { userId, project } = await newProject();
    let seen = null;
    registerMock('story_shots', (input) => { seen = input; return storyShotsMock(input); });
    await buildShotList({ userId, projectId: project.id });
    expect(seen.messages[0].content).toContain('Maya looks friendly.');
    expect(seen.system).not.toMatch(/stands alone/i);
  });

  it('still pictures get no cast sheets or character references (the product photo stays)', async () => {
    const { userId, project, shots } = await builtProject({ product: true });
    await storyDb().update('story_shots', { id: shots.map((s) => s.id) }, { cast_ids: [(await storyDb().select('story_cast', { project_id: project.id }))[0].id] });
    await storyDb().update('story_projects', { id: project.id }, { consistent_cast: false });
    await generateStills({ userId, projectId: project.id });
    const jobs = await stillJobs(project.id);
    expect(jobs.length).toBe(shots.length);
    for (const job of jobs) {
      expect(job.payload.refs).toEqual(['/product/bottle.png']);
      expect(job.payload.prompt).not.toMatch(/Reference picture 1 is Maya/);
    }
  });
});

describe('switching consistent_cast after the storyboard exists (I2): a clean reset of the plan', () => {
  async function falseFromTheStart() {
    const { generateCast } = await import('../../lib/story/cast.js');
    const ctx = await newProject({ cast: [] });
    await storyDb().update('story_projects', { id: ctx.project.id }, { consistent_cast: false, step: 'generate' });
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id });
    await finishJobs(ctx.project.id);
    return { ...ctx, generateCast };
  }

  it('every picture stops being the current one, so Generate cannot make a clip from it, and the step points back at the cast', async () => {
    const { updateProject } = await import('../../lib/story/projects.js');
    const { startGeneration, quoteGeneration } = await import('../../lib/story/shots.js');
    const { userId, project } = await falseFromTheStart();
    expect((await shotRows(project.id)).every((s) => s.still_url)).toBe(true);
    await updateProject({ userId, id: project.id, patch: { consistent_cast: true } });
    const rows = await shotRows(project.id);
    expect(rows.every((s) => !s.still_url && !s.still_key && s.status === 'draft')).toBe(true);
    expect((await storyDb().select('story_projects', { id: project.id }))[0].step).toBe('cast');
    // Nothing can be generated from the old pictures: the plan itself needs rebuilding first.
    await expect(quoteGeneration({ userId, projectId: project.id })).rejects.toMatchObject({ code: 'needs_rebuild' });
    await expect(startGeneration({ userId, projectId: project.id, confirmTotal: 0 })).rejects.toBeDefined();
  });

  it('rebuild and pictures are refused until every character has a pick; then the shots carry the cast and the pictures are remade with references', async () => {
    const { updateProject } = await import('../../lib/story/projects.js');
    const { userId, project, generateCast } = await falseFromTheStart();
    await updateProject({ userId, id: project.id, patch: { consistent_cast: true } });
    const refused = { status: 409, code: 'cast_needed', message: 'Make your characters first.' };
    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject(refused);
    await expect(generateStills({ userId, projectId: project.id })).rejects.toMatchObject(refused);
    // Characters still being drawn do not count either.
    await generateCast({ userId, projectId: project.id });
    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject(refused);
    await finishJobs(project.id); // the pictures finish and the first one of each is picked automatically
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.some((sh) => (sh.cast_ids || []).length > 0)).toBe(true);
    expect(shots.every((sh) => !sh.needs_rebuild)).toBe(true);
    await generateStills({ userId, projectId: project.id });
    const jobs = await stillJobs(project.id);
    const fresh = jobs.filter((j) => j.payload.refs?.length);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((j) => j.payload.refs.every((r) => !r.includes('old')))).toBe(true);
  });

  it('switching to false needs no cast and clears the pictures too', async () => {
    const { updateProject } = await import('../../lib/story/projects.js');
    const { userId, project } = await newProject();
    await buildShotList({ userId, projectId: project.id });
    await generateStills({ userId, projectId: project.id });
    await finishJobs(project.id);
    await updateProject({ userId, id: project.id, patch: { consistent_cast: false } });
    expect((await shotRows(project.id)).every((s) => !s.still_url)).toBe(true);
    await buildShotList({ userId, projectId: project.id });
  });

  it('is refused while a picture or a clip is being made', async () => {
    const { updateProject } = await import('../../lib/story/projects.js');
    const { userId, project } = await newProject();
    await buildShotList({ userId, projectId: project.id });
    await generateStills({ userId, projectId: project.id });
    await expect(updateProject({ userId, id: project.id, patch: { consistent_cast: false } })).rejects.toMatchObject({ status: 409 });
    expect((await storyDb().select('story_projects', { id: project.id }))[0].consistent_cast).toBe(true);
  });

  it('a picture that is remade on a shot with no clip is no longer flagged out of date', async () => {
    const { userId, project, shots } = await stilledProject();
    await storyDb().update('story_shots', { id: shots[0].id }, { stale: true, clip_mismatch: true, still_url: null, still_key: null, status: 'draft' });
    await generateStills({ userId, projectId: project.id, shotIds: [shots[0].id] });
    await finishJobs(project.id);
    const row = await shotRow(shots[0].id);
    expect([row.stale, row.clip_mismatch]).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------- 7 and 120 seconds

describe('shot planning at 7 and 120 seconds', () => {
  const oneScene = [{ id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at dawn.', lines: [{ speaker: 'Maya', text: 'Nobody believed one small chair could change my whole year.' }] }];
  const manyScenes = Array.from({ length: 16 }, (_, i) => ({
    id: `m${i + 1}`, title: `Moment ${i + 1}`, visual: `Maya and Leo in the shop, moment ${i + 1}.`,
    lines: [{ speaker: 'Maya', text: `Line number ${i + 1} of the long story.` }],
  }));
  const sumOf = (shots) => shots.reduce((n, s) => n + s.seconds, 0);

  it('plans valid shots for a 7 second video: one scene, whole 3 to 6 second shots adding up to 7', async () => {
    const { userId, project } = await newProject({ scenes: oneScene, seconds: 7 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.length).toBeGreaterThanOrEqual(2);
    expect(sumOf(shots)).toBe(7);
    expect(shots.every((s) => s.seconds >= 3 && s.seconds <= 6 && s.scene_id === 's1')).toBe(true);
  });

  it('plans valid shots for a 120 second video of many scenes', async () => {
    const { userId, project } = await newProject({ scenes: manyScenes, seconds: 120 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.length).toBeGreaterThanOrEqual(18);
    expect(sumOf(shots)).toBeGreaterThanOrEqual(108);
    expect(sumOf(shots)).toBeLessThanOrEqual(132);
    expect(shots.every((s) => s.seconds >= 3 && s.seconds <= 6)).toBe(true);
  });

  it('keeps all 40 shots of a 120 second video made of 3 second shots (no cap at 30)', async () => {
    registerMock('story_shots', () => ({
      shots: Array.from({ length: 40 }, (_, i) => ({ sceneId: manyScenes[i % 16].id, description: `Shot ${i + 1} of the long story.`, line: '', seconds: 3, cast: [] })),
    }));
    const { userId, project } = await newProject({ scenes: manyScenes, seconds: 120 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots).toHaveLength(40);
    expect(sumOf(shots)).toBe(120);
  });

  it('gives the shot plan enough output tokens for 40 shots (the budget grows with the shot count)', async () => {
    let asked = null;
    registerMock('story_shots', (input) => {
      asked = input.maxTokens;
      return { shots: Array.from({ length: 40 }, (_, i) => ({ sceneId: manyScenes[i % 16].id, description: `Shot ${i + 1} of the long story.`, line: '', seconds: 3, cast: [] })) };
    });
    const { userId, project } = await newProject({ scenes: manyScenes, seconds: 120 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots).toHaveLength(40);
    expect(asked).toBeGreaterThanOrEqual(12000);
  });

  it('asks for about 40 shots at 120 seconds and 3 to 6 seconds each at 7', () => {
    expect(buildShotsSystem({ seconds: 120 })).toMatch(/between 108 and 132/);
    expect(buildShotsSystem({ seconds: 7 })).toMatch(/between 7 and 7/);
    expect(MAX_SHOTS).toBeGreaterThanOrEqual(40);
  });

  it('an economy 7 second video is priced at the 4 second minimum for each shot', async () => {
    const { userId, project } = await newProject({ scenes: oneScene, seconds: 7 });
    await storyDb().update('story_projects', { id: project.id }, { quality: 'economy' });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    const pricing = await getPricing();
    for (const shot of shots) expect(generatedSeconds(pricing, 'economy', shot.seconds)).toBe(4);
  });
});

// ---------------------------------------------------------------- speakers in a talking video

describe('buildShotList: who says each line (talking video)', () => {
  const TALK = [
    { id: 's1', title: 'Open', visual: 'Maya sweeps the shop.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }, { speaker: 'Maya', text: 'Watch me prove them wrong.' }] },
    { id: 's2', title: 'Close', visual: 'Leo walks in.', lines: [{ speaker: 'Leo', text: 'I will take the first chair.' }, { speaker: 'narrator', text: 'And that was the start.' }] },
  ];
  const talking = (opts = {}) => newProject({ scenes: TALK, seconds: 12, ...opts }).then(async (ctx) => {
    await storyDb().update('story_projects', { id: ctx.project.id }, { mode: 'talking' });
    return ctx;
  });

  it('plans a talking video: narrator and character lines stay on their shots in order', async () => {
    const { userId, project } = await talking();
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.map((s) => s.line).filter(Boolean)).toEqual(TALK.flatMap((s) => s.lines.map((l) => l.text)));
  });

  it('refuses a plan with a character line that is no line of its scene (the speaker cannot be told), asking the model once more', async () => {
    let calls = 0;
    registerMock('story_shots', (input) => {
      calls += 1;
      const out = storyShotsMock(input);
      return { shots: out.shots.map((s) => (s.line === 'Watch me prove them wrong.' ? { ...s, line: 'Something Maya never says.' } : s)) };
    });
    const { userId, project } = await talking();
    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject({ status: 422, code: 'speaker_unresolved' });
    expect(calls).toBe(2);
    expect(await shotRows(project.id)).toHaveLength(0);
    registerMock('story_shots', storyShotsMock);
  });

  it('a speaker named in the script but not in the cast is not an error: the plan is made and the shot says they have no picture', async () => {
    const { userId, project } = await talking({ cast: ['Maya'] });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    const leo = shots.find((sh) => sh.line === 'I will take the first chair.');
    expect(leo.warnings).toEqual([{ code: 'speaker_not_in_cast', message: 'Leo has no character picture, so their look and voice may change.' }]);
    expect(shots.find((sh) => sh.line === 'Watch me prove them wrong.').warnings).toEqual([]);
    expect(shots.find((sh) => sh.line === 'Nobody believed this would work.').warnings).toEqual([]);
    expect((await listShots({ userId, projectId: project.id })).shots.find((sh) => sh.id === leo.id).warnings).toHaveLength(1);
  });

  it('stores the index of each shot\'s line within its scene (null for a shot with no line)', async () => {
    const { userId, project } = await talking();
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.filter((sh) => sh.line).map((sh) => [sh.scene_id, sh.line_index])).toEqual([['s1', 0], ['s1', 1], ['s2', 0], ['s2', 1]]);
    expect(shots.filter((sh) => !sh.line).every((sh) => sh.line_index === null)).toBe(true);
  });

  it('Ana says "No." and then Ben says "No.": Ben\'s shot names Ben', async () => {
    const scenes = [{ id: 's1', title: 'T', visual: 'Two friends.', lines: [{ speaker: 'Ana', text: 'No.' }, { speaker: 'Ben', text: 'No.' }] }];
    const { userId, project } = await talking({ scenes, cast: ['Ana', 'Ben'], seconds: 7 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    const withLine = shots.filter((sh) => sh.line);
    expect(withLine.map((sh) => sh.line_index)).toEqual([0, 1]);
    expect(withLine.map((sh) => speakerOfShot(scenes, sh, shots).name)).toEqual(['Ana', 'Ben']);
  });

  it('a curly apostrophe or a dropped full stop in the shot\'s line still resolves', async () => {
    const scenes = [{ id: 's1', title: 'T', visual: 'A friend.', lines: [{ speaker: 'Ben', text: "I'm here." }] }];
    let calls = 0;
    registerMock('story_shots', (input) => {
      calls += 1;
      const out = storyShotsMock(input);
      return { shots: out.shots.map((sh) => (sh.line ? { ...sh, line: 'I’m here' } : sh)) };
    });
    const { userId, project } = await talking({ scenes, cast: ['Ben'], seconds: 7 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(calls).toBe(1);
    expect(shots.find((sh) => sh.line)).toMatchObject({ line: 'I’m here', line_index: 0 });
    registerMock('story_shots', storyShotsMock);
  });

  it('two speakers merged into one shot are planned again, never given to the first speaker', async () => {
    const scenes = [{ id: 's1', title: 'T', visual: 'Two friends.', lines: [{ speaker: 'Ana', text: 'No.' }, { speaker: 'Ben', text: 'Wait for me.' }] }];
    let calls = 0;
    registerMock('story_shots', (input) => {
      calls += 1;
      const out = storyShotsMock(input);
      if (calls > 1) return out;
      const [first, ...rest] = out.shots;
      return { shots: [{ ...first, line: 'No. Wait for me.', lineIndex: 0 }, ...rest.map((sh) => ({ ...sh, line: '', lineIndex: undefined }))] };
    });
    const { userId, project } = await talking({ scenes, cast: ['Ana', 'Ben'], seconds: 7 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(calls).toBe(2);
    expect(shots.filter((sh) => sh.line).map((sh) => sh.line)).toEqual(['No.', 'Wait for me.']);
    registerMock('story_shots', storyShotsMock);
  });

  it('every narrator line of a talking script gets a shot: a plan that leaves one out is planned again once', async () => {
    let calls = 0;
    registerMock('story_shots', (input) => {
      calls += 1;
      const out = storyShotsMock(input);
      return calls === 1 ? { shots: out.shots.map((sh) => (sh.line === 'And that was the start.' ? { ...sh, line: '', lineIndex: undefined } : sh)) } : out;
    });
    const { userId, project } = await talking();
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(calls).toBe(2);
    expect(shots.some((sh) => sh.line === 'And that was the start.')).toBe(true);
    registerMock('story_shots', storyShotsMock);
  });

  it('a narrator line may be followed by shots with nothing said (the narrator plays over them)', async () => {
    const { buildShotsSystem } = await import('../../lib/story/prompts/shot.js');
    expect(buildShotsSystem({ seconds: 12 })).toMatch(/narrator line may be followed by shots with nothing said/);
  });

  it('a line index that cannot be checked after the one new plan is refused, with the way out that both makers have', async () => {
    registerMock('story_shots', (input) => {
      const out = storyShotsMock(input);
      return { shots: out.shots.map((sh) => (sh.line ? { ...sh, lineIndex: 9 } : sh)) };
    });
    const { userId, project } = await talking();
    await expect(buildShotList({ userId, projectId: project.id })).rejects.toMatchObject({
      status: 422, code: 'speaker_unresolved', message: expect.stringContaining('Ask the chat to fix who says this line.'),
    });
    expect(await shotRows(project.id)).toHaveLength(0);
    registerMock('story_shots', storyShotsMock);
  });

  it('a narrated video does not check speakers (character lines are never spoken there)', async () => {
    registerMock('story_shots', (input) => {
      const out = storyShotsMock(input);
      return { shots: out.shots.map((s) => (s.line ? { ...s, line: 'Reworded line.' } : s)) };
    });
    const { userId, project } = await newProject({ scenes: TALK, seconds: 12 });
    const { shots } = await buildShotList({ userId, projectId: project.id });
    expect(shots.length).toBeGreaterThan(0);
    registerMock('story_shots', storyShotsMock);
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

    const ask = await buildShotList({ userId, projectId: project.id }).catch((e) => e);
    expect(ask).toMatchObject({ status: 409, code: 'rebuild_loses_clips', extra: { count: 2 } });
    await buildShotList({ userId, projectId: project.id, confirm: ask.extra.token });
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
    // The whole script goes, the scene to plan is marked, and its neighbours come with their setting and shots.
    expect(brief.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(brief.scenes.map((s) => s.changed)).toEqual([false, true, false]);
    expect(brief.scenes[0].setting).toBeTruthy();
    expect(brief.scenes[0].shots.length).toBeGreaterThan(0);
    expect(brief.scenes[2].shots.length).toBeGreaterThan(0);
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
      p_project: ctx.project.id, p_shots: [{ sceneId: 's1', description: 'x', line: null, seconds: 3, quality: 'standard', castIds: [] }], p_confirm: 0, p_min: 16, p_max: 19,
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

// ---------------------------------------------------------------- round 3

describe('round 3', () => {
  /** A built project whose scene s2 shots have clips, with s2 edited so a rebuild would drop them. */
  async function clipLosing() {
    const ctx = await builtProject();
    for (const s of ctx.shots.filter((x) => x.scene_id === 's2')) await storyDb().update('story_shots', { id: s.id }, { clip_url: `/clip/${s.id}.mp4`, status: 'ready', still_url: '/s.png' });
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    const asked = [];
    registerMock('story_shots', (args) => { asked.push(args); return storyShotsMock(args); });
    const builds = async () => (await storyDb().select('story_usage', { user_id: ctx.userId })).filter((u) => u.action.startsWith('shots_build')).reduce((n, u) => n + u.count, 0);
    return { ...ctx, asked, builds };
  }

  it('U1: the 409 stores the plan and returns a token; confirming with it applies exactly that plan, with no model call and no count', async () => {
    const ctx = await clipLosing();
    const ask = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id }).catch((e) => e);
    expect(ask).toMatchObject({ status: 409, code: 'rebuild_loses_clips', extra: { count: 2 } });
    expect(typeof ask.extra.token).toBe('string');
    expect(ctx.asked).toHaveLength(1);
    const counted = await ctx.builds();
    const [pending] = await storyDb().select('story_projects', { id: ctx.project.id });
    expect(pending.pending_shots.token).toBe(ask.extra.token);
    expect(pending.pending_basis).toBeTruthy();
    expect(pending.pending_at).toBeTruthy();

    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id, confirm: ask.extra.token });
    expect(ctx.asked).toHaveLength(1);
    expect(await ctx.builds()).toBe(counted);
    const after = await shotRows(ctx.project.id);
    const planned = pending.pending_shots.plan.filter((x) => !x.id).map((x) => x.description);
    expect(after.filter((s) => s.scene_id === 's2').map((s) => s.description)).toEqual(planned);
    const [cleared] = await storyDb().select('story_projects', { id: ctx.project.id });
    expect(cleared.pending_shots).toBeNull();
    expect(cleared.pending_basis).toBeNull();
  });

  it('U1: a wrong, old or reused token, or confirm: true, never proceeds: it builds afresh and asks again', async () => {
    const ctx = await clipLosing();
    const ask = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id }).catch((e) => e);
    for (const confirm of ['not-the-token', true]) {
      const again = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id, confirm }).catch((e) => e);
      expect(again).toMatchObject({ status: 409, code: 'rebuild_loses_clips' });
    }
    expect(ctx.asked).toHaveLength(3);
    // expired
    const fresh = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id }).catch((e) => e);
    await raw.query(`update public.story_projects set pending_at = now() - ($2 || ' milliseconds')::interval where id = $1`, [ctx.project.id, String(PENDING_PLAN_MS + 1000)]);
    const expired = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id, confirm: fresh.extra.token }).catch((e) => e);
    expect(expired).toMatchObject({ status: 409, code: 'rebuild_loses_clips' });
    expect(expired.extra.token).not.toBe(fresh.extra.token);
    expect((await shotRows(ctx.project.id)).filter((s) => s.clip_url)).toHaveLength(2);
    void ask;
  });

  it('U1: a token whose basis changed (a shot was edited meanwhile) builds afresh and asks again', async () => {
    const ctx = await clipLosing();
    const ask = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id }).catch((e) => e);
    await updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id, patch: { description: 'Changed meanwhile.' } });
    const again = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id, confirm: ask.extra.token }).catch((e) => e);
    expect(again).toMatchObject({ status: 409, code: 'rebuild_loses_clips' });
    expect(ctx.asked).toHaveLength(2);
  });

  it('U1: the SQL backstop refuses to delete more clips than were agreed', async () => {
    const ctx = await builtProject();
    for (const s of ctx.shots.filter((x) => x.scene_id === 's2')) await storyDb().update('story_shots', { id: s.id }, { clip_url: `/clip/${s.id}.mp4` });
    const keep = ctx.shots.filter((x) => x.scene_id !== 's2').map((x) => ({ id: x.id }));
    await expect(storyDb().rpc('story_shots_replace', { p_project: ctx.project.id, p_shots: keep, p_confirm: 1, p_min: null, p_max: null })).rejects.toThrow(/rebuild_loses_clips:2/);
    await expect(storyDb().rpc('story_shots_replace', { p_project: ctx.project.id, p_shots: keep, p_confirm: 2, p_min: null, p_max: null })).resolves.toHaveLength(4);
  });

  it('U2: clearing settled stale only touches rows planned from the signature the build used', async () => {
    const ctx = await builtProject();
    const [a, b] = ctx.shots;
    await storyDb().update('story_shots', { id: a.id }, { stale: true });
    await storyDb().update('story_shots', { id: b.id }, { stale: true, scene_sig: 'changed-meanwhile' });
    await _clearSettledStale(ctx.project.id);
    expect((await shotRow(a.id)).stale).toBe(false);
    expect((await shotRow(b.id)).stale).toBe(true);
  });

  it('U3: a re-roll that fails on a clipped shot leaves it not stale; one that lands marks the clip mismatched', async () => {
    const ctx = await stilledProject();
    const [x, y] = ctx.shots;
    for (const s of [x, y]) await storyDb().update('story_shots', { id: s.id }, { clip_url: `/clip/${s.id}.mp4`, status: 'ready' });
    await makeNextStillFail(x.id);
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [x.id, y.id] });
    await finishJobs(ctx.project.id);
    expect(await shotRow(x.id)).toMatchObject({ status: 'failed', stale: false, clip_mismatch: false });
    expect(await shotRow(y.id)).toMatchObject({ status: 'still_ready', stale: true, clip_mismatch: true });
  });

  it('U4: a stalled claim whose hold is already closed is put back', async () => {
    const ctx = await stilledProject();
    const shot = ctx.shots[0];
    const holdId = randomUUID();
    await holdCredits({ userId: ctx.userId, currency: 'video', amount: 2, projectId: ctx.project.id, holdId });
    await releaseHold({ holdId });
    await storyDb().update('story_shots', { id: shot.id }, {
      status: 'still_pending', still_round: shot.still_round + 1, still_hold_id: holdId,
      still_claimed_at: new Date().toISOString(), still_prev: { status: 'still_ready', stale: false, error: null },
    });
    await age('story_shots', shot.id, 'still_claimed_at', STALE_CLAIM_MS + 1000);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await listShots({ userId: ctx.userId, projectId: ctx.project.id });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect((await shotRow(shot.id)).status).toBe('still_ready');
  });

  it('U5: the model sees which scene carries the mention', () => {
    const msg = buildShotsMessage({ scenes: [{ ...SCENES[0], mention: true }, SCENES[1]], seconds: 12, cast: [], current: [] });
    const brief = JSON.parse(/<shot_brief>\n([\s\S]*?)\n<\/shot_brief>/.exec(msg)[1]);
    expect(brief.scenes.map((s) => s.mention)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------- round 4

describe('round 4', () => {
  it('X1: a scene edited while the build asks the model stays stale after the build (real updateScene and markStale)', async () => {
    const ctx = await builtProject();
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    registerMock('story_shots', async (args) => {
      // The customer edits scene s1 while the model is planning s2.
      await updateScene({ userId: ctx.userId, projectId: ctx.project.id, sceneId: 's1', patch: { visual: 'Maya counts the till at midnight.' } });
      return storyShotsMock(args);
    });
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    const rows = await shotRows(ctx.project.id);
    const s1 = rows.filter((r) => r.scene_id === 's1');
    expect(s1).toHaveLength(2);
    expect(s1.every((r) => r.stale)).toBe(true);
    const view = (await listShots({ userId: ctx.userId, projectId: ctx.project.id })).shots;
    expect(view.filter((r) => r.scene_id === 's1').every((r) => r.needs_rebuild)).toBe(true);
  });

  async function asked409() {
    const ctx = await builtProject();
    for (const s of ctx.shots.filter((x) => x.scene_id === 's2')) await storyDb().update('story_shots', { id: s.id }, { clip_url: `/clip/${s.id}.mp4`, still_url: '/s.png' });
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    const asked = [];
    registerMock('story_shots', (args) => { asked.push(args); return storyShotsMock(args); });
    const ask = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id }).catch((e) => e);
    expect(ask.code).toBe('rebuild_loses_clips');
    return { ...ctx, asked, token: ask.extra.token };
  }

  it('X2: a status change alone does not void the confirm', async () => {
    const ctx = await asked409();
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { status: 'still_ready', still_url: '/x.png' });
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id, confirm: ctx.token });
    expect(ctx.asked).toHaveLength(1);
  });

  it('X2: a new length or a changed cast voids the confirm', async () => {
    const a = await asked409();
    await storyDb().update('story_projects', { id: a.project.id }, { seconds: 24 });
    expect(await buildShotList({ userId: a.userId, projectId: a.project.id, confirm: a.token }).catch((e) => e)).toMatchObject({ code: 'rebuild_loses_clips' });
    expect(a.asked).toHaveLength(2);
    const b = await asked409();
    await storyDb().insert('story_cast', { project_id: b.project.id, ord: 9, name: 'Ana', description: 'Ana looks friendly.', status: 'ready' });
    expect(await buildShotList({ userId: b.userId, projectId: b.project.id, confirm: b.token }).catch((e) => e)).toMatchObject({ code: 'rebuild_loses_clips' });
    expect(b.asked).toHaveLength(2);
  });
});

describe('story flow: scene settings and neighbouring shots', () => {
  const settingsOf = async (projectId) => {
    const out = {};
    for (const r of await shotRows(projectId)) (out[r.scene_id] ||= new Set()).add(r.setting);
    return out;
  };

  it('the planner gives every scene a setting, stored on every shot of the scene', async () => {
    const ctx = await builtProject();
    const by = await settingsOf(ctx.project.id);
    for (const id of ['s1', 's2', 's3']) {
      expect(by[id].size).toBe(1);
      expect([...by[id]][0]).toBeTruthy();
    }
  });

  it('a re-plan sends the whole script and neighbours, keeps unchanged scenes untouched and their settings', async () => {
    const ctx = await builtProject();
    const before = await settingsOf(ctx.project.id);
    const asked = [];
    registerMock('story_shots', (args) => { asked.push(args); return storyShotsMock(args); });
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    const brief = JSON.parse(/<shot_brief>\n([\s\S]*?)\n<\/shot_brief>/.exec(asked[0].messages[0].content)[1]);
    expect(brief.scenes).toHaveLength(3);
    expect(brief.scenes[1]).toMatchObject({ id: 's2', changed: true });
    expect(brief.scenes[0].shots).toEqual(ctx.shots.filter((s) => s.scene_id === 's1').map((s) => s.description));
    expect(brief.scenes[2].setting).toBe([...before.s3][0]);
    const after = await settingsOf(ctx.project.id);
    expect([...after.s1]).toEqual([...before.s1]);
    expect([...after.s3]).toEqual([...before.s3]);
    for (const old of ctx.shots.filter((s) => s.scene_id !== 's2')) expect(await shotRow(old.id)).toMatchObject({ description: old.description, setting: old.setting });
    // The changed scene's old setting is shown to the planner, and kept when the model gives none.
    expect(brief.scenes[1].setting).toBe([...before.s2][0]);
  });

  it('when the planner gives no setting for a changed scene, the scene keeps the one it had', async () => {
    const ctx = await builtProject();
    const before = await settingsOf(ctx.project.id);
    registerMock('story_shots', (args) => ({ shots: storyShotsMock(args).shots }));
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect([...(await settingsOf(ctx.project.id)).s2]).toEqual([...before.s2]);
  });

  it('an old project (no setting stored) still builds stills and re-plans', async () => {
    const ctx = await builtProject();
    await storyDb().update('story_shots', { project_id: ctx.project.id }, { setting: null });
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id });
    const jobs = await stillJobs(ctx.project.id);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.payload.prompt).not.toContain('Setting:');
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    registerMock('story_shots', (args) => ({ shots: storyShotsMock(args).shots }));
    await finishJobs(ctx.project.id);
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect((await shotRows(ctx.project.id)).length).toBeGreaterThan(0);
  });

  it('every still prompt carries its scene setting, the look of its people and the shot before it; the first has no previous line', async () => {
    const ctx = await builtProject();
    await generateStills({ userId: ctx.userId, projectId: ctx.project.id });
    const jobs = await stillJobs(ctx.project.id);
    const byShot = new Map(jobs.map((j) => [j.shot_id, j.payload.prompt]));
    const shots = await shotRows(ctx.project.id);
    shots.forEach((s, i) => {
      const prompt = byShot.get(s.id);
      expect(prompt).toContain(`Setting: ${s.setting.replace(/\.$/, '')}`);
      if (i === 0) expect(prompt).not.toContain('Just before this');
      else expect(prompt).toContain(`Just before this: ${shots[i - 1].description.replace(/\.$/, '')}`);
      for (const id of s.cast_ids) expect(prompt).toContain('Look, ');
    });
  });

  it('the setting can be changed through the shot update path, for the whole scene, without touching the pictures', async () => {
    const ctx = await stilledProject();
    const s2 = ctx.shots.filter((s) => s.scene_id === 's2');
    const { shot } = await updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: s2[0].id, patch: { setting: 'A rainy street at dusk. Leo wears a yellow coat.' } });
    expect(shot.setting).toBe('A rainy street at dusk. Leo wears a yellow coat.');
    const after = await shotRows(ctx.project.id);
    expect(after.filter((s) => s.scene_id === 's2').every((s) => s.setting === shot.setting && s.status === 'still_ready' && s.still_url)).toBe(true);
    expect(after.filter((s) => s.scene_id !== 's2').every((s) => s.setting !== shot.setting)).toBe(true);
    await expect(updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: s2[0].id, patch: { setting: 'x'.repeat(401) } })).rejects.toMatchObject({ field: 'setting' });
  });

  it('story_shots_replace writes the setting of fresh and matched rows, and keeps it when none is sent', async () => {
    const ctx = await builtProject();
    const keep = ctx.shots.filter((x) => x.scene_id !== 's2').map((x) => ({ id: x.id }));
    const s2 = ctx.shots.filter((x) => x.scene_id === 's2');
    const plan = [
      ...keep.slice(0, 2),
      { sceneId: 's2', sceneSig: s2[0].scene_sig, description: s2[0].description, line: s2[0].line, lineIndex: s2[0].line_index, seconds: s2[0].seconds, quality: 'standard', castIds: [], setting: 'Matched row setting.' },
      { sceneId: 's2', sceneSig: s2[0].scene_sig, description: 'A brand new shot.', line: null, lineIndex: null, seconds: 3, quality: 'standard', castIds: [], setting: 'Fresh row setting.' },
      ...keep.slice(2),
    ];
    const rows = await storyDb().rpc('story_shots_replace', { p_project: ctx.project.id, p_shots: plan, p_confirm: 0, p_min: null, p_max: null });
    const mine = rows.filter((r) => r.scene_id === 's2');
    expect(mine.map((r) => r.setting)).toEqual(['Matched row setting.', 'Fresh row setting.']);
    expect(mine[0].line_index).toBe(s2[0].line_index);
    // Old callers (no setting key) leave settings as they are.
    const again = await storyDb().rpc('story_shots_replace', { p_project: ctx.project.id, p_shots: rows.map((r) => ({ id: r.id })), p_confirm: 0, p_min: null, p_max: null });
    expect(again.map((r) => r.setting)).toEqual(rows.map((r) => r.setting));
  });

  it('a rebuild confirmed after a 409 stores the planned settings', async () => {
    const ctx = await builtProject();
    for (const s of ctx.shots.filter((x) => x.scene_id === 's2')) await storyDb().update('story_shots', { id: s.id }, { clip_url: `/clip/${s.id}.mp4`, status: 'ready', still_url: '/s.png' });
    await editScene(ctx, 's2', 'Leo walks in soaked from the rain.');
    registerMock('story_shots', (args) => { const r = storyShotsMock(args); return { ...r, settings: r.settings.map((x) => ({ ...x, setting: 'Planned and confirmed setting.' })) }; });
    const ask = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id }).catch((e) => e);
    expect(ask).toMatchObject({ code: 'rebuild_loses_clips' });
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id, confirm: ask.extra.token });
    const after = await shotRows(ctx.project.id);
    expect(after.filter((s) => s.scene_id === 's2').every((s) => s.setting === 'Planned and confirmed setting.')).toBe(true);
  });

  it('scenes whose shots have no setting get one on the next build, without touching their shots, stills or clips', async () => {
    const ctx = await stilledProject();
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { clip_url: '/clip/x.mp4' });
    await storyDb().update('story_shots', { project_id: ctx.project.id }, { setting: null });
    const before = await shotRows(ctx.project.id);
    const { shots } = await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    expect(shots.every((s) => s.setting)).toBe(true);
    const after = await shotRows(ctx.project.id);
    for (const [i, b] of before.entries()) expect(after[i]).toMatchObject({ id: b.id, description: b.description, still_url: b.still_url, clip_url: b.clip_url, status: b.status, still_round: b.still_round, stale: b.stale });
    // Each scene has one setting; a scene that has one is left alone.
    await storyDb().update('story_shots', { id: after[0].id }, { setting: 'Mine.' });
    await storyDb().update('story_shots', { scene_id: 's3', project_id: ctx.project.id }, { setting: null });
    await buildShotList({ userId: ctx.userId, projectId: ctx.project.id });
    const last = await shotRows(ctx.project.id);
    expect(last[0].setting).toBe('Mine.');
    expect(last.filter((s) => s.scene_id === 's3').every((s) => s.setting)).toBe(true);
  });

  it('a patch with a bad key saves nothing, not even the setting', async () => {
    const ctx = await stilledProject();
    await expect(updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id, patch: { setting: 'Changed.', quality: 'bogus' } })).rejects.toMatchObject({ field: 'quality' });
    await expect(updateShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id, patch: { setting: 'Changed.', description: '' } })).rejects.toMatchObject({ field: 'description' });
    expect((await shotRow(ctx.shots[0].id)).setting).toBe(ctx.shots[0].setting);
  });

  it('the newest replace function still has every line of the line-index version', () => {
    const dir = 'supabase/migrations/';
    const sql = readFileSync(`${dir}20261117000400_story_shots_replace_setting.sql`, 'utf8');
    for (const part of ['line_index = case when kept_li[k] is null then line_index else kept_li[k] end', "raise exception 'shots_busy'", "raise exception 'rebuild_loses_clips:%'", 'fresh_free[k]', "(fresh[k] ->> 'lineIndex')::integer"]) expect(sql).toContain(part);
  });
});
