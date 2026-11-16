// Task 28: the whole maker, end to end, in mock mode against PGlite.
// Every step goes through the HTTP route the maker's client (lib/story/client.js) calls, as the signed-in customer;
// the background work runs through the worker routes (with the cron secret) and the runner tick the cron makes.
// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';

let currentUser = null;
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => (currentUser ? { user: currentUser, supabase: {} } : null)),
  getSupabaseAdmin: () => {
    throw new Error('service-role client must not be used in tests');
  },
}));

const { setStoryDb, storyDb } = await import('../../lib/story/db.js');
const { setCreditsDb, grantCredits, getBalance } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache, getPricing } = await import('../../lib/pricing.js');
const { tick } = await import('../../lib/story/runner.js');
const { localPathFor } = await import('../../lib/providers/storage.js');

// The routes, as Next serves them: the static files win over [action].js.
const projectsRoute = (await import('../../pages/api/story/projects/index.js')).default;
const actionRoute = (await import('../../pages/api/story/projects/[id]/[action].js')).default;
const STATIC_ROUTES = {
  script: (await import('../../pages/api/story/projects/[id]/script.js')).default,
  cast: (await import('../../pages/api/story/projects/[id]/cast.js')).default,
  shots: (await import('../../pages/api/story/projects/[id]/shots.js')).default,
  analyze: (await import('../../pages/api/story/projects/[id]/analyze.js')).default,
  status: (await import('../../pages/api/story/projects/[id]/status.js')).default,
};
const WORKERS = {
  analyze: (await import('../../pages/api/story/worker/analyze.js')).default,
  audio: (await import('../../pages/api/story/worker/audio.js')).default,
  render: (await import('../../pages/api/story/render-worker.js')).default,
};

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

beforeEach(() => {
  _resetPricingCache();
  currentUser = null;
});

// ---------------------------------------------------------------- the routes

