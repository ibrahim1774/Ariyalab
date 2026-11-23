// One picture per character (e2e-4): a new round draws ONE picture, the server picks it by itself, the sheet follows, and a
// redraw costs castRegen = 19 (the picture and its sheet). Rounds that already hold 3 options still work.
// Runs with the real defaults (no pricing_config override). tests/story/cast.test.js keeps its multi-picture checks by
// pinning CANDIDATES_PER_CHARACTER to 3 for that file only (the split, the partial failures, the stale resets).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache, getPricing } from '../../lib/pricing.js';
import { registerMock } from '../../lib/providers/mock.js';
import { storyCastMock } from '../../lib/story/mocks.js';
import { CANDIDATES_PER_CHARACTER, candidatePrompt } from '../../lib/story/prompts/cast.js';
import { DEFAULTS } from '../../lib/pricingConstants.js';
import { generateCast, regenerateCharacter, pickCast, castView } from '../../lib/story/cast.js';
import { tick } from '../../lib/story/runner.js';

useRegexOnlyModeration();
useTestAccounts();

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
beforeEach(() => _resetPricingCache());
afterEach(() => registerMock('story_cast', storyCastMock));

const SCENES = [
  { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'Maya', text: 'Nobody believed this would work.' }] },
  { id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees.', lines: [{ speaker: 'Leo', text: 'Move over, I brought coffee.' }] },
];

async function newProject({ funds = 1000 } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'One picture', style: '3d_family', step: 'script' });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}
const castRows = (projectId) => storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' });
const castRow = async (id) => (await storyDb().select('story_cast', { id }))[0];
const jobsOf = (projectId) => storyDb().select('story_jobs', { project_id: projectId, kind: 'cast_image' }, { order: ['created_at', 'id'] });
const candidateJobs = async (projectId, castId, round) => (await jobsOf(projectId)).filter((j) => j.payload.stage === 'candidate' && j.payload.castId === castId && (round == null || j.payload.round === round));
const sheetJobs = async (projectId, castId) => (await jobsOf(projectId)).filter((j) => j.payload.stage === 'sheet' && j.payload.castId === castId);

let clock = Date.parse('2026-11-18T12:00:00.000Z');
async function finishJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 8; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}
async function readyCast() {
  const ctx = await newProject();
  await generateCast({ userId: ctx.userId, projectId: ctx.project.id });
  await finishJobs(ctx.project.id);
  return { ...ctx, cast: await castRows(ctx.project.id) };
}

describe('one picture per character', () => {
  it('draws one picture per character', () => {
    expect(CANDIDATES_PER_CHARACTER).toBe(1);
  });

  it('a new cast queues exactly one picture job per character, with no hold and no charge', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    const rows = await castRows(project.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const jobs = await candidateJobs(project.id, row.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({ stage: 'candidate', slot: 0, round: 1 });
      expect(jobs[0].hold_id).toBeNull();
    }
  });

  it('the picture is picked by itself the moment it is ready, and its sheet is queued and finishes', async () => {
    const { userId, project, cast } = await readyCast();
    for (const row of cast) {
      expect(row.status).toBe('ready');
      expect(row.candidates).toHaveLength(1);
      expect(row).toMatchObject({ chosen_index: 0, image_url: row.candidates[0].url, image_key: row.candidates[0].key });
      const sheets = await sheetJobs(project.id, row.id);
      expect(sheets).toHaveLength(1);
      expect(sheets[0].payload).toMatchObject({ fromKey: row.candidates[0].key, refs: [row.candidates[0].url] });
      expect(row.sheet.url).toBeTruthy();
    }
    // Only the project fee was ever spent.
    expect((await getBalance(userId)).held).toBe(0);
  });

  it('a free redraw makes one picture, and that one is picked and gets a sheet too', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'a red cap' });
    expect(out.charged).toBe(0);
    expect(await candidateJobs(project.id, id, 2)).toHaveLength(1);
    await finishJobs(project.id);
    const row = await castRow(id);
    expect(row).toMatchObject({ round: 2, status: 'ready', chosen_index: 0, regens_used: 1 });
    expect(row.candidates).toHaveLength(1);
    expect(row.image_key).toBe(row.candidates[0].key);
    expect((await sheetJobs(project.id, id)).filter((j) => j.payload.round === 2)).toHaveLength(1);
  });

  it('a redraw with a character that used its own picture still gets the new picture picked by itself', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const [asset] = await storyDb().insert('story_assets', { user_id: userId, kind: 'image', url: '/own/maya.png' });
    await storyDb().update('story_cast', { id }, { asset_id: asset.id, image_url: '/own/maya.png', image_key: null, chosen_index: null });
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'again' });
    await finishJobs(project.id);
    const row = await castRow(id);
    expect(row.asset_id).toBeNull();
    expect(row).toMatchObject({ chosen_index: 0, status: 'ready' });
    expect(row.image_key).toBe(row.candidates[0].key);
  });

  it('a character whose redraw was refused or failed to queue keeps its own picture', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const [asset] = await storyDb().insert('story_assets', { user_id: userId, kind: 'image', url: '/own/maya.png' });
    await storyDb().update('story_cast', { id }, { asset_id: asset.id, image_url: '/own/maya.png', image_key: null, chosen_index: null });
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x', expectedCredits: 7 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    expect(await castRow(id)).toMatchObject({ asset_id: asset.id, image_url: '/own/maya.png' });
  });
});

