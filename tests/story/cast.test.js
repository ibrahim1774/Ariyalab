// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, InsufficientCreditsError } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache, getPricing } from '../../lib/pricing.js';
import { registerMock } from '../../lib/providers/mock.js';
import { ModerationError } from '../../lib/moderation.js';
import { sendError } from '../../lib/story/errors.js';
import { getAction, getActionMethods } from '../../lib/story/actions.js';
import { FORBIDDEN_NAMES } from '../../lib/story/script.js';
import { STYLES } from '../../lib/story/prompts/styles.js';
import { storyCastMock } from '../../lib/story/mocks.js';
import {
  buildCastSystem, buildCastMessage, candidatePrompt, sheetPrompt, CAST_SCHEMA,
} from '../../lib/story/prompts/cast.js';
import { generateCast, regenerateCharacter, pickCast, CAST_MAX } from '../../lib/story/cast.js';
import { castImageHandler } from '../../lib/story/castJobs.js';
import { tick, enqueue } from '../../lib/story/runner.js';
import { castView } from '../../lib/story/cast.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__castTestSession ?? null),
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
afterEach(() => {
  registerMock('story_cast', storyCastMock);
  globalThis.__castTestSession = null;
});

// ---------------------------------------------------------------- fixtures

const SCENES = [
  { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'Maya', text: 'Nobody believed this would work.' }] },
  { id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees.', lines: [{ speaker: 'Leo', text: 'Move over, I brought coffee.' }] },
];

async function newProject({ scenes = SCENES, funds = 1000, style = '3d_family' } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Cast test', style, step: 'script' });
  if (scenes) await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes, source: 'brief' });
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}

const castRows = (projectId) => storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' });
const castRow = async (id) => (await storyDb().select('story_cast', { id }))[0];
const jobsOf = async (projectId) => (await storyDb().select('story_jobs', { project_id: projectId, kind: 'cast_image' }, { order: ['created_at', 'id'] }));
const available = async (userId) => (await getBalance(userId)).available;
const feeEntries = async (userId) => (await raw.query(`select * from credit_ledger where user_id = $1 and op = 'spend'`, [userId])).rows;
const forgetSheets = (projectId) => raw.query(`update story_jobs set result = null where project_id = $1 and kind = 'cast_image' and payload->>'stage' = 'sheet'`, [projectId]);
const projectRow = async (id) => (await storyDb().select('story_projects', { id }))[0];

const T0 = Date.parse('2026-11-14T12:00:00.000Z');
let clock = T0;
/** Runs this project's jobs to the end with the mock provider (submit, pending, done). */
async function finishJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 6; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}

async function readyCast() {
  const ctx = await newProject();
  await generateCast({ userId: ctx.userId, projectId: ctx.project.id });
  await finishJobs(ctx.project.id);
  return { ...ctx, cast: await castRows(ctx.project.id) };
}

// ---------------------------------------------------------------- prompts

describe('cast prompts', () => {
  const all = () => [
    buildCastSystem({ mode: 'narrated' }),
    buildCastSystem({ mode: 'talking' }),
    buildCastMessage({ scenes: SCENES, brief: { purpose: 'story' } }),
    ...Object.keys(STYLES).flatMap((key) => [
      candidatePrompt({ style: STYLES[key].promptFragment, name: 'Maya', description: 'A young barber.', slot: 0 }),
      sheetPrompt({ style: STYLES[key].promptFragment, name: 'Maya', description: 'A young barber.' }),
    ]),
  ];

  it('never names a studio, a famous character or a person', () => {
    const text = all().join('\n').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    for (const name of FORBIDDEN_NAMES) expect(text, name).not.toContain(` ${name.replace(/[^a-z0-9]+/g, ' ')} `);
  });

  it('asks for at most five characters and a voice note, and describes the schema', () => {
    expect(buildCastSystem({ mode: 'talking' })).toMatch(/at most 5/i);
    expect(CAST_SCHEMA.properties.characters.items.required).toEqual(['name', 'description', 'voiceNote']);
  });

  it('keeps the candidate options different from each other and each prompt free of text overlays', () => {
    const a = candidatePrompt({ style: 'x', name: 'Maya', description: 'd', slot: 0 });
    const b = candidatePrompt({ style: 'x', name: 'Maya', description: 'd', slot: 1 });
    expect(a).not.toEqual(b);
    expect(a).toMatch(/no text/i);
  });

  it('puts the customer note in the prompt', () => {
    expect(candidatePrompt({ style: 'x', name: 'Maya', description: 'd', slot: 0, note: 'older with round glasses' })).toContain('older with round glasses');
  });
});

// ---------------------------------------------------------------- generateCast

