// Owner decision 2026-11-16: renders are charged. The first finished render of a project is free
// (pricing.included.render), every start after that holds pricing.renderRegen and spends it when the render
// finishes; a failed render never counts and never charges. These tests never run ffmpeg: a finished render
// goes through the job runner with the row already holding its stored file (renderHandler.run returns it).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, holdRemaining, holdCredits, InsufficientCreditsError } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { DEFAULTS } from '../../lib/pricingConstants.js';
import { runWorkerJob, sweep, enqueue } from '../../lib/story/runner.js';
import { startRender, recoverStalledRender, renderHandler, renderPrice } from '../../lib/story/render.js';
import { getProjectStatus } from '../../lib/story/status.js';
import { sweepStaleHolds } from '../../lib/story/holdSweeper.js';
import { runMcpTool } from '../../lib/mcp/tools.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__chargeTestSession ?? null),
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
beforeEach(async () => {
  _resetPricingCache();
  globalThis.__chargeTestSession = null;
  // runWorkerJob claims from any project: an earlier test's job must not run in this one.
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where kind = 'render' and status in ('queued', 'running')`);
});

const SCENES = [{ id: 's1', title: 'Morning', visual: 'A bakery.', lines: [{ speaker: 'narrator', text: 'Once upon a time.' }] }];

async function newProject({ credits = 0, feeCharged = true } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', {
    user_id: userId, title: 'Charge test', style: '3d_family', step: 'review', seconds: 15, quality: 'standard', mode: 'narrated', aspect: '9:16', fee_charged: feeCharged,
    narration_url: '/api/mock/storage/n.wav', narration_key: 'test/n.wav', narration_seconds: 3,
    narration_segments: [{ sceneId: 's1', lineIndex: 0, text: 'Once upon a time.', start: 0, end: 2 }],
    audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
  });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
  await storyDb().insert('story_shots', [0, 1].map((i) => ({
    project_id: project.id, ord: i, scene_id: 's1', description: `shot ${i}`, seconds: 3, quality: 'standard',
    source: 'generated', status: 'ready', clip_url: `/api/mock/storage/c${i}.mp4`, clip_key: `test/c${i}.mp4`,
  })));
  if (credits) await grantCredits({ userId, currency: 'video', amount: credits, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}

const balance = async (userId) => getBalance(userId, 'video');
const rowOf = async (id) => (await storyDb().select('story_renders', { id }))[0];
const jobOf = async (renderRow) => (await storyDb().select('story_jobs', { id: renderRow.job_id }))[0];
const ledger = async (userId) => (await raw.query('select reason, amount, ref from credit_ledger where user_id = $1 order by created_at, id', [userId])).rows;

/** Finishes the queued render through the runner without ffmpeg: the row already has its stored file. */
async function finish(render) {
  await raw.query(`update story_renders set storage_key = $2, file_url = $3 where id = $1`, [render.id, `story/x/render/${render.id}.mp4`, `/api/mock/storage/${render.id}.mp4`]);
  await raw.query(`update story_renders set status = 'done' where id = $1`, [render.id]);
  const out = await runWorkerJob('render', {});
  expect(out).toMatchObject({ claimed: true, outcome: 'done' });
  return rowOf(render.id);
}

/** Fails the queued render through the runner: its frozen settings cannot be rendered. */
async function failRun(render) {
  await raw.query(`update story_renders set settings = '{}'::jsonb where id = $1`, [render.id]);
  const out = await runWorkerJob('render', {});
  expect(out).toMatchObject({ claimed: true, outcome: 'failed' });
  return rowOf(render.id);
}

describe('render price', () => {
  it('defaults: one included render, then 5 credits', () => {
    expect(DEFAULTS.included.render).toBe(1);
    expect(DEFAULTS.renderRegen).toBe(5);
  });

  it('the first render is free: no hold, no ledger row, the job carries no hold', async () => {
    const ctx = await newProject({ credits: 100 });
    expect(await renderPrice(ctx.project)).toEqual({ credits: 0 });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    const row = await rowOf(render.id);
    expect([row.hold_id, row.cost_credits]).toEqual([null, 0]);
    const job = await jobOf(row);
    expect([job.hold_id, job.cost_credits]).toEqual([null, null]);
    const done = await finish(render);
    expect(done.status).toBe('done');
    expect((await balance(ctx.userId)).available).toBe(100);
    expect(await ledger(ctx.userId)).toHaveLength(1); // the grant only
  });

  it('a render after a finished one holds 5 at start and spends exactly 5 when it finishes', async () => {
    const ctx = await newProject({ credits: 100 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    expect(await renderPrice(ctx.project)).toEqual({ credits: 5 });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 5 });
    const row = await rowOf(render.id);
    expect(row.cost_credits).toBe(5);
    expect(await holdRemaining(row.hold_id)).toEqual({ remaining: 5, status: 'active' });
    const job = await jobOf(row);
    expect([job.hold_id, job.cost_credits]).toEqual([row.hold_id, 5]);
    expect((await balance(ctx.userId)).available).toBe(95);
    const done = await finish(render);
    expect(done.status).toBe('done');
    const after = await balance(ctx.userId);
    expect(after.available).toBe(95);
    expect(Number(after.plan) + Number(after.topup)).toBe(95);
    expect(after.held).toBe(0);
    expect((await holdRemaining(row.hold_id)).status).toBe('closed');
    // A third start costs 5 again.
    expect(await renderPrice(ctx.project)).toEqual({ credits: 5 });
  });

  it('a failed render releases its hold, never counts, and the next start is priced as before', async () => {
    const ctx = await newProject({ credits: 100 });
    // A failed first render: the next one is still the free one.
    const first = (await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render;
    expect((await failRun(first)).status).toBe('failed');
    expect(await renderPrice(ctx.project)).toEqual({ credits: 0 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    // A failed paid render gives the 5 back.
    const paid = (await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render;
    const row = await rowOf(paid.id);
    expect((await balance(ctx.userId)).available).toBe(95);
    expect((await failRun(paid)).status).toBe('failed');
    const after = await balance(ctx.userId);
    expect(after.available).toBe(100);
    expect(after.held).toBe(0);
    expect((await holdRemaining(row.hold_id)).status).toBe('closed');
    expect(await renderPrice(ctx.project)).toEqual({ credits: 5 });
  });

  it('a sweep that ends a killed paid render (past 330 s) gives its hold back', async () => {
    const ctx = await newProject({ credits: 50 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    const row = await rowOf(render.id);
    const gone = new Date(Date.now() - 340_000).toISOString();
    await raw.query(`update story_jobs set status = 'running', attempts = 1, started_at = $2, locked_until = $2 where id = $1`, [row.job_id, gone]);
    await raw.query(`update story_renders set status = 'running' where id = $1`, [render.id]);
    await sweep({});
    await sweep({});
    expect((await rowOf(render.id)).status).toBe('failed');
    expect((await balance(ctx.userId)).available).toBe(50);
  });

  it('a finish applied twice (a retried onDone, a second worker) charges once', async () => {
    const ctx = await newProject({ credits: 100 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    const done = await finish(render);
    const job = await jobOf(done);
    // onDone runs again, directly and through the runner (applied_at cleared, as after a lost lease).
    await renderHandler.onDone(job, job.result);
    await raw.query(`update story_jobs set applied_at = null, locked_until = now() - interval '1 minute' where id = $1`, [job.id]);
    await sweep({});
    await renderHandler.onDone(job, job.result);
    expect((await balance(ctx.userId)).available).toBe(95);
    const spends = (await ledger(ctx.userId)).filter((l) => l.reason === 'story_render');
    expect(spends).toHaveLength(1);
  });

  it('a render job that finds its row already ended spends nothing and gives its share back', async () => {
    const ctx = await newProject({ credits: 100 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    await raw.query(`update story_renders set status = 'failed', error = 'stopped' where id = $1`, [render.id]);
    expect(await runWorkerJob('render', {})).toMatchObject({ claimed: true, outcome: 'done' });
    expect((await balance(ctx.userId)).available).toBe(100);
  });
});

describe('onDone gives up', () => {
  it('a free first render whose project-step update keeps failing ends failed (file deleted) and the next render is still free', async () => {
    const ctx = await newProject({ credits: 100 });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    // Written done with its stored file; then every story_projects update throws, so onDone never finishes.
    await raw.query(`update story_renders set storage_key = $2, file_url = $3, status = 'done' where id = $1`, [render.id, `story/x/render/${render.id}.mp4`, `/api/mock/storage/${render.id}.mp4`]);
    const real = storyDb();
    const flaky = new Proxy(real, {
      get: (target, prop, recv) => (prop === 'update'
        ? (table, ...rest) => (table === 'story_projects' ? Promise.reject(new Error('db flaky')) : target.update(table, ...rest))
        : Reflect.get(target, prop, recv)),
    });
    setStoryDb(flaky);
    try {
      await runWorkerJob('render', {});
      for (let i = 1; i <= 12; i += 1) await sweep({ now: new Date(Date.now() + i * 3_600_000) });
    } finally {
      setStoryDb(real);
    }
    const row = await rowOf(render.id);
    expect(row.status).toBe('failed');
    expect((await jobOf(row)).status).toBe('failed');
    expect(await renderPrice(ctx.project)).toEqual({ credits: 0 });
    const next = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    expect((await rowOf(next.render.id)).cost_credits).toBe(0);
    expect((await balance(ctx.userId)).available).toBe(100);
  });
});

describe('killed requests', () => {
  async function pricedProject() {
    const ctx = await newProject({ credits: 100 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    return ctx;
  }
  /** What a request killed after the hold (before the job) leaves: a queued row with its hold and no job. */
  async function killedAfterHold(ctx, { secondsAgo = 60, holdMinutesAgo = 0 } = {}) {
    const holdId = randomUUID();
    const [row] = await storyDb().insert('story_renders', { project_id: ctx.project.id, version: 9, status: 'queued', settings: {}, hold_id: holdId, cost_credits: 5 });
    await holdCredits({ userId: ctx.userId, currency: 'video', amount: 5, projectId: ctx.project.id, holdId });
    await raw.query(`update story_renders set created_at = now() - make_interval(secs => $2) where id = $1`, [row.id, secondsAgo]);
    if (holdMinutesAgo) await raw.query(`update credit_holds set created_at = now() - make_interval(mins => $2) where id = $1`, [holdId, holdMinutesAgo]);
    return { row, holdId };
  }

  it('recoverStalledRender fails the row and releases its hold', async () => {
    const ctx = await pricedProject();
    const { row, holdId } = await killedAfterHold(ctx);
    expect((await balance(ctx.userId)).available).toBe(95);
    await recoverStalledRender(ctx.project.id);
    expect((await rowOf(row.id)).status).toBe('failed');
    expect((await holdRemaining(holdId)).status).toBe('closed');
    expect((await balance(ctx.userId)).available).toBe(100);
    // Repeat: harmless.
    await recoverStalledRender(ctx.project.id);
    expect((await balance(ctx.userId)).available).toBe(100);
  });

  it('a fresh queued row (inside 30 s) is left alone', async () => {
    const ctx = await pricedProject();
    const { row } = await killedAfterHold(ctx, { secondsAgo: 2 });
    await recoverStalledRender(ctx.project.id);
    expect((await rowOf(row.id)).status).toBe('queued');
    expect((await balance(ctx.userId)).available).toBe(95);
  });

  it('a request killed after the job was queued (before the row was linked) keeps the job: the row is linked, not failed', async () => {
    const ctx = await pricedProject();
    const { row, holdId } = await killedAfterHold(ctx);
    const job = await enqueue({ projectId: ctx.project.id, kind: 'render', payload: { renderId: row.id }, holdId, costCredits: 5 });
    await recoverStalledRender(ctx.project.id);
    expect(await rowOf(row.id)).toMatchObject({ status: 'queued', job_id: job.id });
    expect((await holdRemaining(holdId)).status).toBe('active');
  });

  it('the stale-hold sweeper ends a render hold a killed request left (its default recovery runs recoverStalledRender)', async () => {
    const ctx = await pricedProject();
    const { row, holdId } = await killedAfterHold(ctx, { secondsAgo: 7200, holdMinutesAgo: 120 });
    const summary = await sweepStaleHolds({});
    expect(summary.failed).toBe(0);
    expect((await rowOf(row.id)).status).toBe('failed');
    expect((await holdRemaining(holdId)).status).toBe('closed');
    expect((await balance(ctx.userId)).available).toBe(100);
  });
});

describe('quote and refusals', () => {
  async function pricedProject(credits = 100) {
    const ctx = await newProject({ credits });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    return ctx;
  }

  it('expected_credits that is not the price is 409 quote_changed with the price, and nothing is held or queued', async () => {
    const ctx = await pricedProject();
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 0 }))
      .rejects.toMatchObject({ status: 409, code: 'quote_changed', extra: { credits: 5 } });
    expect(await storyDb().select('story_renders', { project_id: ctx.project.id })).toHaveLength(1);
    expect((await balance(ctx.userId)).available).toBe(100);
    // The free one refuses a paid quote too.
    const fresh = await newProject({ credits: 10 });
    await expect(startRender({ userId: fresh.userId, projectId: fresh.project.id, expectedCredits: 5 }))
      .rejects.toMatchObject({ status: 409, code: 'quote_changed', extra: { credits: 0 } });
    await expect(startRender({ userId: fresh.userId, projectId: fresh.project.id, expectedCredits: 'five' }))
      .rejects.toMatchObject({ status: 422, code: 'validation_failed' });
  });

  it('POST /render takes expected_credits: a stale price is 409 quote_changed { credits }', async () => {
    const ctx = await pricedProject();
    globalThis.__chargeTestSession = { user: { id: ctx.userId, email: 'test@example.test' } };
    const { default: handler } = await import('../../pages/api/story/projects/[id]/[action].js');
    const stale = makeRes();
    await handler(makeReq({ method: 'POST', query: { id: ctx.project.id, action: 'render' }, body: { expected_credits: 0 } }), stale);
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({ error: 'quote_changed', credits: 5 });
    const ok = makeRes();
    await handler(makeReq({ method: 'POST', query: { id: ctx.project.id, action: 'render' }, body: { expected_credits: 5 } }), ok);
    expect(ok.statusCode).toBe(200);
    expect((await balance(ctx.userId)).available).toBe(95);
  });

  it('402 insufficient_credits under 5 credits: nothing held, no render row, no version used', async () => {
    const ctx = await pricedProject(3);
    const err = await startRender({ userId: ctx.userId, projectId: ctx.project.id }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    const rows = await storyDb().select('story_renders', { project_id: ctx.project.id });
    expect(rows).toHaveLength(1);
    expect((await balance(ctx.userId)).available).toBe(3);
    globalThis.__chargeTestSession = { user: { id: ctx.userId, email: 'test@example.test' } };
    const { default: handler } = await import('../../pages/api/story/projects/[id]/[action].js');
    const res = makeRes();
    await handler(makeReq({ method: 'POST', query: { id: ctx.project.id, action: 'render' }, body: {} }), res);
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toBe('insufficient_credits');
    // Topped up: the next start is version 2.
    await grantCredits({ userId: ctx.userId, currency: 'video', amount: 10, bucket: 'topup', reason: 'test', ref: randomUUID() });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    expect(render.version).toBe(2);
  });

  it('no plan is 402 plan_required, before any price', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });

  it('/status carries the next render price', async () => {
    const ctx = await newProject({ credits: 20 });
    expect((await getProjectStatus({ userId: ctx.userId, projectId: ctx.project.id })).renderPrice).toEqual({ credits: 0 });
    await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
    expect((await getProjectStatus({ userId: ctx.userId, projectId: ctx.project.id })).renderPrice).toEqual({ credits: 5 });
  });

  it('the price follows pricing_config (included.render, renderRegen)', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('renderRegen', '7'::jsonb), ('included', '{"render": 2}'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const ctx = await newProject({ credits: 50 });
      await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
      expect(await renderPrice(ctx.project)).toEqual({ credits: 0 });
      await finish((await startRender({ userId: ctx.userId, projectId: ctx.project.id })).render);
      expect(await renderPrice(ctx.project)).toEqual({ credits: 7 });
    } finally {
      await raw.query(`delete from pricing_config where key in ('renderRegen', 'included')`);
      _resetPricingCache();
    }
  });
});

describe('MCP render', () => {
  const call = (userId, args) => runMcpTool({ userId, name: 'render', args });

  it('the free render starts at once; a paid one is quoted first and charges the confirmed amount', async () => {
    const ctx = await newProject({ credits: 100 });
    const free = await call(ctx.userId, { project_id: ctx.project.id });
    expect(free.isError, JSON.stringify(free.data)).toBe(false);
    expect(free.data.render).toMatchObject({ version: 1, status: 'queued' });
    const [row] = await storyDb().select('story_renders', { project_id: ctx.project.id });
    await finish(row);

    const quote = await call(ctx.userId, { project_id: ctx.project.id });
    expect(quote.isError).toBe(false);
    expect(quote.data).toMatchObject({ needs_confirmation: true, quote: { total: 5 } });
    expect(quote.data.next).toMatch(/confirm_total: 5/);
    expect(await storyDb().select('story_renders', { project_id: ctx.project.id })).toHaveLength(1);
    expect((await balance(ctx.userId)).available).toBe(100);

    const wrong = await call(ctx.userId, { project_id: ctx.project.id, confirm_total: 3 });
    expect(wrong.isError).toBe(true);
    expect(wrong.data).toMatchObject({ error: 'quote_changed', total: 5 });
    expect((await balance(ctx.userId)).available).toBe(100);

    const ok = await call(ctx.userId, { project_id: ctx.project.id, confirm_total: 5 });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(ok.data).toMatchObject({ render: { version: 2, status: 'queued' }, credits: 5 });
    expect((await balance(ctx.userId)).available).toBe(95);
    const [, second] = await storyDb().select('story_renders', { project_id: ctx.project.id }, { order: 'version' });
    await finish(second);
    expect((await balance(ctx.userId)).available).toBe(95);
    expect((await balance(ctx.userId)).held).toBe(0);
  });
});

describe('MCP render with the project fee due', () => {
  it('N1: quotes the fee and the render as separate lines and says so in the description', async () => {
    const { MCP_TOOLS } = await import('../../lib/mcp/tools.js');
    const desc = MCP_TOOLS.find((t) => t.name === 'render').description;
    expect(desc).toMatch(/project fee/i);
    expect(desc).not.toMatch(/starts at once/i);
    const ctx = await newProject({ credits: 300, feeCharged: false });
    const quote = await runMcpTool({ userId: ctx.userId, name: 'render', args: { project_id: ctx.project.id } });
    expect(quote.isError, JSON.stringify(quote.data)).toBe(false);
    expect(quote.data).toMatchObject({ needs_confirmation: true, quote: { total: 90, lines: [{ label: 'Project fee (once per video)', credits: 90 }, { label: 'Video render (the first one is included)', credits: 0 }] } });
    expect(await storyDb().select('story_renders', { project_id: ctx.project.id })).toHaveLength(0);
    const wrong = await runMcpTool({ userId: ctx.userId, name: 'render', args: { project_id: ctx.project.id, confirm_total: 5 } });
    expect(wrong.data).toMatchObject({ error: 'quote_changed', total: 90, quote: { lines: [{ label: 'Project fee (once per video)', credits: 90 }, { credits: 0 }] } });
    const ok = await runMcpTool({ userId: ctx.userId, name: 'render', args: { project_id: ctx.project.id, confirm_total: 90 } });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(ok.data.credits).toBe(90);
  });
});

describe('render cap fixes', () => {
  it('a crashed render (queued, no job, stale) stops counting: recovery runs before the cap', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('free_limits', '{"rendersPerProjectPer24h": 1}'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const ctx = await newProject({ credits: 20 });
      await raw.query(`insert into story_renders (project_id, version, status, created_at) values ($1, 1, 'queued', now() - interval '5 minutes')`, [ctx.project.id]);
      const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
      expect(render.version).toBe(2);
    } finally {
      await raw.query(`delete from pricing_config where key = 'free_limits'`);
      _resetPricingCache();
    }
  });

  it('a cap stored as a numeric string ("1") is enforced', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('free_limits', '{"rendersPerProjectPer24h": "1"}'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const ctx = await newProject({ credits: 20 });
      await raw.query(`insert into story_renders (project_id, version, status, created_at) values ($1, 1, 'done', now() - interval '1 hour')`, [ctx.project.id]);
      await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 429, code: 'daily_limit', extra: { limit: 1 } });
    } finally {
      await raw.query(`delete from pricing_config where key = 'free_limits'`);
      _resetPricingCache();
    }
  });
});


describe('the project fee at render (no cast, no clips made)', () => {
  const feeRows = async (userId) => (await ledger(userId)).filter((r) => r.reason === 'story_project_fee');

  it('a project that never paid the fee pays it once with its first render, shown as its own line', async () => {
    const ctx = await newProject({ credits: 300, feeCharged: false });
    const price = await renderPrice(ctx.project);
    expect(price).toMatchObject({ credits: 90, fee: 90, lines: [{ label: 'Project fee', credits: 90 }, { label: 'Render', credits: 0 }] });
    expect((await getProjectStatus({ userId: ctx.userId, projectId: ctx.project.id })).renderPrice.fee).toBe(90);
    const { render, charged } = await startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 90 });
    expect(charged).toBe(90);
    expect(await feeRows(ctx.userId)).toEqual([{ reason: 'story_project_fee', amount: 90, ref: `project-fee:${ctx.project.id}` }]);
    expect((await storyDb().select('story_projects', { id: ctx.project.id }))[0].fee_charged).toBe(true);
    await finish(render);
    // A later render pays no second fee.
    expect(await renderPrice((await storyDb().select('story_projects', { id: ctx.project.id }))[0])).toEqual({ credits: 5 });
    await startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 5 });
    expect(await feeRows(ctx.userId)).toHaveLength(1);
    expect((await balance(ctx.userId)).available).toBe(300 - 90 - 5);
  });

  it('a different expected price is 409 quote_changed and nothing is spent', async () => {
    const ctx = await newProject({ credits: 300, feeCharged: false });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 0 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    expect(await feeRows(ctx.userId)).toHaveLength(0);
    expect((await balance(ctx.userId)).available).toBe(300);
  });

  it('N2: with the fee due, a start without expected_credits is 409 quote_changed carrying the lines and the total, and nothing is spent', async () => {
    const ctx = await newProject({ credits: 300, feeCharged: false });
    for (const bad of [undefined, null]) {
      const err = await startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: bad }).catch((e) => e);
      expect(err).toMatchObject({ status: 409, code: 'quote_changed' });
      expect(err.extra).toMatchObject({ credits: 90, lines: [{ label: 'Project fee', credits: 90 }, { label: 'Render', credits: 0 }] });
    }
    expect(await feeRows(ctx.userId)).toHaveLength(0);
    expect((await balance(ctx.userId)).available).toBe(300);
    expect(await storyDb().select('story_renders', { project_id: ctx.project.id })).toHaveLength(0);
    // The route does the same.
    globalThis.__chargeTestSession = { user: { id: ctx.userId, email: 't@example.test', email_confirmed_at: '2026-01-01T00:00:00.000Z' } };
    const { default: handler } = await import('../../pages/api/story/projects/[id]/[action].js');
    const res = makeRes();
    await handler(makeReq({ method: 'POST', query: { id: ctx.project.id, action: 'render' }, body: {} }), res);
    expect(res.statusCode).toBe(409);
    expect(await feeRows(ctx.userId)).toHaveLength(0);
  });

  it('the no-fee path still starts without expected_credits', async () => {
    const ctx = await newProject({ credits: 10, feeCharged: true });
    await startRender({ userId: ctx.userId, projectId: ctx.project.id });
  });

  it('charged reports only what this call took: a fee someone else paid meanwhile is not counted', async () => {
    const ctx = await newProject({ credits: 300, feeCharged: false });
    const { spendCredits } = await import('../../lib/credits.js');
    const real = await import('../../lib/story/render.js');
    // The fee lands on the ledger between the price read and the spend (a clip start or cast start in another request).
    const { setStoryDb: _unused, ...rest } = await import('../../lib/story/db.js');
    void rest; void real;
    const price = await renderPrice(ctx.project);
    expect(price.fee).toBe(90);
    await spendCredits({ userId: ctx.userId, currency: 'video', amount: 90, reason: 'story_project_fee', ref: `project-fee:${ctx.project.id}`, projectId: ctx.project.id });
    // A start that still carries the old price (expected 90) is now priced 0: 409, and a start at 0 charges nothing more.
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 90 })).rejects.toMatchObject({ code: 'quote_changed' });
    const { charged } = await startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 0 });
    expect(charged).toBe(0);
    expect(await feeRows(ctx.userId)).toHaveLength(1);
  });

  it('a failing ledger re-read after the hold gives the hold back and leaves no render behind', async () => {
    const ctx = await newProject({ credits: 300, feeCharged: false });
    // An earlier finished render makes this one a paid one (a hold is taken), and the fee is still unpaid.
    const first = await startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 90 });
    await finish(first.render);
    await storyDb().update('story_projects', { id: ctx.project.id }, { fee_charged: false });
    await raw.query(`delete from credit_ledger where user_id = $1 and reason = 'story_project_fee'`, [ctx.userId]).catch(() => {});
    const before = (await balance(ctx.userId)).available;
    const realQuery = raw.query.bind(raw);
    // The price read checks the ledger too; only the re-read after the hold (the last of those checks) goes down.
    let reads = 0;
    let holdSeen = false;
    const { _setRenderDeps } = await import('../../lib/story/render.js');
    _setRenderDeps({ holdCredits: async (args) => { const out = await holdCredits(args); holdSeen = true; return out; } });
    raw.query = (sql, params) => {
      if (holdSeen && /select 1 from public\.credit_ledger/.test(String(sql)) && /story_project_fee/.test(JSON.stringify(params || []))) { reads += 1; return Promise.reject(new Error('ledger down')); }
      return realQuery(sql, params);
    };
    try {
      await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 95 })).rejects.toThrow('ledger down');
    } finally {
      raw.query = realQuery;
      _setRenderDeps();
    }
    expect(reads).toBe(1);
    expect((await balance(ctx.userId)).available).toBe(before);
    const open = await raw.query(`select 1 from credit_holds where user_id = $1 and status = 'active'`, [ctx.userId]);
    expect(open.rows).toHaveLength(0);
    const queued = (await storyDb().select('story_renders', { project_id: ctx.project.id })).filter((r) => r.status === 'queued');
    expect(queued).toHaveLength(0);
  });

  it('not enough credits is 402 with nothing spent and no render left behind', async () => {
    const ctx = await newProject({ credits: 50, feeCharged: false });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id, expectedCredits: 90 })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await feeRows(ctx.userId)).toHaveLength(0);
    expect((await balance(ctx.userId)).available).toBe(50);
    expect(await storyDb().select('story_renders', { project_id: ctx.project.id })).toHaveLength(0);
  });

  it('a project that paid at cast or clip start pays nothing extra: the flag, or the ledger entry alone', async () => {
    const paid = await newProject({ credits: 100, feeCharged: true });
    expect(await renderPrice(paid.project)).toEqual({ credits: 0 });
    const ledgerOnly = await newProject({ credits: 200, feeCharged: false });
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId: ledgerOnly.userId, currency: 'video', amount: 90, reason: 'story_project_fee', ref: `project-fee:${ledgerOnly.project.id}`, projectId: ledgerOnly.project.id });
    expect(await renderPrice(ledgerOnly.project)).toEqual({ credits: 0 });
    await startRender({ userId: ledgerOnly.userId, projectId: ledgerOnly.project.id });
    expect(await feeRows(ledgerOnly.userId)).toHaveLength(1);
    expect((await storyDb().select('story_projects', { id: ledgerOnly.project.id }))[0].fee_charged).toBe(false);
  });
});