describe('a redraw costs 19', () => {
  it('prices the redraw at castRegen = 19 after the 2 included ones, on the row and in the quote', async () => {
    const { castRegen } = await getPricing();
    expect(castRegen).toBe(19);
    expect(DEFAULTS.castRegen).toBe(19);
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    expect((await castView(await castRows(project.id)))[0]).toMatchObject({ regens_used: 0, regen_credits: 0 });
    for (const n of [1, 2]) {
      expect((await regenerateCharacter({ userId, projectId: project.id, castId: id, expectedCredits: 0 })).charged).toBe(0);
      await finishJobs(project.id);
      expect((await castRow(id)).regens_used).toBe(n);
    }
    const view = (await castView(await castRows(project.id)))[0];
    expect(view).toMatchObject({ regens_used: 2, regen_credits: 19 });
    // A different number than the quote is 409 and nothing happens.
    const before = await getBalance(userId);
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, expectedCredits: 38 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    expect(await getBalance(userId)).toEqual(before);
    expect((await castRow(id)).regens_used).toBe(2);
  });

  it('holds 19 on the one picture job, settles it when the picture arrives, and the other character keeps its free redraws', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    await storyDb().update('story_cast', { id }, { regens_used: 2 });
    const balance = (await getBalance(userId)).available;
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'older', expectedCredits: 19 });
    expect(out.charged).toBe(19);
    expect((await getBalance(userId)).held).toBe(19);
    const round = (await castRow(id)).round;
    const jobs = await candidateJobs(project.id, id, round);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].cost_credits).toBe(19);
    await finishJobs(project.id);
    expect((await getBalance(userId)).held).toBe(0);
    expect((await getBalance(userId)).available).toBe(balance - 19);
    const other = await regenerateCharacter({ userId, projectId: project.id, castId: cast[1].id, note: 'free' });
    expect(other.charged).toBe(0);
  });

  it('a paid redraw that fails gives the 19 back (a character with no picture stays failed; one with a picture gets it back: castFromPicture.test.js)', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    await storyDb().update('story_cast', { id }, { candidates: [], image_url: null, image_key: null, chosen_index: null, sheet: {}, previous: null });
    await storyDb().update('story_cast', { id }, { regens_used: 2 });
    const balance = (await getBalance(userId)).available;
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x [[mock:fail]]' });
    await finishJobs(project.id);
    expect(await castRow(id)).toMatchObject({ status: 'failed', round_credits: 19 });
    expect((await getBalance(userId)).held).toBe(0);
    expect((await getBalance(userId)).available).toBe(balance);
  });
});

describe('a round that already holds 3 options', () => {
  it('can still be picked among, and its sheet follows', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const three = [0, 1, 2].map((slot) => ({ slot, url: `/api/mock/storage/story/old/${slot}.png`, key: `story/old/${slot}.png`, prompt: 'p' }));
    await storyDb().update('story_cast', { id }, { candidates: three, chosen_index: null, image_url: null, image_key: null, sheet: {}, status: 'ready' });
    const out = await pickCast({ userId, projectId: project.id, castId: id, candidateIndex: 2 });
    expect(out.cast).toMatchObject({ chosen_index: 2, image_key: 'story/old/2.png' });
    const sheets = (await sheetJobs(project.id, id)).filter((j) => j.payload.fromKey === 'story/old/2.png');
    expect(sheets).toHaveLength(1);
    expect(sheets[0].payload.refs).toEqual(['/api/mock/storage/story/old/2.png']);
  });

  it('the prompt of slot 0 is the plain everyday look; the other slots keep their different takes', () => {
    const base = { style: 'soft light', name: 'Maya', description: 'A young barber.' };
    expect(candidatePrompt({ ...base, slot: 0 })).toMatch(/everyday look/);
    expect(candidatePrompt({ ...base, slot: 1 })).toMatch(/different take/);
  });
});