describe('generateCast', () => {
  it('writes the characters from the script, 3 picture jobs each, and moves to the cast step', async () => {
    const { userId, project } = await newProject();
    const { cast } = await generateCast({ userId, projectId: project.id });
    expect(cast.map((c) => c.name)).toEqual(['Maya', 'Leo']);
    const rows = await castRows(project.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.description && r.voice_note && r.status === 'pending' && r.round === 1)).toBe(true);
    const jobs = await jobsOf(project.id);
    expect(jobs).toHaveLength(6);
    for (const row of rows) {
      const mine = jobs.filter((j) => j.payload.castId === row.id);
      expect(mine.map((j) => j.payload.slot).sort()).toEqual([0, 1, 2]);
      expect(mine.every((j) => j.payload.stage === 'candidate' && j.payload.round === 1 && j.status === 'queued')).toBe(true);
      expect(mine.every((j) => j.hold_id === null && j.cost_credits === null)).toBe(true);
    }
    expect((await projectRow(project.id)).step).toBe('cast');
  });

  it('charges the project fee once, with the project-fee ref, even when called again', async () => {
    const { userId, project } = await newProject();
    const fee = (await getPricing()).projectFee;
    const before = await available(userId);
    // Two at once (a double click), then two more one after the other.
    const racing = await Promise.allSettled([generateCast({ userId, projectId: project.id }), generateCast({ userId, projectId: project.id })]);
    expect(racing.some((r) => r.status === 'fulfilled')).toBe(true);
    await generateCast({ userId, projectId: project.id });
    await generateCast({ userId, projectId: project.id });
    expect(before - (await available(userId))).toBe(fee);
    const spends = await feeEntries(userId);
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ ref: `project-fee:${project.id}`, amount: fee });
    expect((await projectRow(project.id)).fee_charged).toBe(true);
    expect(await castRows(project.id)).toHaveLength(2);
    expect(await jobsOf(project.id)).toHaveLength(6);
  });

  it('reads the fee from pricing, not from a number in the code', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('projectFee', '40'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const { userId, project } = await newProject();
      const before = await available(userId);
      await generateCast({ userId, projectId: project.id });
      expect(before - (await available(userId))).toBe(40);
    } finally {
      await raw.query(`delete from pricing_config where key = 'projectFee'`);
      _resetPricingCache();
    }
  });

  it('does not charge the fee again for a project whose fee was already paid', async () => {
    const { userId, project } = await newProject();
    await storyDb().update('story_projects', { id: project.id }, { fee_charged: true });
    const before = await available(userId);
    await generateCast({ userId, projectId: project.id });
    expect(await available(userId)).toBe(before);
    expect(await feeEntries(userId)).toHaveLength(0);
  });

  it('keeps at most 5 characters, trims and drops duplicates', async () => {
    expect(CAST_MAX).toBe(5);
    registerMock('story_cast', () => ({
      characters: [
        ...['Ana', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus'].map((name) => ({ name, description: `${name} is a person.`, voiceNote: 'warm' })),
        { name: ' ana ', description: 'duplicate', voiceNote: 'x' },
      ],
    }));
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    expect((await castRows(project.id)).map((c) => c.name)).toEqual(['Ana', 'Ben', 'Cleo', 'Dev', 'Eli']);
    expect(await jobsOf(project.id)).toHaveLength(15);
  });

  it('asks the fast model once with the script', async () => {
    const spy = vi.fn(storyCastMock);
    registerMock('story_cast', spy);
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    await generateCast({ userId, projectId: project.id });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].tier).toBe('fast');
    expect(JSON.stringify(spy.mock.calls[0][0].messages)).toContain('Maya sweeps the small barbershop');
  });

  it('a free account gets 402 plan_required and nothing is charged, asked or saved', async () => {
    accounts.set({ paid: false });
    const spy = vi.fn(storyCastMock);
    registerMock('story_cast', spy);
    const { userId, project } = await newProject();
    const err = await generateCast({ userId, projectId: project.id }).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: 'plan_required' });
    const res = makeRes();
    sendError(res, err);
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toBe('plan_required');
    expect(spy).not.toHaveBeenCalled();
    expect(await castRows(project.id)).toHaveLength(0);
    expect(await feeEntries(userId)).toHaveLength(0);
  });

  it('needs a script first', async () => {
    const { userId, project } = await newProject({ scenes: null });
    await expect(generateCast({ userId, projectId: project.id })).rejects.toMatchObject({ status: 422 });
    expect(await feeEntries(userId)).toHaveLength(0);
  });

  it('without enough credits it throws InsufficientCreditsError and saves nothing', async () => {
    const { userId, project } = await newProject({ funds: 50 });
    await expect(generateCast({ userId, projectId: project.id })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await castRows(project.id)).toHaveLength(0);
    expect(await jobsOf(project.id)).toHaveLength(0);
    expect((await projectRow(project.id)).fee_charged).toBe(false);
    expect(await available(userId)).toBe(50);
  });

  it("another user's project is a 404", async () => {
    const { project } = await newProject();
    await expect(generateCast({ userId: randomUUID(), projectId: project.id })).rejects.toMatchObject({ status: 404 });
  });

  it('screens the written names and descriptions, retries once family friendly, then 422', async () => {
    const spy = vi.fn(() => ({ characters: [{ name: 'Maya', description: 'A nude figure.', voiceNote: 'soft' }] }));
    registerMock('story_cast', spy);
    const { userId, project } = await newProject();
    const err = await generateCast({ userId, projectId: project.id }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'cast_blocked' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].system).toMatch(/family friendly/i);
    expect(await castRows(project.id)).toHaveLength(0);
    expect(await feeEntries(userId)).toHaveLength(0);
  });

  it('recovers when the first answer trips moderation and the second does not', async () => {
    let n = 0;
    registerMock('story_cast', (input) => {
      n += 1;
      return n === 1 ? { characters: [{ name: 'Maya', description: 'A nude figure.', voiceNote: 'soft' }] } : storyCastMock(input);
    });
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    expect((await castRows(project.id)).map((c) => c.name)).toEqual(['Maya', 'Leo']);
  });

  it('an empty answer is a 502 cast_failed and costs nothing', async () => {
    registerMock('story_cast', () => ({ characters: [] }));
    const { userId, project } = await newProject();
    await expect(generateCast({ userId, projectId: project.id })).rejects.toMatchObject({ status: 502, code: 'cast_failed' });
    expect(await feeEntries(userId)).toHaveLength(0);
  });

  it('finishes with three pictures per character, in slot order, and no job charges', async () => {
    const { userId, project, cast } = await readyCast();
    for (const row of cast) {
      expect(row.status).toBe('ready');
      expect(row.candidates.map((c) => c.slot)).toEqual([0, 1, 2]);
      expect(row.candidates.every((c) => c.url && c.key && c.prompt)).toBe(true);
    }
    expect((await jobsOf(project.id)).every((j) => j.status === 'done')).toBe(true);
    expect((await feeEntries(userId))).toHaveLength(1); // the fee only
  });

  it('a failed first round leaves the character failed with no pictures', async () => {
    const { userId, project } = await newProject({
      scenes: [{ ...SCENES[0], visual: `${SCENES[0].visual} [[mock:fail]]` }, SCENES[1]],
    });
    await generateCast({ userId, projectId: project.id });
    await finishJobs(project.id);
    const rows = await castRows(project.id);
    expect(rows.map((r) => [r.name, r.status])).toEqual([['Maya', 'failed'], ['Leo', 'ready']]);
    expect(rows[0].candidates).toEqual([]);
  });

  async function stoppedStart() {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [first] = await castRows(project.id);
    // Simulate the crash window: the row is still a draft and one job never got queued.
    await storyDb().update('story_cast', { id: first.id }, { status: 'draft' });
    const victim = (await jobsOf(project.id)).find((j) => j.payload.castId === first.id && j.payload.slot === 2);
    await storyDb().remove('story_jobs', { id: victim.id });
    return { userId, project, first };
  }
  const ageDraft = async (id) => {
    // updated_at is set by a trigger; switch it off to make the row look old.
    await raw.exec('alter table public.story_cast disable trigger story_cast_touch');
    try {
      await raw.query(`update public.story_cast set updated_at = now() - interval '5 minutes' where id = $1`, [id]);
    } finally {
      await raw.exec('alter table public.story_cast enable trigger story_cast_touch');
    }
  };

  it('a repeated call restarts a start that stopped, once the draft is old enough, without a second charge', async () => {
    const { userId, project, first } = await stoppedStart();
    await ageDraft(first.id);
    await generateCast({ userId, projectId: project.id });
    const row = await castRow(first.id);
    expect(row).toMatchObject({ status: 'pending', round: 2 });
    const fresh = (await jobsOf(project.id)).filter((j) => j.payload.castId === first.id && j.payload.round === 2);
    expect(fresh.map((j) => j.payload.slot).sort()).toEqual([0, 1, 2]);
    // The jobs of the abandoned round are not left to cost provider money.
    const stale = (await jobsOf(project.id)).filter((j) => j.payload.castId === first.id && j.payload.round === 1);
    expect(stale.every((j) => j.status !== 'queued')).toBe(true);
    expect(await feeEntries(userId)).toHaveLength(1);
    await finishJobs(project.id);
    expect((await castRow(first.id)).candidates.map((c) => c.slot)).toEqual([0, 1, 2]);
  });

  it('leaves a draft alone while its first call may still be queuing the jobs', async () => {
    const { userId, project, first } = await stoppedStart();
    const count = (await jobsOf(project.id)).length;
    await generateCast({ userId, projectId: project.id });
    expect(await jobsOf(project.id)).toHaveLength(count);
    expect((await castRow(first.id)).round).toBe(1);
  });
});

