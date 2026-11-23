// "Make them look like a picture" (e2e-4): the customer picks one of their own pictures, and ONE new picture of the character is
// drawn in the project's style with it as a reference, then the sheet. Always paid (castFromPicture = 19), held first and settled
// when the picture comes out, never counted against the free redraws.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, InsufficientCreditsError } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache, getPricing } from '../../lib/pricing.js';
import { registerMock } from '../../lib/providers/mock.js';
import { storyCastMock } from '../../lib/story/mocks.js';
import { generateCast, regenerateCharacter, drawLikePicture, castView } from '../../lib/story/cast.js';
import { castImageHandler } from '../../lib/story/castJobs.js';
import { handleAction } from '../../lib/story/actionRoute.js';
import { tick } from '../../lib/story/runner.js';
import { candidatePrompt } from '../../lib/story/prompts/cast.js';
import { buildImageRequest } from '../../lib/providers/image.js';
import { FORBIDDEN_NAMES } from '../../lib/story/script.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__lookTestSession ?? null),
}));

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
afterEach(() => {
  registerMock('story_cast', storyCastMock);
  globalThis.__lookTestSession = null;
  vi.restoreAllMocks();
});

const SCENES = [
  { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'Maya', text: 'Nobody believed this would work.' }] },
  { id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees.', lines: [{ speaker: 'Leo', text: 'Move over, I brought coffee.' }] },
];

