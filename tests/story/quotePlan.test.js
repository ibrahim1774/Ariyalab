// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache, getPricing } from '../../lib/pricing.js';
import { projectFeeFor } from '../../lib/pricingConstants.js';
import { getActionMethods } from '../../lib/story/actions.js';
import { generateCast } from '../../lib/story/cast.js';
import { buildShotList, generateStills } from '../../lib/story/storyboard.js';
import { quotePlan, setPlanRequested } from '../../lib/story/quotePlan.js';
import { tick } from '../../lib/story/runner.js';
import '../../lib/story/actionRoute.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => null),
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

const SCENES = [
  { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }] },
  { id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees and Maya laughs.', lines: [{ speaker: 'narrator', text: 'Then Leo walked in with coffee.' }] },
];

async function newProject({ seconds = 30, funds = 2000, extra = {} } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Plan', style: '3d_family', step: 'script', seconds, quality: 'standard', ...extra });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}

let clock = Date.parse('2026-11-16T12:00:00.000Z');
async function finishJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 6; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}
const available = async (userId) => (await getBalance(userId)).available;
const line = (q, key) => q.lines.find((l) => l.key === key);

describe('quotePlan', () => {
  it('is registered as a story action', () => {
    expect(getActionMethods('quote-plan')).toContain('POST');
  });

  it('before anything is made: the project fee, with the first pictures and the voice and music listed as included', async () => {
    const { userId, project } = await newProject({ seconds: 30 });
    const pricing = await getPricing();
    const q = await quotePlan({ userId, projectId: project.id });
    expect(q.total).toBe(projectFeeFor(pricing, 30));
    expect(q.castFee).toBe(projectFeeFor(pricing, 30));
    expect(line(q, 'fee')).toMatchObject({ credits: q.castFee, included: false });
    for (const key of ['pictures', 'voice', 'music']) expect(line(q, key)).toMatchObject({ credits: 0, included: true });
    expect(q.total).toBe(q.lines.reduce((n, l) => n + l.credits, 0));
  });

  it('uses the short video fee for 10 seconds or less', async () => {
    const { userId, project } = await newProject({ seconds: 7 });
    const pricing = await getPricing();
    const q = await quotePlan({ userId, projectId: project.id });
    expect(q.castFee).toBe(projectFeeFor(pricing, 7));
  });

  it('different people in every scene: no fee in the plan, it is charged with the clips', async () => {
    const { userId, project } = await newProject({ extra: { consistent_cast: false } });
    const q = await quotePlan({ userId, projectId: project.id });
    expect(q.castFee).toBe(0);
    expect(q.total).toBe(0);
    expect(q.total).toBe(0);
  });

  it('different people in every scene: the fee line says when it is charged and how much, and is not in the plan total', async () => {
    const { userId, project } = await newProject({ extra: { consistent_cast: false } });
    const pricing = await getPricing();
    const q = await quotePlan({ userId, projectId: project.id });
    expect(q.feeLater).toBe(projectFeeFor(pricing, 30));
    expect(line(q, 'fee')).toMatchObject({ credits: 0, included: false, later: projectFeeFor(pricing, 30) });
    expect(q.total).toBe(0);
  });

  it('a paid fee has nothing later', async () => {
    const { userId, project } = await newProject({ extra: { consistent_cast: false, fee_charged: true } });
    const q = await quotePlan({ userId, projectId: project.id });
    expect(q.feeLater).toBe(0);
    expect(line(q, 'fee')).toMatchObject({ credits: 0, included: true });
  });

  it('a talking project with narrator lines has the narration line at the same price as a narrated one', async () => {
    const narrated = await newProject();
    const talking = await newProject({ extra: { quality: 'pro_talking', mode: 'talking' } });
    const a = line(await quotePlan({ userId: narrated.userId, projectId: narrated.project.id }), 'voice');
    const b = line(await quotePlan({ userId: talking.userId, projectId: talking.project.id }), 'voice');
    expect(b).toBeDefined();
    expect(b).toEqual(a);
  });

  it('a talking project whose script has only character lines has no narration line', async () => {
    const { userId, project } = await newProject({ extra: { quality: 'pro_talking', mode: 'talking' } });
    await storyDb().update('story_scripts', { project_id: project.id }, { scenes: SCENES.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, speaker: 'Maya' })) })) });
    const q = await quotePlan({ userId, projectId: project.id });
    expect(line(q, 'voice')).toBeUndefined();
  });

  it('equals what the cast start and the picture start then charge', async () => {
    const { userId, project } = await newProject();
    const before = await available(userId);
    const quote = await quotePlan({ userId, projectId: project.id });
    const cast = await generateCast({ userId, projectId: project.id, expectedCredits: quote.castFee });
    expect(cast.charged).toBe(quote.castFee);
    await finishJobs(project.id);
    await buildShotList({ userId, projectId: project.id });
    const after = await quotePlan({ userId, projectId: project.id });
    // The fee is paid: what is left is the pictures.
    expect(after.castFee).toBe(0);
    expect(line(after, 'fee')).toMatchObject({ credits: 0, included: true });
    const stills = await generateStills({ userId, projectId: project.id, expectedCredits: after.stills });
    expect(stills.charged).toBe(after.stills);
    expect(before - (await available(userId))).toBe(quote.castFee + after.stills);
    expect(quote.total).toBe(quote.castFee + quote.stills);
  });

  it('counts pictures that are no longer a first try (the quote the picture start then charges)', async () => {
    const { userId, project } = await newProject();
    await generateCast({ userId, projectId: project.id });
    await finishJobs(project.id);
    await buildShotList({ userId, projectId: project.id });
    const pricing = await getPricing();
    const shots = await storyDb().select('story_shots', { project_id: project.id }, { order: 'ord' });
    await storyDb().update('story_shots', { id: shots[0].id }, { free_still: false });
    const q = await quotePlan({ userId, projectId: project.id });
    expect(q.stills).toBe(pricing.stillReroll);
    expect(line(q, 'pictures')).toMatchObject({ credits: pricing.stillReroll, included: false });
    const done = await generateStills({ userId, projectId: project.id, expectedCredits: q.stills });
    expect(done.charged).toBe(q.stills);
  });

  it('refuses a project that has no script yet', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Empty', step: 'brief' });
    await expect(quotePlan({ userId, projectId: project.id })).rejects.toMatchObject({ status: 409 });
  });
});

describe('plan-request, the marker that the customer pressed "Looks good"', () => {
  const row = async (id) => (await storyDb().select('story_projects', { id }))[0];
  it('is registered, false by default, set and cleared for the owner only', async () => {
    expect(getActionMethods('plan-request')).toContain('POST');
    const { userId, project } = await newProject();
    expect((await row(project.id)).plan_requested).toBe(false);
    expect(await setPlanRequested({ userId, projectId: project.id, requested: true })).toEqual({ plan_requested: true });
    expect((await row(project.id)).plan_requested).toBe(true);
    await setPlanRequested({ userId, projectId: project.id, requested: false });
    expect((await row(project.id)).plan_requested).toBe(false);
    await expect(setPlanRequested({ userId: randomUUID(), projectId: project.id, requested: true })).rejects.toMatchObject({ status: 404 });
    await expect(setPlanRequested({ userId, projectId: project.id, requested: 'yes' })).rejects.toMatchObject({ status: 422 });
  });
});