// ---------------------------------------------------------------- picture jobs

describe('cast_image handler', () => {
  async function withDoneJobs() {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [row] = await castRows(project.id);
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === row.id);
    await storyDb().update('story_jobs', { id: jobs.map((j) => j.id) }, { status: 'done' });
    const done = (await jobsOf(project.id)).filter((j) => j.payload.castId === row.id);
    return { userId, project, row, jobs: done };
  }
  const result = (n) => ({ url: `/api/mock/storage/story/x/${n}.png`, key: `story/x/${n}.png` });

  it('applies three finishing jobs at the same moment without losing one', async () => {
    const { row, jobs } = await withDoneJobs();
    await Promise.all(jobs.map((j) => castImageHandler.onDone(j, result(j.payload.slot))));
    const after = await castRow(row.id);
    expect(after.candidates.map((c) => c.slot)).toEqual([0, 1, 2]);
    expect(after.status).toBe('ready');
  });

  it('is safe to run twice for the same job', async () => {
    const { row, jobs } = await withDoneJobs();
    for (const j of jobs) await castImageHandler.onDone(j, result(j.payload.slot));
    await castImageHandler.onDone(jobs[1], result(1));
    await castImageHandler.onDone(jobs[1], result(1));
    expect((await castRow(row.id)).candidates).toHaveLength(3);
  });

  it('ignores a job from an older round', async () => {
    const { row, jobs } = await withDoneJobs();
    await storyDb().update('story_cast', { id: row.id }, { round: 2 });
    await castImageHandler.onDone(jobs[0], result(0));
    expect((await castRow(row.id)).candidates).toEqual([]);
  });

  it('onFail only reads and writes the database (no provider is called)', async () => {
    const { row, jobs } = await withDoneJobs();
    await storyDb().update('story_jobs', { id: jobs.map((j) => j.id) }, { status: 'failed' });
    await Promise.all(jobs.map((j) => castImageHandler.onFail(j, { blocked: false, error: 'x', final: true })));
    expect((await castRow(row.id)).status).toBe('failed');
  });

  it('a blocked round shows as blocked', async () => {
    const { row, jobs } = await withDoneJobs();
    await storyDb().update('story_jobs', { id: jobs.map((j) => j.id) }, { status: 'blocked' });
    for (const j of jobs) await castImageHandler.onFail(j, { blocked: true, error: 'blocked', final: true });
    expect((await castRow(row.id)).status).toBe('blocked');
  });

  it('submits the stored prompt and references to the image provider', async () => {
    const { jobs } = await withDoneJobs();
    const out = await castImageHandler.submit({ ...jobs[0], payload: { ...jobs[0].payload, prompt: 'A kind barber', aspect: '3:4' } });
    expect(out).toMatchObject({ provider: 'mock' });
  });
});

// ---------------------------------------------------------------- pickCast