async function newProject({ funds = 1000 } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Look alike', style: '3d_family', step: 'script' });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}
const castRows = (projectId) => storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' });
const castRow = async (id) => (await storyDb().select('story_cast', { id }))[0];
const jobsOf = (projectId) => storyDb().select('story_jobs', { project_id: projectId, kind: 'cast_image' }, { order: ['created_at', 'id'] });
const candidateJobs = async (projectId, castId, round) => (await jobsOf(projectId)).filter((j) => j.payload.stage === 'candidate' && j.payload.castId === castId && (round == null || j.payload.round === round));
const sheetJobs = async (projectId, castId) => (await jobsOf(projectId)).filter((j) => j.payload.stage === 'sheet' && j.payload.castId === castId);
const addAsset = async (userId, patch = {}) => (await storyDb().insert('story_assets', { user_id: userId, kind: 'image', url: `/api/mock/storage/own/${randomUUID()}.png`, storage_key: `own/${randomUUID()}.png`, ...patch }))[0];

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
// A character with no picture yet (a first draw): a failed round has nothing to put back, so it stays failed and Try again applies.
const noPicture = (id) => storyDb().update('story_cast', { id }, { candidates: [], image_url: null, image_key: null, chosen_index: null, sheet: {}, previous: null });
const snapshot = async (userId, projectId) => ({ balance: await getBalance(userId), rows: await castRows(projectId), jobs: (await jobsOf(projectId)).length });

describe('the price', () => {
  it('is 19, on every character row, whether or not free redraws are left, from the same code that charges', async () => {
    const { project, cast } = await readyCast();
    expect((await getPricing()).castFromPicture).toBe(19);
    let view = await castView(await castRows(project.id));
    expect(view.map((c) => [c.regen_credits, c.look_credits])).toEqual([[0, 19], [0, 19]]);
    await storyDb().update('story_cast', { id: cast[0].id }, { regens_used: 2 });
    view = await castView(await castRows(project.id));
    expect(view.map((c) => [c.regen_credits, c.look_credits])).toEqual([[19, 19], [0, 19]]);
  });

  it('follows a saved pricing_config row', async () => {
    const { userId, project, cast } = await readyCast();
    await raw.query(`insert into pricing_config (key, value) values ('castFromPicture', '25'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const asset = await addAsset(userId);
      expect((await castView(await castRows(project.id)))[0].look_credits).toBe(25);
      await expect(drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id, expectedCredits: 19 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
      expect((await drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id, expectedCredits: 25 })).charged).toBe(25);
    } finally {
      await raw.query(`delete from pricing_config where key = 'castFromPicture'`);
      _resetPricingCache();
    }
  });
});

describe('drawing a character to look like a picture', () => {
  it('holds 19, queues one picture job with the picture as its reference, and leaves the free redraws alone', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    const out = await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'a bit older', expectedCredits: 19 });
    expect(out.charged).toBe(19);
    expect((await getBalance(userId)).held).toBe(19);
    expect((await getBalance(userId)).available).toBe(balance.available - 19);
    const row = await castRow(id);
    expect(row).toMatchObject({ status: 'pending', round: 2, regens_used: 0, round_credits: 19, look_asset_id: asset.id });
    const jobs = await candidateJobs(project.id, id, 2);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cost_credits: 19 });
    expect(jobs[0].hold_id).toBeTruthy();
    expect(jobs[0].payload).toMatchObject({ refs: [asset.url], refAssetId: asset.id, note: 'a bit older', retryTransient: true });
    expect(jobs[0].payload.prompt).toMatch(/reference picture/i);
    expect(jobs[0].payload.prompt).toMatch(/a bit older/);
    // The view says it, and the picture of the round is the one the customer chose.
    expect(out.cast).toMatchObject({ look_asset_id: asset.id, status: 'pending' });
  });

  it('settles the 19 when the picture comes out, picks it by itself and draws the sheet from it', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, expectedCredits: 19 });
    await finishJobs(project.id);
    const row = await castRow(id);
    expect(row).toMatchObject({ status: 'ready', chosen_index: 0, look_asset_id: asset.id, regens_used: 0 });
    expect(row.candidates).toHaveLength(1);
    expect(row.image_key).toBe(row.candidates[0].key);
    expect(row.sheet.url).toBeTruthy();
    const sheets = (await sheetJobs(project.id, id)).filter((j) => j.payload.fromKey === row.image_key);
    expect(sheets).toHaveLength(1);
    // The sheet is made from the drawn picture, not from the customer's picture, and costs the customer nothing more.
    expect(sheets[0].payload.refs).toEqual([row.image_url]);
    expect(sheets[0].cost_credits).toBeNull();
    const after = await getBalance(userId);
    expect(after.held).toBe(0);
    expect(after.available).toBe(balance.available - 19);
  });

  it('is always paid: it charges 19 even while free redraws are left, and never uses one up', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    expect((await castRow(id)).regens_used).toBe(0);
    const asset = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id });
    await finishJobs(project.id);
    expect((await castRow(id)).regens_used).toBe(0);
    // The two free redraws are still there afterwards.
    for (const n of [1, 2]) {
      expect((await regenerateCharacter({ userId, projectId: project.id, castId: id, note: `free ${n}` })).charged).toBe(0);
      await finishJobs(project.id);
    }
    expect((await castRow(id)).regens_used).toBe(2);
    // ... and a plain redraw clears the look-alike mark (it is a new picture of the same description).
    expect((await castRow(id)).look_asset_id).toBeNull();
    // A paid redraw costs 19 as well; the look-alike costs 19 beside it, not instead of anything.
    expect((await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'paid' })).charged).toBe(19);
  });

  it('a different price than the quote is 409 quote_changed and nothing happens', async () => {
    const { userId, project, cast } = await readyCast();
    const asset = await addAsset(userId);
    const before = await snapshot(userId, project.id);
    await expect(drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id, expectedCredits: 0 }))
      .rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    await expect(drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id, expectedCredits: 38 }))
      .rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    await expect(drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id, expectedCredits: 1.5 }))
      .rejects.toMatchObject({ status: 422 });
    expect(await snapshot(userId, project.id)).toEqual(before);
  });

  it('refuses a picture that is not the customer\'s own, one that is not a picture, and a missing one', async () => {
    const { userId, project, cast } = await readyCast();
    const stranger = await addAsset(randomUUID());
    const video = await addAsset(userId, { kind: 'video_clip', url: '/own/clip.mp4' });
    const before = await snapshot(userId, project.id);
    for (const assetId of [stranger.id, randomUUID(), 'not-an-id', undefined, null]) {
      await expect(drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId })).rejects.toMatchObject({ status: 404 });
    }
    await expect(drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: video.id })).rejects.toMatchObject({ status: 422 });
    expect(await snapshot(userId, project.id)).toEqual(before);
  });

  it('accepts the picture kinds a character may use (image, mascot, product photo, logo)', async () => {
    const { userId, project, cast } = await readyCast();
    const [first, second] = cast;
    const mascot = await addAsset(userId, { kind: 'mascot' });
    const out = await drawLikePicture({ userId, projectId: project.id, castId: first.id, assetId: mascot.id, expectedCredits: 19 });
    expect(out.cast.look_asset_id).toBe(mascot.id);
    for (const kind of ['product_photo', 'logo', 'image']) {
      const asset = await addAsset(userId, { kind });
      await storyDb().update('story_cast', { id: second.id }, { status: 'ready' });
      await finishJobs(project.id);
      expect((await drawLikePicture({ userId, projectId: project.id, castId: second.id, assetId: asset.id })).cast.look_asset_id).toBe(asset.id);
      await finishJobs(project.id);
    }
  });

  it('is refused while the character is still being drawn, with the same 409 as using your own image', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'one' });
    expect((await castRow(id)).status).toBe('pending');
    const before = await snapshot(userId, project.id);
    await expect(drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(userId, project.id)).toEqual(before);
    await storyDb().update('story_cast', { id }, { status: 'draft' });
    await expect(drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id })).rejects.toMatchObject({ status: 409 });
  });

  it('without enough credits it is a 402, nothing is held and the character keeps its picture', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    // Leave 10 credits.
    const spend = balance.available - 10;
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId, currency: 'video', amount: spend, reason: 'test_drain', ref: randomUUID() });
    const earlier = await addAsset(userId);
    await storyDb().update('story_cast', { id }, { look_asset_id: earlier.id });
    const before = await castRow(id);
    await expect(drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, expectedCredits: 19 })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await getBalance(userId)).held).toBe(0);
    const after = await castRow(id);
    expect(after).toMatchObject({ status: 'ready', chosen_index: before.chosen_index, image_key: before.image_key, look_asset_id: earlier.id, regens_used: before.regens_used });
    expect(after.candidates).toEqual(before.candidates);
    expect(await candidateJobs(project.id, id, after.round)).toHaveLength(0);
  });

  it('a failed picture gives the 19 back, and Try again holds it once more with the same picture', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    await noPicture(id);
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'x [[mock:fail]]' });
    await finishJobs(project.id);
    expect(await castRow(id)).toMatchObject({ status: 'failed', round_credits: 19, look_asset_id: asset.id });
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: balance.available });
    expect((await castView(await castRows(project.id)))[0].retry_credits).toBe(19);
    // Try again: the price again, the same picture as the reference, the note again, and no free redraw used.
    const retry = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true, expectedCredits: 19 });
    expect(retry.charged).toBe(19);
    const round = (await castRow(id)).round;
    const [job] = await candidateJobs(project.id, id, round);
    expect(job.payload).toMatchObject({ refs: [asset.url], refAssetId: asset.id });
    expect((await castRow(id))).toMatchObject({ look_asset_id: asset.id, regens_used: 0 });
  });

  it('a blocked picture gives the 19 back and the character shows the block', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    await noPicture(id);
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'x [[mock:blocked]]' });
    expect((await getBalance(userId)).held).toBe(19);
    await finishJobs(project.id);
    expect(await castRow(id)).toMatchObject({ status: 'blocked', round_credits: 19 });
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: balance.available });
  });

  it('Try again after a reset of a dead start still draws from the picture, and says so when the picture is gone', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    await noPicture(id);
    const asset = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'x [[mock:fail]]' });
    await finishJobs(project.id);
    // The failed round's job is gone (a reset of a dead start takes its jobs out); the row still names the picture.
    await storyDb().remove('story_jobs', { project_id: project.id, kind: 'cast_image', status: 'failed' });
    expect(await castRow(id)).toMatchObject({ status: 'failed', look_asset_id: asset.id });
    const retry = await regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true, expectedCredits: 19 });
    expect(retry.charged).toBe(19);
    const [job] = await candidateJobs(project.id, id, (await castRow(id)).round);
    expect(job.payload.refs).toEqual([asset.url]);
    await finishJobs(project.id);

    // The picture was deleted after a failure: nothing is charged and the customer is told to choose again.
    const gone = await addAsset(userId);
    await storyDb().update('story_cast', { id }, { regens_used: 0 });
    await noPicture(id);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: gone.id, note: 'y [[mock:fail]]' });
    await finishJobs(project.id);
    await storyDb().remove('story_assets', { id: gone.id });
    const before = await snapshot(userId, project.id);
    await expect(regenerateCharacter({ userId, projectId: project.id, castId: id, retry: true })).rejects.toMatchObject({ status: 409, code: 'look_picture_gone' });
    expect(await snapshot(userId, project.id)).toEqual(before);
  });

  it('one automatic retry of a provider hiccup never charges twice', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    let polls = 0;
    const realPoll = castImageHandler.poll;
    vi.spyOn(castImageHandler, 'poll').mockImplementation(async (job) => {
      if (job.payload.stage === 'candidate' && polls++ === 0) return { status: 'failed', url: null, error: 'Generation failed. Please try again.', transient: true };
      return realPoll(job);
    });
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, expectedCredits: 19 });
    await finishJobs(project.id);
    expect(polls).toBeGreaterThan(0);
    const [job] = await candidateJobs(project.id, id, 2);
    expect(job.payload).toMatchObject({ retried: true, refs: [asset.url] });
    expect(await castRow(id)).toMatchObject({ status: 'ready', chosen_index: 0 });
    const after = await getBalance(userId);
    expect(after.held).toBe(0);
    expect(after.available).toBe(balance.available - 19);
  });

  it('a character that used its own picture is drawn from the new reference and picked by itself', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const own = await addAsset(userId);
    await storyDb().update('story_cast', { id }, { asset_id: own.id, image_url: own.url, image_key: own.storage_key, chosen_index: null });
    const look = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: look.id });
    await finishJobs(project.id);
    const row = await castRow(id);
    expect(row).toMatchObject({ asset_id: null, look_asset_id: look.id, chosen_index: 0, status: 'ready' });
  });

  it('works through the cast-look action, with the price checked (expected_credits)', async () => {
    const { userId, project, cast } = await readyCast();
    const asset = await addAsset(userId);
    const call = async (body) => {
      const res = makeRes();
      await handleAction(makeReq({ method: 'POST', body, query: { id: project.id } }), res, 'cast-look');
      return res;
    };
    globalThis.__lookTestSession = { user: { id: userId, email: 'test@example.test' } };
    const bad = await call({ castId: cast[0].id, assetId: asset.id, expected_credits: 5 });
    expect(bad.statusCode).toBe(409);
    expect(bad.body).toMatchObject({ error: 'quote_changed' });
    const ok = await call({ castId: cast[0].id, assetId: asset.id, expected_credits: 19, note: 'curly hair' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatchObject({ charged: 19, cast: { id: cast[0].id, look_asset_id: asset.id } });
    const missing = await call({ assetId: asset.id });
    expect(missing.statusCode).toBe(422);
  });
});

describe('the picture the model is asked for', () => {
  const base = { style: 'soft light', name: 'Maya', description: 'A young barber.' };
  it('says to look like the reference picture, in the project style, and never names a studio, character or person', () => {
    const text = candidatePrompt({ ...base, slot: 0, fromPicture: true, note: 'a bit older' });
    expect(text).toMatch(/look like the reference picture/i);
    expect(text).toMatch(/soft light/);
    expect(text).toMatch(/a bit older/);
    const plain = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    for (const name of FORBIDDEN_NAMES) expect(plain, name).not.toContain(` ${name.replace(/[^a-z0-9]+/g, ' ')} `);
    expect(candidatePrompt({ ...base, slot: 0 })).not.toMatch(/reference picture/i);
  });
  it('the picture request carries the customer\'s picture as its reference', () => {
    const req = buildImageRequest({ prompt: 'p', refs: ['https://files.example/own.png'] });
    expect(JSON.stringify(req)).toContain('https://files.example/own.png');
  });
});

// ---------------------------------------------------------------- review round 1

describe('a refused or failed new picture never costs the character it had (I1)', () => {
  async function drawnCharacter() {
    const ctx = await readyCast();
    const id = ctx.cast[0].id;
    const before = await castRow(id);
    expect(before.sheet.url).toBeTruthy();
    return { ...ctx, id, before };
  }
  const stillThere = (before, row) => {
    expect(row).toMatchObject({
      status: 'ready', chosen_index: before.chosen_index, image_url: before.image_url, image_key: before.image_key, asset_id: before.asset_id,
      regens_used: before.regens_used, style_stale: false, round_credits: 0,
    });
    expect(row.candidates).toEqual(before.candidates);
    expect(row.sheet).toEqual(before.sheet);
  };

  it('a blocked look-alike puts the old picture and sheet back, releases the 19, marks nothing stale, and says so', async () => {
    const { userId, project, id, before } = await drawnCharacter();
    const asset = await addAsset(userId);
    const balance = await getBalance(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'x [[mock:blocked]]' });
    expect((await castRow(id)).status).toBe('pending');
    await finishJobs(project.id);
    const row = await castRow(id);
    stillThere(before, row);
    expect(row.look_asset_id).toBeNull();
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: balance.available });
    const view = (await castView(await castRows(project.id)))[0];
    expect(view).toMatchObject({ id, kept_picture: true, retry_credits: 0, status: 'ready' });
    expect(view.previous).toBeUndefined();
    // No scene picture was marked out of date, and the character is not asked for a pick.
    expect((await storyDb().select('story_shots', { project_id: project.id })).filter((s) => s.stale)).toHaveLength(0);
  });

  it('a failed look-alike does the same, and the mark goes when the next round starts', async () => {
    const { userId, project, id, before } = await drawnCharacter();
    const asset = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'x [[mock:fail]]' });
    await finishJobs(project.id);
    stillThere(before, await castRow(id));
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'again' });
    await finishJobs(project.id);
    expect((await castView(await castRows(project.id)))[0].kept_picture).toBe(false);
  });

  it('a paid redraw that fails puts the character back and gives the 19 back', async () => {
    const { userId, project, id } = await drawnCharacter();
    await storyDb().update('story_cast', { id }, { regens_used: 2 });
    const before = await castRow(id);
    const balance = await getBalance(userId);
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x [[mock:fail]]' });
    await finishJobs(project.id);
    stillThere(before, await castRow(id));
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: balance.available });
  });

  it('a free redraw that fails puts the character back and gives the free redraw back', async () => {
    const { userId, project, id } = await drawnCharacter();
    const before = await castRow(id);
    await regenerateCharacter({ userId, projectId: project.id, castId: id, note: 'x [[mock:fail]]' });
    expect((await castRow(id)).regens_used).toBe(1);
    await finishJobs(project.id);
    stillThere(before, await castRow(id));
    expect((await castRow(id)).regens_used).toBe(0);
  });

  it('a first draw that fails is unchanged: failed, nothing to put back, Try again as before', async () => {
    const ctx = await newProject();
    await storyDb().update('story_scripts', { project_id: ctx.project.id }, { scenes: [{ ...SCENES[0], visual: `${SCENES[0].visual} [[mock:fail]]` }, SCENES[1]] });
    await generateCast({ userId: ctx.userId, projectId: ctx.project.id });
    await finishJobs(ctx.project.id);
    const [maya] = await castRows(ctx.project.id);
    expect(maya).toMatchObject({ status: 'failed', previous: null });
    expect((await castView([maya]))[0].kept_picture).toBe(false);
  });

  it('a late picture of the new round after the restore changes nothing (the round is the same, the row is ready)', async () => {
    const { userId, project, id, before } = await drawnCharacter();
    const asset = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id, note: 'x [[mock:blocked]]' });
    await finishJobs(project.id);
    await finishJobs(project.id);
    stillThere(before, await castRow(id));
  });
});

describe('the likeness survives a style change (M1)', () => {
  it('keeps the look-alike picture through the reset and draws the new style from it, at the redraw price', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: id, assetId: asset.id });
    await finishJobs(project.id);
    const { updateProject } = await import('../../lib/story/projects.js');
    const asked = await updateProject({ userId, id: project.id, patch: { style: 'anime' } }).catch((e) => e);
    expect(asked.code).toBe('quote_changed');
    await updateProject({ userId, id: project.id, patch: { style: 'anime' }, expectedCredits: asked.extra.credits });
    expect(await castRow(id)).toMatchObject({ image_url: null, look_asset_id: asset.id, style_stale: true, candidates: [] });
    const balance = await getBalance(userId);
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: id });
    expect(out.charged).toBe(0); // the free redraws of the character, not the look-alike price
    const [job] = await candidateJobs(project.id, id, (await castRow(id)).round);
    expect(job.payload).toMatchObject({ refs: [asset.url], refAssetId: asset.id });
    expect(job.payload.prompt).toMatch(/reference picture/i);
    expect((await castRow(id)).look_asset_id).toBe(asset.id);
    await finishJobs(project.id);
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: balance.available });
    expect(await castRow(id)).toMatchObject({ status: 'ready', style_stale: false, look_asset_id: asset.id });
  });

  it('when the picture is gone it is drawn from the description as before', async () => {
    const { userId, project, cast } = await readyCast();
    const id = cast[0].id;
    const asset = await addAsset(userId);
    await storyDb().update('story_cast', { id }, { look_asset_id: asset.id, candidates: [], image_url: null, image_key: null, chosen_index: null, sheet: {}, style_stale: true });
    await storyDb().remove('story_assets', { id: asset.id });
    await regenerateCharacter({ userId, projectId: project.id, castId: id });
    const [job] = await candidateJobs(project.id, id, (await castRow(id)).round);
    expect(job.payload.refs).toBeUndefined();
    expect((await castRow(id)).look_asset_id).toBeNull();
  });
});

describe('the reference picture is in use while it is being drawn from (M3)', () => {
  it('cannot be deleted while the round is pending, can once the character is finished', async () => {
    const { deleteAsset } = await import('../../lib/story/assets.js');
    const { userId, project, cast } = await readyCast();
    const asset = await addAsset(userId);
    await drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id });
    await expect(deleteAsset({ userId, assetId: asset.id })).rejects.toMatchObject({ status: 409, code: 'asset_in_use' });
    await finishJobs(project.id);
    expect((await storyDb().select('story_assets', { id: asset.id })).length).toBe(1);
    await deleteAsset({ userId, assetId: asset.id });
    expect((await storyDb().select('story_assets', { id: asset.id })).length).toBe(0);
    expect((await castRow(cast[0].id)).look_asset_id).toBeNull();
  });
});

describe('server floors on the look-alike (M5, M6)', () => {
  it('a hosted castFromPicture of 0 still charges 1 credit, on the row and on the charge', async () => {
    const { userId, project, cast } = await readyCast();
    await raw.query(`insert into pricing_config (key, value) values ('castFromPicture', '0'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const asset = await addAsset(userId);
      expect((await castView(await castRows(project.id)))[0].look_credits).toBe(1);
      expect((await drawLikePicture({ userId, projectId: project.id, castId: cast[0].id, assetId: asset.id, expectedCredits: 1 })).charged).toBe(1);
    } finally {
      await raw.query(`delete from pricing_config where key = 'castFromPicture'`);
      _resetPricingCache();
    }
  });

  it('the cast-look route needs expected_credits', async () => {
    const { userId, project, cast } = await readyCast();
    const asset = await addAsset(userId);
    globalThis.__lookTestSession = { user: { id: userId, email: 'test@example.test' } };
    const res = makeRes();
    await handleAction(makeReq({ method: 'POST', body: { castId: cast[0].id, assetId: asset.id }, query: { id: project.id } }), res, 'cast-look');
    expect(res.statusCode).toBe(422);
    expect(res.body.message).toMatch(/price/i);
    expect(await candidateJobs(project.id, cast[0].id, 2)).toHaveLength(0);
  });
});