/** A maker request: method + /api/story path under the project. -> { status, body } (throws on a non-2xx answer) */
async function api(method, projectId, action, body = {}) {
  const res = makeRes();
  const handler = projectId === null ? projectsRoute : STATIC_ROUTES[action] || actionRoute;
  const query = projectId === null ? {} : { id: projectId, action };
  await handler(makeReq({ method, body, query }), res);
  if (res.statusCode >= 300) throw new Error(`${method} ${action ?? 'projects'} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** What the cron or the queuing action does: kicks a worker route with the cron secret. -> its JSON answer */
async function kick(worker) {
  const res = makeRes();
  await WORKERS[worker](makeReq({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), res);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

let clock = Date.parse('2026-11-16T12:00:00.000Z');
/** What the every-minute cron does between the maker's polls: runs this project's queued and running jobs (mock providers). */
async function runJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 8; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}

const newUser = () => ({ id: randomUUID(), email: `e2e-${randomUUID().slice(0, 8)}@example.test`, email_confirmed_at: '2026-01-01T00:00:00.000Z' });
const fund = (userId, amount) => grantCredits({ userId, currency: 'video', amount, bucket: 'topup', reason: 'test', ref: randomUUID() });
const spent = async (userId) => {
  const { rows } = await raw.query(`select coalesce(sum(amount), 0)::int as n from credit_ledger where user_id = $1 and op in ('settle', 'spend')`, [userId]);
  return rows[0].n;
};
const sumOf = (list, field) => list.reduce((n, x) => n + (Number.isInteger(x[field]) ? x[field] : 0), 0);

// ---------------------------------------------------------------- the pipeline

/**
 * script -> cast -> pick -> shots -> stills -> quote -> generate -> narration -> music -> render, through the routes.
 * -> { quote, fee }   what the customer was charged for
 */
async function makeVideo(projectId) {
  const pricing = await getPricing();

  const { script } = await api('POST', projectId, 'script');
  expect(script.scenes.length).toBeGreaterThan(0);
  expect(script.violations).toEqual([]);

  // The cast: the project fee, once; then three pictures per character.
  const cast = await api('POST', projectId, 'cast');
  expect(cast.charged).toBe(pricing.projectFee);
  expect(cast.cast.length).toBeGreaterThan(0);
  await runJobs(projectId);
  let status = await api('GET', projectId, 'status');
  expect(status.cast.every((c) => c.status === 'ready'), JSON.stringify(status.cast)).toBe(true);
  for (const c of status.cast) await api('POST', projectId, 'cast-pick', { castId: c.id, candidateIndex: 0 });

  // The storyboard: the shot list, then the pictures at the price on the button.
  const { shots } = await api('POST', projectId, 'shots');
  expect(shots.length).toBeGreaterThan(0);
  const stills = await api('POST', projectId, 'stills', { expected_credits: sumOf(shots, 'still_credits') });
  expect(stills.charged).toBe(sumOf(shots, 'still_credits'));
  await runJobs(projectId);
  status = await api('GET', projectId, 'status');
  expect(status.shots.every((s) => s.still_url), JSON.stringify(status.shots.map((s) => s.status))).toBe(true);

  // The clips: the quote, then the confirmed total.
  const quote = await api('POST', projectId, 'quote');
  expect(quote.total).toBeGreaterThan(0);
  const generated = await api('POST', projectId, 'generate', { shotIds: quote.shotIds, confirmTotal: quote.total });
  expect(generated.charged).toBe(quote.total);
  await runJobs(projectId);
  status = await api('GET', projectId, 'status');
  expect(status.shots.every((s) => s.clip_url), JSON.stringify(status.shots.map((s) => s.status))).toBe(true);

  // Voice and music (included makes), made by the audio worker.
  const { audio } = await api('GET', projectId, 'audio');
  const narration = await api('POST', projectId, 'narration', { expected_credits: audio.narration.credits ?? 0 });
  const music = await api('POST', projectId, 'music', { expected_credits: audio.music.credits ?? 0 });
  expect(narration.charged + music.charged).toBe(0);
  expect(await kick('audio')).toMatchObject({ narration: 1, music: 1 });
  status = await api('GET', projectId, 'status');
  expect(status.audio.narration.status).toBe('ready');
  expect(status.audio.music.status).toBe('ready');

  // Captions on, then the video, put together by the render worker.
  await api('POST', projectId, 'audio', { plan: { captions: { on: true } } });
  await api('POST', projectId, 'render');
  expect(await kick('render')).toMatchObject({ render: 1 });
  return { quote, fee: pricing.projectFee };
}

/** The four things a finished video must leave behind. */
async function expectFinished({ user, projectId, quote, fee }) {
  // A render row with a URL, and the file is really there.
  const renders = await storyDb().select('story_renders', { project_id: projectId });
  expect(renders).toHaveLength(1);
  expect(renders[0]).toMatchObject({ status: 'done', error: null });
  expect(renders[0].file_url).toMatch(new RegExp(`^/api/mock/storage/story/${projectId}/render/.+\\.mp4$`));
  const file = localPathFor(renders[0].file_url);
  expect(existsSync(file)).toBe(true);
  expect(statSync(file).size).toBeGreaterThan(1000);
  const status = await api('GET', projectId, 'status');
  expect(status.render).toMatchObject({ status: 'done' });
  expect(status.project.step).toBe('done');

  // Nothing held, and the ledger is the fee plus the confirmed quote, nothing else.
  expect((await getBalance(user.id)).held).toBe(0);
  expect(await spent(user.id)).toBe(fee + quote.total);

  // No job left queued or running.
  const jobs = await storyDb().select('story_jobs', { project_id: projectId });
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs.filter((j) => j.status === 'queued' || j.status === 'running')).toEqual([]);
}

describe('the maker end to end (mock providers, PGlite)', () => {
  it('goes from a brief to a finished narrated video through the routes', async () => {
    const user = newUser();
    currentUser = user;
    await fund(user.id, 3000);

    const { project } = await api('POST', null, null, {
      title: 'Barber app', purpose: 'app', offer: 'A booking app for barbers', audience: 'Busy barbers',
      style: '3d_family', seconds: 15, quality: 'standard', mode: 'narrated',
    });
    const done = await makeVideo(project.id);
    await expectFinished({ user, projectId: project.id, ...done });
  }, 240_000);

  it('does the same starting from the fixture reference video', async () => {
    const user = newUser();
    currentUser = user;
    await fund(user.id, 3000);

    const { project } = await api('POST', null, null, {
      title: 'Bakery reel', purpose: 'app', offer: 'A booking app for bakeries', audience: 'Small bakeries',
      style: '3d_family', seconds: 15, quality: 'standard', mode: 'narrated',
    });
    // A link in mock mode downloads tests/fixtures/reference.mp4 (lib/providers/fetchVideo.js).
    const started = await api('POST', project.id, 'analyze', { source: { type: 'link', url: 'https://www.tiktok.com/@baker/video/1' }, rights: true });
    expect(started.reference.status).toBe('pending');
    expect(await kick('analyze')).toMatchObject({ ok: true });
    const { reference } = await api('GET', project.id, 'analyze');
    expect(reference.status, JSON.stringify(reference)).toBe('ready');
    expect(reference.beat_sheet?.length || reference.beats?.length).toBeGreaterThan(0);

    const done = await makeVideo(project.id);
    await expectFinished({ user, projectId: project.id, ...done });
    // The script was written from the reference.
    const [p] = await storyDb().select('story_projects', { id: project.id });
    expect(p.reference_id).toBe(reference.id);
  }, 240_000);
});