describe('pickCast', () => {
  it('returns 409 when the pictures are not finished', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [row] = await castRows(project.id);
    await expect(pickCast({ userId, projectId: project.id, castId: row.id, candidateIndex: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await jobsOf(project.id)).toHaveLength(6); // no sheet job
  });

  it('returns 409 for a character with no pictures (failed)', async () => {
    const { userId, project } = await newProject({ scenes: [{ ...SCENES[0], visual: '[[mock:fail]]' }, SCENES[1]] });
    await generateCast({ userId, projectId: project.id });
    await finishJobs(project.id);
    const [row] = await castRows(project.id);
    await expect(pickCast({ userId, projectId: project.id, castId: row.id, candidateIndex: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an option that does not exist with 422', async () => {
    const { userId, project, cast } = await readyCast();
    for (const candidateIndex of [3, -1, 1.5, 'a', undefined]) {
      await expect(pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex })).rejects.toMatchObject({ status: 422 });
    }
  });

  it('saves the pick and queues one cast sheet job that uses the pick as its reference', async () => {
    const { userId, project, cast } = await readyCast();
    const before = (await jobsOf(project.id)).length;
    const { cast: picked } = await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 1 });
    expect(picked).toMatchObject({ chosen_index: 1, image_url: cast[0].candidates[1].url, image_key: cast[0].candidates[1].key });
    const jobs = await jobsOf(project.id);
    expect(jobs).toHaveLength(before + 1);
    const sheet = jobs.at(-1);
    expect(sheet.payload).toMatchObject({ stage: 'sheet', castId: cast[0].id, fromKey: cast[0].candidates[1].key, refs: [cast[0].candidates[1].url] });
    expect(sheet.payload.prompt).toMatch(/front/i);
    expect(sheet.payload.prompt).toMatch(/three.quarter/i);
    expect(sheet.payload.prompt).toMatch(/close.up/i);
    expect(sheet.cost_credits).toBeNull();
  });

  it('the finished sheet is stored on the character', async () => {
    const { userId, project, cast } = await readyCast();
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 });
    await finishJobs(project.id);
    const row = await castRow(cast[0].id);
    expect(row.sheet).toMatchObject({ from_key: cast[0].candidates[0].key });
    expect(row.sheet.url).toBeTruthy();
    expect(row.sheet.key).toBeTruthy();
    expect(row.status).toBe('ready');
  });

  it('picking the same option again changes nothing and queues nothing', async () => {
    const { userId, project, cast } = await readyCast();
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 });
    const count = (await jobsOf(project.id)).length;
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 }); // sheet in flight
    await finishJobs(project.id);
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 }); // sheet done
    expect(await jobsOf(project.id)).toHaveLength(count);
  });

  it('a different pick while the sheet is still being drawn is a 409', async () => {
    const { userId, project, cast } = await readyCast();
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 });
    await expect(pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('a different pick after the sheet is done replaces the sheet', async () => {
    const { userId, project, cast } = await readyCast();
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 });
    await finishJobs(project.id);
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 2 });
    expect((await castRow(cast[0].id)).sheet).toEqual({});
    await finishJobs(project.id);
    expect((await castRow(cast[0].id)).sheet).toMatchObject({ from_key: cast[0].candidates[2].key });
  });

  it('a sheet that finishes after the pick changed is dropped', async () => {
    const { userId, project, cast } = await readyCast();
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 });
    const sheetJob = (await jobsOf(project.id)).at(-1);
    await storyDb().update('story_cast', { id: cast[0].id }, { image_key: 'something-else' });
    await castImageHandler.onDone(sheetJob, { url: '/api/mock/storage/s.png', key: 's.png' });
    expect((await castRow(cast[0].id)).sheet).toEqual({});
  });

  it("another user's character is a 404", async () => {
    const { project, cast } = await readyCast();
    await expect(pickCast({ userId: randomUUID(), projectId: project.id, castId: cast[0].id, candidateIndex: 0 })).rejects.toMatchObject({ status: 404 });
    await expect(pickCast({ userId: randomUUID(), projectId: project.id, castId: randomUUID(), candidateIndex: 0 })).rejects.toMatchObject({ status: 404 });
  });

  it('stops queuing sheets after 6 per round of pictures, keeps the pick, and a regeneration starts the count again', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    for (let i = 0; i < 6; i += 1) {
      await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: i % 2 });
      await finishJobs(project.id);
      await forgetSheets(project.id); // so going back to a picture makes a new sheet
    }
    const count = (await jobsOf(project.id)).length;
    await expect(pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 2 })).rejects.toMatchObject({ status: 429, code: 'sheet_limit' });
    expect(await castRow(id)).toMatchObject({ chosen_index: 2, sheet: {} }); // the pick was saved
    expect(await jobsOf(project.id)).toHaveLength(count); // no sheet queued
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'again' });
    await finishJobs(project.id);
    await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 0 });
    await finishJobs(project.id);
    expect((await castRow(id)).sheet).toMatchObject({ url: expect.any(String) });
  });

  it('failed sheets do not count towards the cap', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    for (let i = 0; i < 6; i += 1) {
      await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: i % 2 });
      await finishJobs(project.id);
      await forgetSheets(project.id); // so going back to a picture makes a new sheet
    }
    await storyDb().update('story_jobs', { project_id: project.id, kind: 'cast_image', status: 'done' }, { status: 'failed' });
    await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 2 });
  });
});

// ---------------------------------------------------------------- regenerateCharacter

describe('regenerateCharacter', () => {
  it('the first two regenerations per character are free, the third costs castRegen (5)', async () => {
    const { userId, project, cast } = await readyCast();
    const castRegen = (await getPricing()).castRegen;
    expect(castRegen).toBe(5);
    const id = cast[0].id;
    let balance = await available(userId);

    for (const n of [1, 2]) {
      const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, note: `try ${n}` });
      expect(out.charged).toBe(0);
      expect((await getBalance(userId)).held).toBe(0);
      await finishJobs(project.id);
      expect((await castRow(id)).regens_used).toBe(n);
      expect(await available(userId)).toBe(balance);
    }

    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'third' });
    expect(out.charged).toBe(castRegen);
    expect((await getBalance(userId)).held).toBe(castRegen);
    const round = (await castRow(id)).round;
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === round);
    expect(jobs).toHaveLength(3);
    expect(jobs.reduce((n, j) => n + (j.cost_credits || 0), 0)).toBe(castRegen);
    expect(new Set(jobs.map((j) => j.hold_id)).size).toBe(1);
    await finishJobs(project.id);
    expect((await castRow(id)).regens_used).toBe(3);
    expect((await getBalance(userId)).held).toBe(0);
    expect(await available(userId)).toBe(balance - castRegen);
    // The other character still has its own two free ones.
    const other = await regenerateCharacter({ userId, projectId: project.id, castId: cast[1].id, note: 'other' });
    expect(other.charged).toBe(0);
  });

  it('charges what pricing says, not a number in the code', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('castRegen', '7'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const { userId, project, cast } = await readyCast();
      await storyDb().update('story_cast', { id: cast[0].id }, { regens_used: 2 });
      const before = await available(userId);
      const out = await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'older' });
      expect(out.charged).toBe(7);
      await finishJobs(project.id);
      expect(before - (await available(userId))).toBe(7);
    } finally {
      await raw.query(`delete from pricing_config where key = 'castRegen'`);
      _resetPricingCache();
    }
  });

  it('uses the included allowance from pricing', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('included', '{"castRegenPerCharacter": 1}'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const { userId, project, cast } = await readyCast();
      const first = await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'a' });
      expect(first.charged).toBe(0);
      await finishJobs(project.id);
      const second = await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'b' });
      expect(second.charged).toBe(5);
    } finally {
      await raw.query(`delete from pricing_config where key = 'included'`);
      _resetPricingCache();
    }
  });

  it('replaces the pictures, clears the pick and the sheet, and puts the note in the prompts', async () => {
    const { userId, project, cast } = await readyCast();
    await pickCast({ userId, projectId: project.id, castId: cast[0].id, candidateIndex: 0 });
    await finishJobs(project.id);
    const { cast: row } = await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'older, with round glasses' });
    expect(row).toMatchObject({ status: 'pending', candidates: [], chosen_index: null, image_url: null, image_key: null, sheet: {}, round: 2, regens_used: 1 });
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === cast[0].id && j.payload.round === 2);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.payload.prompt.includes('older, with round glasses'))).toBe(true);
    await finishJobs(project.id);
    expect((await castRow(cast[0].id)).status).toBe('ready');
  });

  it('works without a note', async () => {
    const { userId, project, cast } = await readyCast();
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id });
    expect(out.cast.status).toBe('pending');
  });

  it('is a 409 while the pictures are still being made, and nothing is charged', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [row] = await castRows(project.id);
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: row.id, note: 'x' })).rejects.toMatchObject({ status: 409 });
    expect((await castRow(row.id)).regens_used).toBe(0);
  });

  it('two requests at once make one round', async () => {
    const { userId, project, cast } = await readyCast();
    const results = await Promise.allSettled([
      regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'a' }),
      regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ status: 409 });
    const row = await castRow(cast[0].id);
    expect(row).toMatchObject({ regens_used: 1, round: 2 });
    expect((await jobsOf(project.id)).filter((j) => j.payload.castId === cast[0].id && j.payload.round === 2)).toHaveLength(3);
  });

  it('screens the note before anything happens', async () => {
    const { userId, project, cast } = await readyCast();
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'make her nude' })).rejects.toBeInstanceOf(ModerationError);
    expect((await castRow(cast[0].id)).regens_used).toBe(0);
  });

  it('rejects a note that is not text or is too long with 422', async () => {
    const { userId, project, cast } = await readyCast();
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 42 })).rejects.toMatchObject({ status: 422 });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x'.repeat(501) })).rejects.toMatchObject({ status: 422 });
  });

  it('does not screen the note for a free account (no classifier call)', async () => {
    const { userId, project, cast } = await readyCast();
    accounts.set({ paid: false });
    // A note that moderation would block: the plan check must come first.
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'make her nude' })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });

  it('a free account gets 402 plan_required', async () => {
    const { userId, project, cast } = await readyCast();
    accounts.set({ paid: false });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x' })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });

  it('a paid regeneration without credits is a 402 and leaves the character as it was', async () => {
    const { userId, project, cast } = await readyCast();
    await storyDb().update('story_cast', { id: cast[0].id }, { regens_used: 2 });
    const [{ available: have }] = [await getBalance(userId)];
    // Spend down to less than the price.
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId, currency: 'video', amount: have - 2, reason: 'test', ref: randomUUID() });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x' })).rejects.toBeInstanceOf(InsufficientCreditsError);
    const row = await castRow(cast[0].id);
    expect(row).toMatchObject({ status: 'ready', regens_used: 2 });
    expect(row.candidates).toHaveLength(3);
    expect((await getBalance(userId)).held).toBe(0);
  });

  it('a paid round that fails everywhere costs nothing', async () => {
    const { userId, project, cast } = await readyCast();
    await storyDb().update('story_cast', { id: cast[0].id }, { regens_used: 2 });
    const before = await available(userId);
    await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x [[mock:fail]]' });
    await finishJobs(project.id);
    expect((await castRow(cast[0].id)).status).toBe('failed');
    expect(await available(userId)).toBe(before);
    expect((await getBalance(userId)).held).toBe(0);
  });

  it('a paid round where only one picture fails charges only the pictures that came out', async () => {
    const { userId, project, cast } = await readyCast();
    await storyDb().update('story_cast', { id: cast[0].id }, { regens_used: 2 });
    const before = await available(userId);
    await regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x' });
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === cast[0].id && j.payload.round === 2);
    const failing = jobs.find((j) => j.payload.slot === 2);
    await storyDb().update('story_jobs', { id: failing.id }, { payload: { ...failing.payload, prompt: `${failing.payload.prompt} [[mock:fail]]` } });
    await finishJobs(project.id);
    const row = await castRow(cast[0].id);
    expect(row.status).toBe('ready');
    expect(row.candidates.map((c) => c.slot)).toEqual([0, 1]);
    const charged = before - (await available(userId));
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThan(5);
    expect((await getBalance(userId)).held).toBe(0);
  });

  it('does not queue jobs when the hold cannot be made', async () => {
    const { userId, project, cast } = await readyCast();
    await storyDb().update('story_cast', { id: cast[0].id }, { regens_used: 2 });
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId, currency: 'video', amount: (await getBalance(userId)).available, reason: 'test', ref: randomUUID() });
    const count = (await jobsOf(project.id)).length;
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x' })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await jobsOf(project.id)).toHaveLength(count);
  });
});

// ---------------------------------------------------------------- retry

describe('retry (free)', () => {
  async function failedCharacter({ paidRound = false } = {}) {
    const ctx = await readyCast();
    const id = ctx.cast[0].id;
    if (paidRound) await storyDb().update('story_cast', { id }, { regens_used: 2 });
    await regenerateCharacter({ userId: ctx.userId, projectId: ctx.project.id, castId: id, note: 'a change [[mock:fail]]' });
    await finishJobs(ctx.project.id);
    expect((await castRow(id)).status).toBe('failed');
    return { ...ctx, id };
  }

  it('after a provider failure it makes new pictures, charges nothing and does not use a free regeneration', async () => {
    const { userId, project, id } = await failedCharacter();
    const used = (await castRow(id)).regens_used;
    const before = await available(userId);
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true });
    expect(out.charged).toBe(0);
    const row = await castRow(id);
    expect(row.status).toBe('pending');
    expect(row.regens_used).toBe(used);
    expect(row.round).toBe(3);
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 3);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.hold_id === null && j.cost_credits === null)).toBe(true);
    expect(await available(userId)).toBe(before);
    expect((await getBalance(userId)).held).toBe(0);
  });

  it('keeps the earlier note in the new pictures', async () => {
    const { project, userId, id } = await failedCharacter();
    await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true });
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 3);
    expect(jobs.every((j) => j.payload.prompt.includes('a change'))).toBe(true);
  });

  it('a retry of a failed PAID round holds that round\'s price again, settles per picture, and uses no free regeneration', async () => {
    const { userId, project, id } = await failedCharacter({ paidRound: true });
    const price = (await getPricing()).castRegen;
    const before = await available(userId);
    const used = (await castRow(id)).regens_used;
    // The earlier note carried a failure token; drop it so this time the pictures come out.
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true });
    expect(out.charged).toBe(price);
    expect((await getBalance(userId)).held).toBe(price);
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 3);
    expect(jobs.reduce((n, j) => n + (j.cost_credits || 0), 0)).toBe(price);
    expect((await castRow(id)).regens_used).toBe(used);
    await finishJobs(project.id); // the token is still in the note, so they fail again and everything is given back
    expect((await getBalance(userId)).held).toBe(0);
    expect(await available(userId)).toBe(before);
  });

  it('a retry of a paid round that now comes out is charged once for the pictures', async () => {
    const { userId, project, id } = await failedCharacter({ paidRound: true });
    const before = await available(userId);
    // Take the failure token out of the stored note so the retry succeeds.
    const old = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 2);
    for (const j of old) await storyDb().update('story_jobs', { id: j.id }, { payload: { ...j.payload, note: 'a change' } });
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true });
    await finishJobs(project.id);
    expect((await castRow(id)).status).toBe('ready');
    expect(before - (await available(userId))).toBe(out.charged);
    expect(out.charged).toBe((await getPricing()).castRegen);
  });

  it('a paid retry without credits is a 402 and changes nothing', async () => {
    const { userId, project, id } = await failedCharacter({ paidRound: true });
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId, currency: 'video', amount: (await getBalance(userId)).available, reason: 'test', ref: randomUUID() });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await castRow(id)).toMatchObject({ status: 'failed', round_credits: 5 });
  });

  it('is not a free re-roll: it is refused when the last attempt did not fail', async () => {
    const { userId, project, cast } = await readyCast();
    const jobs = (await jobsOf(project.id)).length;
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, retry: true })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
    const row = await castRow(cast[0].id);
    expect(row).toMatchObject({ status: 'ready', regens_used: 0, round: 1 });
    expect(await jobsOf(project.id)).toHaveLength(jobs);
  });

  it('cannot be used twice in a row on a round that is already being retried', async () => {
    const { userId, project, id } = await failedCharacter();
    const results = await Promise.allSettled([
      regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true }),
      regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 3)).toHaveLength(3);
  });

  it('is refused while pictures are pending and after a block (the customer must change the request)', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [row] = await castRows(project.id);
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: row.id, retry: true })).rejects.toMatchObject({ status: 409 });
    await storyDb().update('story_cast', { id: row.id }, { status: 'blocked' });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: row.id, retry: true })).rejects.toMatchObject({ status: 409 });
  });

  it('works for a first round that failed', async () => {
    const { userId, project } = await newProject({ scenes: [{ ...SCENES[0], visual: '[[mock:fail]]' }, SCENES[1]] });
    await generateCast({ userId, projectId: project.id });
    await finishJobs(project.id);
    const [row] = await castRows(project.id);
    expect(row.status).toBe('failed');
    const before = await available(userId);
    await regenerateCharacter({ userId, projectId: project.id, castId: row.id, retry: true });
    expect((await castRow(row.id)).regens_used).toBe(0);
    expect(await available(userId)).toBe(before);
  });

  it('a free account cannot retry either', async () => {
    const { userId, project, id } = await failedCharacter();
    accounts.set({ paid: false });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true })).rejects.toMatchObject({ status: 402 });
  });
});

// ---------------------------------------------------------------- round 1

describe('holds are never left behind (K2, K5)', () => {
  const price = 5;
  async function paidReady() {
    const ctx = await readyCast();
    await storyDb().update('story_cast', { id: ctx.cast[0].id }, { regens_used: 2 });
    return ctx;
  }

  it('releases the hold when claiming the round throws', async () => {
    const { userId, project, cast } = await paidReady();
    const db = storyDb();
    const spy = vi.spyOn(db, 'update').mockImplementationOnce(async () => { throw new Error('database unavailable'); });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x' })).rejects.toThrow('database unavailable');
    spy.mockRestore();
    expect((await getBalance(userId)).held).toBe(0);
    expect(await castRow(cast[0].id)).toMatchObject({ status: 'ready', regens_used: 2 });
  });

  it('releases the hold and restores the pictures when queuing the jobs throws, and fences the aborted round', async () => {
    const { userId, project, cast } = await paidReady();
    const db = storyDb();
    const real = db.insert.bind(db);
    const guard = vi.spyOn(db, 'insert').mockImplementation(async (table, rows) => {
      if (table === 'story_jobs') throw new Error('queue unavailable');
      return real(table, rows);
    });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: cast[0].id, note: 'x' })).rejects.toThrow('queue unavailable');
    guard.mockRestore();
    expect((await getBalance(userId)).held).toBe(0);
    const row = await castRow(cast[0].id);
    expect(row).toMatchObject({ status: 'ready', regens_used: 2, hold_id: null });
    expect(row.candidates).toHaveLength(3);
    expect(row.round).toBeGreaterThan(2); // a job of the aborted round (2) can no longer write
  });

  it('does not restart a draft when one of its jobs has already left the queue (K4)', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [first] = await castRows(project.id);
    await storyDb().update('story_cast', { id: first.id }, { status: 'draft' });
    const [job] = (await jobsOf(project.id)).filter((j) => j.payload.castId === first.id);
    await storyDb().update('story_jobs', { id: job.id }, { status: 'running' });
    await raw.exec('alter table public.story_cast disable trigger story_cast_touch');
    await raw.query(`update public.story_cast set updated_at = now() - interval '5 minutes' where id = $1`, [first.id]);
    await raw.exec('alter table public.story_cast enable trigger story_cast_touch');
    await generateCast({ userId, projectId: project.id });
    expect((await castRow(first.id)).round).toBe(1);
  });

  it('a done job whose picture is not in yet keeps the round pending, so a retry cannot slip in (K4)', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const [row] = await castRows(project.id);
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === row.id);
    await storyDb().update('story_jobs', { id: jobs.map((j) => j.id) }, { status: 'done' });
    await castImageHandler.onDone(jobs[0], { url: '/api/mock/storage/a.png', key: 'a.png' });
    expect((await castRow(row.id)).status).toBe('pending');
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: row.id, retry: true })).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------- round 2

describe('prices on the row and held credits (L1 to L7)', () => {
  const PRICE = 5;
  const agedDraft = async (id) => {
    await raw.exec('alter table public.story_cast disable trigger story_cast_touch');
    try {
      await raw.query(`update public.story_cast set updated_at = now() - interval '5 minutes' where id = $1`, [id]);
    } finally {
      await raw.exec('alter table public.story_cast enable trigger story_cast_touch');
    }
  };
  async function failedPaidRound() {
    const ctx = await readyCast();
    const id = ctx.cast[0].id;
    await storyDb().update('story_cast', { id }, { regens_used: 2 });
    await regenerateCharacter({ userId: ctx.userId, projectId: ctx.project.id, castId: id, note: 'x [[mock:fail]]' });
    await finishJobs(ctx.project.id);
    expect(await castRow(id)).toMatchObject({ status: 'failed', round_credits: PRICE });
    return { ...ctx, id };
  }
  /** A paid regeneration whose request died: claimed, held (or not), `queued` of its jobs made, draft and old. */
  async function deadPaidStart({ held = true, queued = 2 } = {}) {
    const ctx = await readyCast();
    const id = ctx.cast[0].id;
    const { holdCredits } = await import('../../lib/credits.js');
    const holdId = randomUUID();
    if (held) await holdCredits({ userId: ctx.userId, currency: 'video', amount: PRICE, projectId: ctx.project.id, holdId });
    await storyDb().update('story_cast', { id }, {
      status: 'draft', round: 2, regens_used: 3, hold_id: holdId, hold_credits: PRICE, round_credits: PRICE, candidates: [], candidates_round: null,
    });
    const shares = [2, 2, 1];
    for (let slot = 0; slot < queued; slot += 1) {
      await enqueue({
        projectId: ctx.project.id, kind: 'cast_image', holdId, costCredits: shares[slot],
        payload: { stage: 'candidate', castId: id, round: 2, slot, note: 'older', aspect: '3:4', prompt: 'p' },
      });
    }
    await agedDraft(id);
    return { ...ctx, id, holdId };
  }

  it('L1: a retry whose queuing throws leaves the round priced, so the next retry holds the price again', async () => {
    const { userId, project, id } = await failedPaidRound();
    const db = storyDb();
    const real = db.insert.bind(db);
    const guard = vi.spyOn(db, 'insert').mockImplementation(async (table, rows) => {
      if (table === 'story_jobs') throw new Error('queue unavailable');
      return real(table, rows);
    });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true })).rejects.toThrow('queue unavailable');
    guard.mockRestore();
    expect((await getBalance(userId)).held).toBe(0);
    expect(await castRow(id)).toMatchObject({ status: 'failed', round_credits: PRICE });
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true });
    expect(out.charged).toBe(PRICE);
    expect((await getBalance(userId)).held).toBe(PRICE);
  });

  it('L1: a rolled back regeneration does not reset the sheet count', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    for (let i = 0; i < 6; i += 1) {
      await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: i % 2 });
      await finishJobs(project.id);
      await forgetSheets(project.id); // so going back to a picture makes a new sheet
    }
    await storyDb().update('story_cast', { id }, { regens_used: 2 });
    const db = storyDb();
    const real = db.insert.bind(db);
    const guard = vi.spyOn(db, 'insert').mockImplementation(async (table, rows) => {
      if (table === 'story_jobs') throw new Error('queue unavailable');
      return real(table, rows);
    });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x' })).rejects.toThrow();
    guard.mockRestore();
    await expect(pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 2 })).rejects.toMatchObject({ code: 'sheet_limit' });
  });

  it('L2: a restarted paid start carries its hold forward: nothing released, nothing held twice, shares add up', async () => {
    const { userId, project, id, holdId } = await deadPaidStart();
    const before = await available(userId);
    expect((await getBalance(userId)).held).toBe(PRICE);
    await generateCast({ userId, projectId: project.id });
    expect((await getBalance(userId)).held).toBe(PRICE);
    const row = await castRow(id);
    expect(row).toMatchObject({ status: 'pending', round: 3, round_credits: PRICE });
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 3);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.hold_id === holdId)).toBe(true);
    expect(jobs.reduce((n, j) => n + j.cost_credits, 0)).toBe(PRICE);
    expect((await jobsOf(project.id)).filter((j) => j.payload.round === 2 && j.payload.castId === id)).toHaveLength(0);
    await finishJobs(project.id);
    expect((await getBalance(userId)).held).toBe(0);
    expect(await available(userId)).toBe(before); // `before` already had the 5 held; it is now spent, once
  });

  it('L3: a claimed round whose hold never happened is re-held when it can be, with the same hold id', async () => {
    const { userId, project, id, holdId } = await deadPaidStart({ held: false, queued: 0 });
    await generateCast({ userId, projectId: project.id });
    expect((await getBalance(userId)).held).toBe(PRICE);
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 3);
    expect(jobs.every((j) => j.hold_id === holdId)).toBe(true);
  });

  it('L3: ... and when the credits are gone it is reset to failed with nothing to release, still priced for a retry', async () => {
    const { userId, project, id } = await deadPaidStart({ held: false, queued: 1 });
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId, currency: 'video', amount: (await getBalance(userId)).available, reason: 'test', ref: randomUUID() });
    await generateCast({ userId, projectId: project.id });
    expect(await castRow(id)).toMatchObject({ status: 'failed', round_credits: PRICE, hold_id: null });
    expect((await getBalance(userId)).held).toBe(0);
    expect((await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.status === 'queued')).toHaveLength(0);
    const view = await castView(await castRow(id));
    expect(view.retry_credits).toBe(PRICE);
  });

  it('L6: a start that died with part of its jobs unqueued gives back the share of the jobs that never existed', async () => {
    const { userId, project, id } = await deadPaidStart({ queued: 2 });
    const before = await available(userId);
    // The two queued jobs run (the draft is never restarted: they left the queue).
    await storyDb().update('story_jobs', { project_id: project.id, kind: 'cast_image', status: 'queued' }, { status: 'done' });
    const jobs = (await jobsOf(project.id)).filter((j) => j.payload.castId === id && j.payload.round === 2);
    for (const j of jobs) await castImageHandler.onDone(j, { url: `/api/mock/storage/${j.payload.slot}.png`, key: `k${j.payload.slot}.png` });
    expect((await castRow(id)).status).toBe('ready');
    expect((await getBalance(userId)).held).toBe(0); // 4 settled, the 1 of the missing job released
    expect((await available(userId)) - before).toBe(1); // 4 spent, 5 held then freed
  });

  it('L4: the cast view carries the retry and regeneration prices', async () => {
    const { userId, project } = await newProject();
    const { cast } = await generateCast({ userId, projectId: project.id });
    expect(cast.every((c) => c.retry_credits === 0 && c.regen_credits === 0)).toBe(true);
    const { id } = await failedPaidRound();
    const view = await castView(await castRow(id));
    expect(view).toMatchObject({ retry_credits: PRICE, regen_credits: PRICE });
    const res = await (await import('../../lib/story/actions.js')).getAction('cast', 'GET').handler({ projectId: (await castRow(id)).project_id });
    expect(res.cast.find((c) => c.id === id)).toMatchObject({ retry_credits: PRICE });
  });

  it('L4: expected_credits that no longer matches is 409 quote_changed and changes nothing', async () => {
    const { userId, project, id } = await failedPaidRound();
    const before = await castRow(id);
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true, expectedCredits: 0 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x', expectedCredits: 0 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    expect(await castRow(id)).toMatchObject({ round: before.round, status: 'failed' });
    expect((await getBalance(userId)).held).toBe(0);
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true, expectedCredits: PRICE });
    expect(out.charged).toBe(PRICE);
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x', expectedCredits: -1 })).rejects.toMatchObject({ status: 422 });
  });

  it('L7: picking back to an earlier picture reuses its finished sheet', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 0 });
    await finishJobs(project.id);
    const first = (await castRow(id)).sheet;
    await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 1 });
    await finishJobs(project.id);
    const count = (await jobsOf(project.id)).length;
    await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 0 });
    expect(await jobsOf(project.id)).toHaveLength(count);
    expect((await castRow(id)).sheet).toMatchObject({ url: first.url, key: first.key, from_key: cast[0].candidates[0].key });
  });
});

// ---------------------------------------------------------------- HTTP actions

describe('actions', () => {
  it('registers cast, cast-regen and cast-pick (POST) and cast (GET)', async () => {
    await import('../../lib/story/actionRoute.js');
    expect(getActionMethods('cast').sort()).toEqual(['GET', 'POST']);
    expect(getActionMethods('cast-regen')).toEqual(['POST']);
    expect(getActionMethods('cast-pick')).toEqual(['POST']);
  });

  async function call(name, method, { userId, project, body = {} }) {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    globalThis.__castTestSession = { user: { id: userId, email: 'test@example.test' } };
    const res = makeRes();
    await handleAction(makeReq({ method, body, query: { id: project.id } }), res, name);
    return res;
  }

  it('walks the whole flow through the dispatcher with the shapes the screen uses', async () => {
    const { userId, project } = await newProject();
    let res = await call('cast', 'POST', { userId, project });
    expect(res.statusCode).toBe(200);
    expect(res.body.cast).toHaveLength(2);
    await finishJobs(project.id);
    res = await call('cast', 'GET', { userId, project });
    expect(res.body.cast.map((c) => c.status)).toEqual(['ready', 'ready']);
    const castId = res.body.cast[0].id;

    res = await call('cast-regen', 'POST', { userId, project, body: { castId, note: 'older' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.cast.status).toBe('pending');
    res = await call('cast-regen', 'POST', { userId, project, body: { castId, note: 'again' } });
    expect(res.statusCode).toBe(409);
    await finishJobs(project.id);

    res = await call('cast-pick', 'POST', { userId, project, body: { castId, candidateIndex: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.body.cast.chosen_index).toBe(2);
  });

  it('answers 402 plan_required for a free account and 409 for a pick with no pictures', async () => {
    accounts.set({ paid: false });
    const free = await newProject();
    let res = await call('cast', 'POST', free);
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toBe('plan_required');
    accounts.set({ paid: true });
    const paid = await newProject();
    await call('cast', 'POST', paid);
    const [row] = await castRows(paid.project.id);
    res = await call('cast-pick', 'POST', { ...paid, body: { castId: row.id, candidateIndex: 0 } });
    expect(res.statusCode).toBe(409);
  });

  it('answers 422 for a missing castId and sends retry:true to the retry rule', async () => {
    const ctx = await readyCast();
    let res = await call('cast-regen', 'POST', { ...ctx, body: { note: 'x' } });
    expect(res.statusCode).toBe(422);
    res = await call('cast-pick', 'POST', { ...ctx, body: { candidateIndex: 0 } });
    expect(res.statusCode).toBe(422);
    res = await call('cast-regen', 'POST', { ...ctx, body: { castId: ctx.cast[0].id, retry: true } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('retry_not_available');
  });
});
