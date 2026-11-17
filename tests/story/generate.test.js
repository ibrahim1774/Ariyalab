// Task 16: quote, generate, re-roll, the clip handler and the /status route.
// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__genTestSession ?? null),
}));

// Dev-time guard: inside onDone/onFail, a handler must settle through settleJob.
vi.mock('../../lib/credits.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    settleHold: async (args) => {
      const scope = globalThis.__genRunnerScope?.();
      if (scope?.inHandler && !scope.inSettleJob) throw new Error('handlers must settle through settleJob');
      return real.settleHold(args);
    },
  };
});

const { setStoryDb, storyDb } = await import('../../lib/story/db.js');
const { setCreditsDb, grantCredits, getBalance, holdCredits, InsufficientCreditsError } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache, quoteShot } = await import('../../lib/pricing.js');
const runner = await import('../../lib/story/runner.js');
globalThis.__genRunnerScope = runner._handlerCallScope;
const { tick, sweep, enqueue, _handlerCallScope } = runner;
const { sceneSig } = await import('../../lib/story/storyboard.js');
const { KINDS_REGISTERED_LATER } = await import('../../lib/story/handlers.js');
const {
  quoteGeneration, startGeneration, rerollShot, recoverStalledClips, _setShotsDeps, STALE_CLAIM_MS, FREE_RETRIES,
} = await import('../../lib/story/shots.js');
const { clipHandler } = await import('../../lib/story/clipJobs.js');
const { QuoteChangedError } = await import('../../lib/story/errors.js');
const { deleteProject, duplicateProject } = await import('../../lib/story/projects.js');
const { generateCast } = await import('../../lib/story/cast.js');
const statusRoute = (await import('../../pages/api/story/projects/[id]/status.js')).default;

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
// Tests may arm this to run once right after a matching query (see the kept give-up test).
let afterQuery = null;
beforeAll(async () => {
  raw = await createTestDb();
  const wrapped = {
    ...raw,
    query: async (sql, params) => {
      const out = await raw.query(sql, params);
      if (afterQuery && afterQuery.test(sql, params)) {
        const fn = afterQuery.run;
        afterQuery = null;
        await fn();
      }
      return out;
    },
  };
  setStoryDb(wrapped);
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
  _setShotsDeps();
  afterQuery = null;
  globalThis.__genTestSession = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------- fixtures

const SCENE = { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }] };

async function newProject({ n = 15, quality = 'pro_narrated', seconds = 3, funds = 2000, feeCharged = true, descriptions = [], projectSeconds } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', {
    user_id: userId, title: 'Generate test', style: '3d_family', step: 'generate', seconds: projectSeconds ?? Math.max(15, n * seconds), quality,
    mode: quality === 'pro_talking' ? 'talking' : 'narrated', fee_charged: feeCharged,
  });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: [SCENE], source: 'brief' });
  const sig = sceneSig(SCENE);
  const rows = Array.from({ length: n }, (_, i) => ({
    project_id: project.id, ord: i, scene_id: 's1', scene_sig: sig, description: descriptions[i] || `Shot number ${i + 1} of the shop.`,
    line: null, seconds, quality, status: 'still_ready', still_url: `/still/${i}.png`, still_key: `still-${i}`, still_delivered: true,
  }));
  const shots = await storyDb().insert('story_shots', rows);
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project, shots: shots.sort((a, b) => a.ord - b.ord) };
}

const shotRows = (projectId) => storyDb().select('story_shots', { project_id: projectId }, { order: 'ord' });
const shotRow = async (id) => (await storyDb().select('story_shots', { id }))[0];
const projectRow = async (id) => (await storyDb().select('story_projects', { id }))[0];
const clipJobs = (projectId) => storyDb().select('story_jobs', { project_id: projectId, kind: 'clip' }, { order: ['created_at', 'id'] });
const balance = (userId) => getBalance(userId);
async function ledger(userId) {
  const { rows } = await raw.query('select op, amount, reason, ref, hold_id from credit_ledger where user_id = $1 order by id', [userId]);
  return rows;
}
const charged = (rows) => rows.filter((r) => r.op === 'settle' || r.op === 'spend').reduce((n, r) => n + r.amount, 0);
async function holdOf(holdId) {
  const { rows } = await raw.query('select amount, remaining, status from credit_holds where id = $1', [holdId]);
  return rows[0];
}

let clock = Date.parse('2026-11-14T12:00:00.000Z');
/** Runs this project's jobs to the end with the mock provider (submit, pending, done). */
async function finishJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 6; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}

async function generateAll(ctx, shotIds) {
  const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds });
  const out = await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds, confirmTotal: q.total });
  return { q, out };
}

async function call(name, method, { userId, project, body = {} }) {
  const { handleAction } = await import('../../lib/story/actionRoute.js');
  globalThis.__genTestSession = { user: { id: userId, email: 'test@example.test' } };
  const res = makeRes();
  await handleAction(makeReq({ method, body, query: { id: project.id } }), res, name);
  return res;
}

async function getStatus({ userId, project, method = 'GET' }) {
  globalThis.__genTestSession = userId ? { user: { id: userId, email: 'test@example.test' } } : null;
  const res = makeRes();
  await statusRoute(makeReq({ method, query: { id: project.id } }), res);
  return res;
}

// ---------------------------------------------------------------- brief tests

describe('quote', () => {
  it('the project fee line follows the length: 45 for a 10 second project, 90 for 30 seconds', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('projectFeeShort', '45'::jsonb) on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      for (const [projectSeconds, fee] of [[7, 45], [10, 45], [30, 90]]) {
        const ctx = await newProject({ n: 2, feeCharged: false, projectSeconds });
        const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
        expect(q.lines[0], `${projectSeconds}s`).toEqual({ label: 'Project fee', credits: fee });
        expect(q.total).toBe(fee + 96);
        // The same number is spent when the first start is confirmed.
        const out = await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
        expect(out.charged ?? q.total).toBe(q.total);
        expect((await ledger(ctx.userId)).some((r) => r.reason === 'story_project_fee' && r.amount === fee)).toBe(true);
      }
    } finally {
      await raw.query(`delete from pricing_config where key = 'projectFeeShort'`);
      _resetPricingCache();
    }
  });

  it('quote for 15 pro_narrated 3 second shots is 720', async () => {
    const ctx = await newProject();
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.total).toBe(720);
    expect(q.holdNeeded).toBe(720);
    expect(q.lines).toEqual([{ label: '15 Pro shots', credits: 720 }]);
    expect(q.shotIds).toHaveLength(15);
  });

  it('is served by the quote action (POST projects/:id/quote)', async () => {
    const ctx = await newProject();
    const res = await call('quote', 'POST', { ...ctx, body: { shotIds: [ctx.shots[0].id] } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ total: 48, holdNeeded: 48, shotIds: [ctx.shots[0].id] });
  });

  it('prices only generated shots without a current clip (ready but stale counts again)', async () => {
    const ctx = await newProject({ n: 4 });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { source: 'footage' });
    await storyDb().update('story_shots', { id: ctx.shots[1].id }, { status: 'ready', clip_url: '/c.mp4', clip_key: 'c' });
    await storyDb().update('story_shots', { id: ctx.shots[2].id }, { status: 'ready', clip_url: '/c.mp4', clip_key: 'c', stale: true, clip_mismatch: true });
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.shotIds.sort()).toEqual([ctx.shots[2].id, ctx.shots[3].id].sort());
    expect(q.total).toBe(96);
  });

  it('adds the project fee when it has not been charged yet', async () => {
    const ctx = await newProject({ n: 2, feeCharged: false });
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.lines[0]).toEqual({ label: 'Project fee', credits: 90 });
    expect(q.total).toBe(90 + 96);
  });
});

describe('generate', () => {
  it('confirmTotal mismatch throws QuoteChangedError (409) and holds nothing', async () => {
    const ctx = await newProject();
    const err = await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 629 }).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteChangedError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('quote_changed');
    expect(err.extra.total).toBe(720);
    expect((await balance(ctx.userId)).held).toBe(0);
    expect(await clipJobs(ctx.project.id)).toHaveLength(0);
    const res = await call('generate', 'POST', { ...ctx, body: { confirmTotal: 1 } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'quote_changed', total: 720 });
  });

  it('places one hold and queues one clip job per shot with its share', async () => {
    const ctx = await newProject();
    const { out } = await generateAll(ctx);
    expect(out.charged).toBe(720);
    expect(out.queued).toHaveLength(15);
    const jobs = await clipJobs(ctx.project.id);
    expect(jobs).toHaveLength(15);
    expect(new Set(jobs.map((j) => j.hold_id)).size).toBe(1);
    expect(jobs.every((j) => j.cost_credits === 48)).toBe(true);
    expect((await balance(ctx.userId)).held).toBe(720);
    expect((await shotRows(ctx.project.id)).every((s) => s.status === 'queued')).toBe(true);
    expect((await projectRow(ctx.project.id)).gen_claim_id).toBeNull();
  });

  it('second generate while holding returns 409', async () => {
    const ctx = await newProject({ n: 3 });
    const ids = ctx.shots.map((s) => s.id);
    await generateAll(ctx, ids);
    const res = await call('generate', 'POST', { ...ctx, body: { shotIds: ids, confirmTotal: 144 } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('shots_busy');
    expect((await balance(ctx.userId)).held).toBe(144);
    expect(await clipJobs(ctx.project.id)).toHaveLength(3);
  });

  it('two generate requests at the same moment make one hold and one set of jobs', async () => {
    const ctx = await newProject({ n: 3 });
    const results = await Promise.allSettled([1, 2].map(() => startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 144 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
    expect((await balance(ctx.userId)).held).toBe(144);
    expect(await clipJobs(ctx.project.id)).toHaveLength(3);
  });

  it('insufficient credits returns 402 and enqueues nothing', async () => {
    const ctx = await newProject({ funds: 100 });
    const res = await call('generate', 'POST', { ...ctx, body: { confirmTotal: 720 } });
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatchObject({ error: 'insufficient_credits', needed: 720, available: 100 });
    expect(await clipJobs(ctx.project.id)).toHaveLength(0);
    expect((await balance(ctx.userId)).held).toBe(0);
    expect((await shotRows(ctx.project.id)).every((s) => s.status === 'still_ready')).toBe(true);
  });

  it('a hold that fails after the claim (balance spent meanwhile) gives 402 and puts the shots back', async () => {
    const ctx = await newProject({ n: 2, funds: 96 });
    _setShotsDeps({
      holdCredits: async () => {
        throw new InsufficientCreditsError(96, 0);
      },
    });
    await expect(startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 96 })).rejects.toBeInstanceOf(InsufficientCreditsError);
    const rows = await shotRows(ctx.project.id);
    expect(rows.every((s) => s.status === 'still_ready')).toBe(true);
    expect(await clipJobs(ctx.project.id)).toHaveLength(0);
    expect((await projectRow(ctx.project.id)).gen_claim_id).toBeNull();
  });

  it('one blocked shot releases 48 and the other 14 settle', async () => {
    const descriptions = ['A shopkeeper waves [[mock:blocked]]'];
    const ctx = await newProject({ descriptions });
    const { out } = await generateAll(ctx);
    const holdId = (await clipJobs(ctx.project.id))[0].hold_id;
    await finishJobs(ctx.project.id);
    const rows = await ledger(ctx.userId);
    const mine = rows.filter((r) => r.hold_id === holdId);
    expect(mine.filter((r) => r.op === 'settle')).toHaveLength(14);
    expect(mine.filter((r) => r.op === 'settle').reduce((n, r) => n + r.amount, 0)).toBe(14 * 48);
    expect(mine.filter((r) => r.op === 'release').reduce((n, r) => n + r.amount, 0)).toBe(48);
    expect((await holdOf(holdId)).status).toBe('closed');
    const shots = await shotRows(ctx.project.id);
    const blocked = shots.find((s) => s.id === ctx.shots[0].id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.error).toMatch(/content rules/i);
    expect(blocked.clip_url).toBeNull();
    expect(shots.filter((s) => s.status === 'ready')).toHaveLength(14);
    expect(out.charged).toBe(720);
    const b = await balance(ctx.userId);
    expect(b.held).toBe(0);
    expect(b.available).toBe(2000 - 14 * 48);
  });

  it('a full mock run ends with held === 0 and ledger sum equal to the quote', async () => {
    const ctx = await newProject({ feeCharged: false });
    const { q } = await generateAll(ctx);
    expect(q.total).toBe(90 + 720);
    await finishJobs(ctx.project.id);
    const b = await balance(ctx.userId);
    expect(b.held).toBe(0);
    expect(charged(await ledger(ctx.userId))).toBe(q.total);
    expect(b.available).toBe(2000 - q.total);
    const shots = await shotRows(ctx.project.id);
    expect(shots.every((s) => s.status === 'ready' && s.clip_url && s.clip_key)).toBe(true);
    expect((await projectRow(ctx.project.id)).fee_charged).toBe(true);
    // The fee is charged once: a later quote has no fee line.
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).total).toBe(0);
    expect(_handlerCallScope().inHandler).toBe(false);
  });

  it('refuses shots without a still, and with nothing to generate says so', async () => {
    const ctx = await newProject({ n: 2 });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { still_url: null, status: 'draft' });
    const res = await call('generate', 'POST', { ...ctx, body: { shotIds: [ctx.shots[0].id], confirmTotal: 48 } });
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe('still_missing');
    await storyDb().update('story_shots', { project_id: ctx.project.id }, { status: 'ready', clip_url: '/c.mp4', clip_key: 'c', still_url: '/s.png' });
    const none = await call('generate', 'POST', { ...ctx, body: { confirmTotal: 0 } });
    expect(none.statusCode).toBe(422);
    expect(none.body.error).toBe('nothing_to_generate');
  });

  it('needs a paid plan', async () => {
    const ctx = await newProject({ n: 1 });
    accounts.set({ paid: false });
    const res = await call('generate', 'POST', { ...ctx, body: { confirmTotal: 48 } });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toBe('plan_required');
  });
});

describe('consistent_cast false: clips and the project fee', () => {
  async function noCast({ feeCharged = false } = {}) {
    const ctx = await newProject({ n: 2, feeCharged });
    const [maya] = await storyDb().insert('story_cast', [
      { project_id: ctx.project.id, ord: 0, name: 'Maya', description: 'A barber in an apron.', status: 'ready', image_url: '/pick/maya.png', image_key: 'pm', sheet: { url: '/sheet/maya.png', key: 'sm', from_key: 'pm' } },
    ]);
    await storyDb().update('story_shots', { id: ctx.shots.map((s) => s.id) }, { cast_ids: [maya.id] });
    await storyDb().update('story_projects', { id: ctx.project.id }, { consistent_cast: false });
    return ctx;
  }

  it('clips are made without character elements', async () => {
    const ctx = await noCast({ feeCharged: true });
    await generateAll(ctx);
    for (const job of await clipJobs(ctx.project.id)) {
      expect(job.payload.elements ?? []).toEqual([]);
      expect(job.payload.prompt).not.toContain('@Maya');
    }
  });

  it('the project fee is a line of the quote and is charged once, with the cast fee ref and the fee_charged guard', async () => {
    const ctx = await noCast();
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.lines[0]).toEqual({ label: 'Project fee', credits: 90 });
    const out = await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    expect(out.charged).toBe(q.total);
    await finishJobs(ctx.project.id);
    const fee = (await ledger(ctx.userId)).filter((r) => r.reason === 'story_project_fee');
    expect(fee).toHaveLength(1);
    expect(fee[0]).toMatchObject({ ref: `project-fee:${ctx.project.id}`, amount: 90 });
    expect((await projectRow(ctx.project.id)).fee_charged).toBe(true);
    // A later quote has no fee line, and a second generation spends no second fee.
    const again = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(again.lines.some((l) => l.label === 'Project fee')).toBe(false);
    expect(charged(await ledger(ctx.userId))).toBe(q.total);
  });

  it('the status payload carries consistent_cast', async () => {
    const ctx = await noCast({ feeCharged: true });
    expect((await getStatus(ctx)).body.project.consistent_cast).toBe(false);
    await storyDb().update('story_projects', { id: ctx.project.id }, { consistent_cast: true });
    expect((await getStatus(ctx)).body.project.consistent_cast).toBe(true);
  });

  it('a retry of the same start never charges the fee twice', async () => {
    const ctx = await noCast();
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    await expect(startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total })).rejects.toBeDefined();
    await finishJobs(ctx.project.id);
    expect((await ledger(ctx.userId)).filter((r) => r.reason === 'story_project_fee')).toHaveLength(1);
  });
});

describe('sound in the clip prompt (narrator and character lines)', () => {
  const SOUND_SCENES = [
    { id: 's1', title: 'Open', visual: 'Maya sweeps the shop.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }, { speaker: 'Maya', text: 'Watch me prove them wrong.' }] },
    { id: 's2', title: 'Close', visual: 'Leo walks in.', lines: [{ speaker: 'Leo', text: 'I will take the first chair.' }, { speaker: 'narrator', text: 'And that was the start.' }] },
  ];
  const LINES = ['Nobody believed this would work.', 'Watch me prove them wrong.', 'I will take the first chair.', 'And that was the start.'];

  /** A project with these scenes, one shot per line (the first and last are narrator lines), the cast, and the mode. */
  async function soundProject({ mode = 'talking', quality = 'pro_narrated', cast = ['Maya', 'Leo'], lines = LINES, consistent = true } = {}) {
    const ctx = await newProject({ n: 4, quality });
    await storyDb().update('story_projects', { id: ctx.project.id }, { mode, consistent_cast: consistent });
    await storyDb().update('story_scripts', { project_id: ctx.project.id }, { scenes: SOUND_SCENES });
    const rows = [...ctx.shots].sort((a, b) => a.ord - b.ord);
    for (const [i, shot] of rows.entries()) {
      await storyDb().update('story_shots', { id: shot.id }, { scene_id: i < 2 ? 's1' : 's2', line: lines[i], scene_sig: sceneSig(SOUND_SCENES[i < 2 ? 0 : 1]) });
    }
    const notes = { Maya: 'warm, low and unhurried', Leo: 'bright and quick' };
    for (const [i, name] of cast.entries()) {
      await storyDb().insert('story_cast', { project_id: ctx.project.id, ord: i, name, description: `${name} in an apron.`, voice_note: notes[name], status: 'ready', image_url: `/pick/${name}.png`, image_key: `p${i}`, sheet: { url: `/sheet/${name}.png`, key: `s${i}`, from_key: `p${i}` } });
    }
    return ctx;
  }
  const promptsOf = async (ctx) => (await clipJobs(ctx.project.id)).map((j) => ({ shot: j.shot_id, prompt: j.payload.prompt }));
  const orderedPrompts = async (ctx) => {
    const byShot = new Map((await promptsOf(ctx)).map((p) => [p.shot, p.prompt]));
    return [...ctx.shots].sort((a, b) => a.ord - b.ord).map((sh) => byShot.get(sh.id));
  };

  it('a narrated clip is prompted for ambience and sound effects only, with no speech and no music, and never carries the line', async () => {
    const ctx = await soundProject({ mode: 'narrated', cast: ['Maya', 'Leo'] });
    await generateAll(ctx);
    for (const prompt of await orderedPrompts(ctx)) {
      expect(prompt).toMatch(/ambience and sound effects only/i);
      expect(prompt).toMatch(/Nobody speaks/);
      expect(prompt).toMatch(/No music/);
      for (const line of LINES) expect(prompt).not.toContain(line);
      expect(prompt).not.toMatch(/ says/);
    }
  });

  it('a talking video: a narrator line never reaches a clip; a character line is said by its speaker with the voice note', async () => {
    const ctx = await soundProject();
    await generateAll(ctx);
    const [first, maya, leo, last] = await orderedPrompts(ctx);
    expect(first).toMatch(/ambience and sound effects only/i);
    expect(first).not.toContain(LINES[0]);
    expect(last).not.toContain(LINES[3]);
    expect(last).toMatch(/Nobody speaks/);
    expect(maya).toContain('says, in a warm, low and unhurried voice: "Watch me prove them wrong."');
    expect(maya).toMatch(/Maya says/);
    expect(leo).toContain('Leo says, in a bright and quick voice: "I will take the first chair."');
    expect(maya).not.toContain('The character says');
    expect(maya).toMatch(/No music/);
  });

  it('names the speaker by the Kling element when the shot has one', async () => {
    const ctx = await soundProject({ quality: 'pro_narrated' });
    const [mayaRow] = await storyDb().select('story_cast', { project_id: ctx.project.id, name: 'Maya' });
    const mayaShot = [...ctx.shots].sort((a, b) => a.ord - b.ord)[1];
    await storyDb().update('story_shots', { id: mayaShot.id }, { cast_ids: [mayaRow.id] });
    await generateAll(ctx);
    const prompt = (await orderedPrompts(ctx))[1];
    expect(prompt).toContain('@Maya says, in a warm, low and unhurried voice: "Watch me prove them wrong."');
  });

  it('a speaker who is not in the cast is named in the clip prompt with no voice note (not an error)', async () => {
    const ctx = await soundProject({ cast: ['Maya'] });
    await generateAll(ctx);
    const [, maya, leo] = await orderedPrompts(ctx);
    expect(maya).toContain('Maya says, in a warm, low and unhurried voice:');
    expect(leo).toContain('Leo says: "I will take the first chair." Nobody else speaks. No music.');
  });

  it('a repeated line goes to the right speaker: the shot\'s stored line index decides', async () => {
    const ctx = await soundProject({ lines: ['Nobody believed this would work.', 'Watch me prove them wrong.', 'I will take the first chair.', 'And that was the start.'] });
    const scenes = [
      { id: 's1', title: 'a', visual: 'v', lines: [{ speaker: 'Leo', text: 'No.' }, { speaker: 'Maya', text: 'No.' }] },
      { id: 's2', title: 'b', visual: 'v', lines: [{ speaker: 'narrator', text: 'x' }] },
    ];
    await storyDb().update('story_scripts', { project_id: ctx.project.id }, { scenes });
    await storyDb().update('story_shots', { project_id: ctx.project.id, scene_id: 's1' }, { scene_sig: sceneSig(scenes[0]) });
    await storyDb().update('story_shots', { project_id: ctx.project.id, scene_id: 's2' }, { scene_sig: sceneSig(scenes[1]) });
    const rows = [...ctx.shots].sort((a, b) => a.ord - b.ord);
    await storyDb().update('story_shots', { id: rows[0].id }, { line: 'No.', line_index: 0 });
    await storyDb().update('story_shots', { id: rows[1].id }, { line: 'No.', line_index: 1 });
    await storyDb().update('story_shots', { id: [rows[2].id, rows[3].id] }, { scene_id: 's2', line: null });
    await generateAll(ctx);
    const [leo, maya] = await orderedPrompts(ctx);
    expect(leo).toContain('Leo says');
    expect(maya).toContain('Maya says');
  });

  it('a character line that is no line of its scene (the script changed) is refused the same way', async () => {
    const ctx = await soundProject({ lines: [LINES[0], 'Something Maya never says.', LINES[2], LINES[3]] });
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    await expect(startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total })).rejects.toMatchObject({ status: 422, code: 'speaker_unresolved', message: expect.stringContaining('Ask the chat to fix who says this line.') });
    expect(await clipJobs(ctx.project.id)).toHaveLength(0);
  });

  it('different people in every scene: the speaker is named without a cast and there is no voice note to add', async () => {
    const ctx = await soundProject({ cast: [], consistent: false });
    await generateAll(ctx);
    const [, maya] = await orderedPrompts(ctx);
    expect(maya).toContain('Maya says: "Watch me prove them wrong."');
  });

  it('the price shown is the price charged: sound changes no price', async () => {
    const narrated = await soundProject({ mode: 'narrated' });
    const talking = await soundProject();
    const a = await quoteGeneration({ userId: narrated.userId, projectId: narrated.project.id });
    const b = await quoteGeneration({ userId: talking.userId, projectId: talking.project.id });
    expect(b.total).toBe(a.total);
    const before = await balance(talking.userId);
    const out = await startGeneration({ userId: talking.userId, projectId: talking.project.id, confirmTotal: b.total });
    expect(out.charged).toBe(b.total);
    expect(before.available - (await balance(talking.userId)).available).toBe(b.total);
  });
});

describe('re-roll', () => {
  async function readyProject(n = 15) {
    const ctx = await newProject({ n });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    return { ...ctx, shots: await shotRows(ctx.project.id) };
  }

  it('free re-roll count for 15 shots is 3', async () => {
    // Round 1 (F-I1): the allowance counts shots with a delivered, paid clip.
    const ctx = await readyProject();
    const res = await getStatus(ctx);
    expect(res.body.rerolls).toEqual({ included: 3, used: 0, left: 3 });
    const eleven = await readyProject(11);
    expect((await getStatus(eleven)).body.rerolls.included).toBe(3); // ceil(11 x 0.2)
  });

  it('the fourth re-roll holds credits', async () => {
    const ctx = await readyProject();
    const before = (await balance(ctx.userId)).available;
    for (let i = 0; i < 3; i += 1) {
      const out = await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[i].id });
      expect(out.charged).toBe(0);
    }
    expect((await balance(ctx.userId)).held).toBe(0);
    expect((await projectRow(ctx.project.id)).rerolls_used).toBe(3);
    const fourth = await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[3].id, expectedCredits: 48 });
    expect(fourth.charged).toBe(48);
    expect((await balance(ctx.userId)).held).toBe(48);
    const job = (await clipJobs(ctx.project.id)).at(-1);
    expect(job).toMatchObject({ shot_id: ctx.shots[3].id, cost_credits: 48 });
    expect(job.payload.kind).toBe('reroll');
    await finishJobs(ctx.project.id);
    const b = await balance(ctx.userId);
    expect(b.held).toBe(0);
    expect(b.available).toBe(before - 48);
    const shot = await shotRow(ctx.shots[3].id);
    expect(shot.status).toBe('ready');
    expect(shot.clip_key).not.toBe(ctx.shots[3].clip_key);
  });

  it('keeps the clip shown while the new one is made, and checks expected_credits', async () => {
    const ctx = await readyProject(5);
    await storyDb().update('story_projects', { id: ctx.project.id }, { rerolls_used: 1 });
    const res = await call('reroll', 'POST', { ...ctx, body: { shotId: ctx.shots[0].id, expected_credits: 0 } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'quote_changed', credits: 48 });
    expect((await balance(ctx.userId)).held).toBe(0);
    const ok = await call('reroll', 'POST', { ...ctx, body: { shotId: ctx.shots[0].id, expected_credits: 48 } });
    expect(ok.statusCode).toBe(200);
    const row = await shotRow(ctx.shots[0].id);
    expect(row.status).toBe('queued');
    expect(row.clip_url).toBe(ctx.shots[0].clip_url);
  });

  it('refuses a shot that is not ready, busy or stale', async () => {
    const ctx = await readyProject(3);
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { stale: true, clip_mismatch: true });
    await expect(rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id })).rejects.toMatchObject({ status: 409 });
    await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[1].id });
    await expect(rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[1].id })).rejects.toMatchObject({ status: 409 });
    expect((await projectRow(ctx.project.id)).rerolls_used).toBe(1);
  });

  it('the claim refuses a free re-roll counted from a re-roll count that moved on', async () => {
    const ctx = await readyProject(5);
    const shot = ctx.shots[0];
    const args = (used) => ({
      p_project: ctx.project.id, p_claim: randomUUID(), p_hold: null, p_shots: [{ id: shot.id, round: shot.clip_round, status: 'ready' }],
      p_rerolls_used: used, p_rerolls_add: 1, p_now: new Date().toISOString(),
    });
    await storyDb().update('story_projects', { id: ctx.project.id }, { rerolls_used: 1 });
    expect(await storyDb().rpc('story_clip_claim', args(0))).toHaveLength(0);
    expect((await shotRow(shot.id)).status).toBe('ready');
    expect(await storyDb().rpc('story_clip_claim', args(1))).toHaveLength(1);
    expect((await projectRow(ctx.project.id)).rerolls_used).toBe(2);
  });

  it('two free re-rolls of the last free try at the same moment use it once', async () => {
    const ctx = await readyProject(5); // 1 included
    const results = await Promise.allSettled([0, 1].map((i) => rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[i].id })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(ok[0].value.charged).toBe(0);
    expect((await projectRow(ctx.project.id)).rerolls_used).toBe(1);
  });
});

// ---------------------------------------------------------------- carries

describe('carry 3: needs_rebuild gates quote and generate', () => {
  it('refuses while a shot needs a rebuild (its scene changed), not for stale alone', async () => {
    const ctx = await newProject({ n: 2 });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { stale: true, clip_mismatch: true });
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).total).toBe(96);
    await storyDb().insert('story_scripts', { project_id: ctx.project.id, version: 2, scenes: [{ ...SCENE, visual: 'Changed.' }], source: 'brief' });
    await expect(quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 409, code: 'needs_rebuild' });
    const res = await call('generate', 'POST', { ...ctx, body: { confirmTotal: 96 } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('needs_rebuild');
    expect(await clipJobs(ctx.project.id)).toHaveLength(0);
  });
});

describe('carry 4: stale and clip_mismatch', () => {
  it('a new clip clears both', async () => {
    const ctx = await newProject({ n: 1 });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { status: 'ready', clip_url: '/old.mp4', clip_key: 'old', stale: true, clip_mismatch: true });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    const row = await shotRow(ctx.shots[0].id);
    expect(row).toMatchObject({ status: 'ready', stale: false, clip_mismatch: false });
    expect(row.clip_key).not.toBe('old');
  });

  it('a clip made while its scene was edited stays stale', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    await storyDb().insert('story_scripts', { project_id: ctx.project.id, version: 2, scenes: [{ ...SCENE, visual: 'Changed mid way.' }], source: 'brief' });
    await finishJobs(ctx.project.id);
    expect(await shotRow(ctx.shots[0].id)).toMatchObject({ status: 'ready', stale: true, clip_mismatch: false });
  });

  it('duplicateProject resets stale, clip_mismatch and the clip claim', async () => {
    const ctx = await newProject({ n: 1 });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { status: 'ready', clip_url: '/c.mp4', clip_key: 'c', stale: true, clip_mismatch: true, clip_round: 2 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { gen_claim_id: randomUUID(), gen_hold_id: randomUUID(), gen_rerolls: 1, rerolls_used: 2 });
    const copy = await duplicateProject({ userId: ctx.userId, id: ctx.project.id });
    expect(copy).toMatchObject({ gen_claim_id: null, gen_hold_id: null, gen_shots: null, gen_rerolls: 0, rerolls_used: 0 });
    const [shot] = await shotRows(copy.id);
    expect(shot).toMatchObject({ clip_url: null, stale: false, clip_mismatch: false, status: 'still_ready', clip_prev: null });
  });
});

describe('clip handler (carries 5, 6, 7)', () => {
  it('is registered (not listed as a later kind)', () => {
    expect(KINDS_REGISTERED_LATER).not.toContain('clip');
  });

  it('never writes clip_url to a still_pending shot; the discarded clip releases its share', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { status: 'still_pending' });
    await clipHandler.onDone(job, { url: '/late.mp4', key: 'late' });
    const row = await shotRow(ctx.shots[0].id);
    expect(row.clip_url).toBeNull();
    expect(row.status).toBe('still_pending');
    const rows = await ledger(ctx.userId);
    expect(rows.filter((r) => r.op === 'settle')).toHaveLength(0);
    expect((await balance(ctx.userId)).held).toBe(0);
    expect(_handlerCallScope().inHandler).toBe(false);
  });

  it('onDone twice settles once; a job of an older round changes nothing', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    await clipHandler.onDone(job, { url: '/a.mp4', key: 'a' });
    await clipHandler.onDone(job, { url: '/a.mp4', key: 'a' });
    expect((await ledger(ctx.userId)).filter((r) => r.op === 'settle')).toHaveLength(1);
    expect(await shotRow(ctx.shots[0].id)).toMatchObject({ clip_url: '/a.mp4', status: 'ready' });
    await clipHandler.onFail(job, { blocked: false, error: 'x', final: true });
    expect((await shotRow(ctx.shots[0].id)).status).toBe('ready');
  });

  it('submits image to video from the still with the shot seconds and quality', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    expect(job.payload).toMatchObject({ shotId: ctx.shots[0].id, imageUrl: '/still/0.png', seconds: 3, quality: 'pro_narrated', aspect: '9:16', round: 1 });
    expect(job.payload.prompt).toContain('Shot number 1');
    const out = await clipHandler.submit({ ...job, attempts: 1 });
    expect(out.taskId).toBeTruthy();
  });

  it('carry 6: a retry is priced from the latest clip job: a failed paid attempt costs again, a failed free re-roll is free', async () => {
    const ctx = await newProject({ n: 6, descriptions: ['Shot one [[mock:fail]]'] }); // 2 free re-rolls
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    const failed = await shotRow(ctx.shots[0].id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/try again/i);
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [failed.id] })).total).toBe(48);
    // A free re-roll that fails leaves the shot ready with its earlier clip; Make it again retries it free
    // and uses no second free re-roll.
    await storyDb().update('story_shots', { id: ctx.shots[1].id }, { description: 'Shot two [[mock:fail]]' });
    const before = await shotRow(ctx.shots[1].id);
    await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[1].id });
    await finishJobs(ctx.project.id);
    const s1 = await shotRow(ctx.shots[1].id);
    expect(s1).toMatchObject({ status: 'ready', clip_url: before.clip_url, clip_key: before.clip_key });
    expect(s1.error).toMatch(/keeps its earlier clip/);
    expect((await projectRow(ctx.project.id)).rerolls_used).toBe(1);
    await expect(quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [s1.id] })).rejects.toMatchObject({ code: 'already_ready' });
    const status = (await getStatus(ctx)).body;
    expect(status.shots.find((s) => s.id === s1.id).reroll_credits).toBe(0);
    const again = await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: s1.id, expectedCredits: 0 });
    expect(again.charged).toBe(0);
    expect((await projectRow(ctx.project.id)).rerolls_used).toBe(1);
    expect((await clipJobs(ctx.project.id)).at(-1).payload.kind).toBe('retry');
    await finishJobs(ctx.project.id);
    // A failed paid re-roll is retried at its price again, once.
    await storyDb().update('story_projects', { id: ctx.project.id }, { rerolls_used: 2 });
    await storyDb().update('story_shots', { id: ctx.shots[3].id }, { description: 'Shot four [[mock:fail]]' });
    expect((await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[3].id, expectedCredits: 48 })).charged).toBe(48);
    await finishJobs(ctx.project.id);
    expect((await balance(ctx.userId)).held).toBe(0);
    const paidRetry = (await getStatus(ctx)).body.shots.find((s) => s.id === ctx.shots[3].id);
    expect(paidRetry).toMatchObject({ status: 'ready', reroll_credits: 48 });
    // A failed still (status failed, latest clip job done) is not a clip retry: the shot has its clip.
    await storyDb().update('story_shots', { id: ctx.shots[2].id }, { status: 'failed' });
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).shotIds).not.toContain(ctx.shots[2].id);
  });

  it(`free retries of a free attempt stop after ${FREE_RETRIES}`, async () => {
    const ctx = await newProject({ n: 5, descriptions: ['x [[mock:fail]]'] });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    // Make the latest attempt a failed free re-roll, then fail its free retries.
    const id = ctx.shots[0].id;
    const [last] = (await clipJobs(ctx.project.id)).filter((j) => j.shot_id === id);
    await raw.query(`update story_jobs set payload = payload || '{"credits":0,"kind":"reroll_free"}'::jsonb where id = $1`, [last.id]);
    for (let i = 0; i < FREE_RETRIES; i += 1) {
      const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] });
      expect(q.total).toBe(0);
      await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id], confirmTotal: 0 });
      await finishJobs(ctx.project.id);
    }
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [id] })).total).toBe(48);
  });
});

describe('carry 7: money standard on the start path', () => {
  it('an enqueue that throws releases the hold, removes the jobs it queued and puts the shots back', async () => {
    const ctx = await newProject({ n: 3 });
    let n = 0;
    _setShotsDeps({
      enqueue: async (args) => {
        n += 1;
        if (n === 2) throw new Error('database unavailable');
        return enqueue(args);
      },
    });
    await expect(startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 144 })).rejects.toThrow('database unavailable');
    expect((await balance(ctx.userId)).held).toBe(0);
    expect(await clipJobs(ctx.project.id)).toHaveLength(0);
    expect((await shotRows(ctx.project.id)).every((s) => s.status === 'still_ready')).toBe(true);
    expect((await projectRow(ctx.project.id)).gen_claim_id).toBeNull();
    // The next try works and holds once.
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 144 });
    expect((await balance(ctx.userId)).held).toBe(144);
  });

  it('a start whose request died is recovered: the hold is released and the shots put back', async () => {
    const ctx = await newProject({ n: 2 });
    // Simulate a crash: the request hangs after the hold, so nothing runs the undo.
    _setShotsDeps({ enqueue: () => new Promise(() => {}) });
    startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 96 });
    await vi.waitFor(async () => expect((await balance(ctx.userId)).held).toBe(96));
    expect(await recoverStalledClips(ctx.project.id)).toBe(0); // too young
    await raw.query(`update story_projects set gen_claimed_at = now() - interval '${STALE_CLAIM_MS / 1000 + 5} seconds' where id = $1`, [ctx.project.id]);
    expect(await recoverStalledClips(ctx.project.id)).toBe(2);
    expect((await balance(ctx.userId)).held).toBe(0);
    expect((await shotRows(ctx.project.id)).every((s) => s.status === 'still_ready')).toBe(true);
    expect((await projectRow(ctx.project.id)).gen_claim_id).toBeNull();
    _setShotsDeps();
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 96 });
    expect((await balance(ctx.userId)).held).toBe(96);
  });

  it('recovery of a start that queued some jobs keeps their shares and releases only the rest', async () => {
    const ctx = await newProject({ n: 3 });
    let n = 0;
    _setShotsDeps({
      enqueue: (args) => {
        n += 1;
        return n === 1 ? enqueue(args) : new Promise(() => {});
      },
    });
    startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 144 });
    await vi.waitFor(async () => expect(await clipJobs(ctx.project.id)).toHaveLength(1));
    await raw.query(`update story_projects set gen_claimed_at = now() - interval '60 seconds' where id = $1`, [ctx.project.id]);
    expect(await recoverStalledClips(ctx.project.id)).toBe(2);
    expect((await balance(ctx.userId)).held).toBe(48);
    _setShotsDeps();
    await finishJobs(ctx.project.id);
    const b = await balance(ctx.userId);
    expect(b.held).toBe(0);
    expect(b.available).toBe(2000 - 48);
    const rows = await shotRows(ctx.project.id);
    expect(rows.filter((s) => s.status === 'ready')).toHaveLength(1);
    expect(rows.filter((s) => s.status === 'still_ready')).toHaveLength(2);
  });

  it('a project fee that the cast already charged meanwhile is released, not charged twice', async () => {
    const ctx = await newProject({ n: 1, feeCharged: false });
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    const { spendCredits } = await import('../../lib/credits.js');
    await spendCredits({ userId: ctx.userId, currency: 'video', amount: 90, reason: 'story_project_fee', ref: `project-fee:${ctx.project.id}`, projectId: ctx.project.id });
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    await finishJobs(ctx.project.id);
    const b = await balance(ctx.userId);
    expect(b.held).toBe(0);
    expect(b.available).toBe(2000 - 90 - 48);
  });
});

describe('carry 8: runner and delete', () => {
  it('(a) the 30 minute kept give-up takes the lease first and leaves a job another caller leased', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Kept', seconds: 15 });
    const job = await enqueue({ projectId: project.id, kind: 'clip', payload: {} });
    const started = new Date(Date.now() - 40 * 60_000).toISOString();
    await storyDb().update('story_jobs', { id: job.id }, {
      status: 'running', started_at: started, submitted_at: started, provider: 'mock', provider_task_id: 'mock-clip-kept',
      provider_result: { url: '/api/mock/fixtures/clip.mp4' }, kept_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      locked_until: started, lease_until: null,
    });
    // Another caller takes the lease right after the sweep read the running rows.
    afterQuery = {
      test: (sql, params) => /from public\.story_jobs/.test(sql) && (params || []).includes('running'),
      run: () => raw.query(`update story_jobs set lease_until = now() + interval '60 seconds' where id = $1`, [job.id]),
    };
    await sweep({});
    const [row] = await storyDb().select('story_jobs', { id: job.id });
    expect(row.status).toBe('running');
  });

  it('(b) story_delete_project refuses while a job hold share is not applied or a clip start is claimed', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    await storyDb().update('story_jobs', { id: job.id }, { status: 'failed', applied_at: null });
    await expect(deleteProject({ userId: ctx.userId, id: ctx.project.id })).rejects.toMatchObject({ status: 409 });
    await storyDb().update('story_jobs', { id: job.id }, { applied_at: new Date().toISOString() });
    // A claim being queued right now is refused; one left by a dead request is recovered (its hold given back) and deleted.
    const holdId = randomUUID();
    await holdCredits({ userId: ctx.userId, currency: 'video', amount: 10, projectId: ctx.project.id, holdId });
    await storyDb().update('story_projects', { id: ctx.project.id }, { gen_claim_id: randomUUID(), gen_hold_id: holdId, gen_claimed_at: new Date().toISOString(), gen_shots: [] });
    await expect(deleteProject({ userId: ctx.userId, id: ctx.project.id })).rejects.toMatchObject({ status: 409 });
    await raw.query(`update story_projects set gen_claimed_at = now() - interval '5 minutes' where id = $1`, [ctx.project.id]);
    await expect(deleteProject({ userId: ctx.userId, id: ctx.project.id })).resolves.toEqual({ id: ctx.project.id });
    expect((await holdOf(holdId)).status).toBe('closed');
    expect((await holdOf(holdId)).remaining).toBe(0);
  });
});

describe('carry 9: per-quality minimum seconds', () => {
  it('prices an economy shot at its 4 second minimum and asks the provider for 4', async () => {
    expect(await quoteShot({ quality: 'economy', seconds: 3 })).toBe(28);
    expect(await quoteShot({ quality: 'standard', seconds: 3 })).toBe(24);
    const ctx = await newProject({ n: 2, quality: 'economy' });
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.total).toBe(56);
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 56 });
    expect((await clipJobs(ctx.project.id))[0].payload.seconds).toBe(4);
  });
});

// ---------------------------------------------------------------- /status

describe('carry 1: GET /status', () => {
  it('401 without a session, 405 for other methods, 404 for another user', async () => {
    const ctx = await newProject({ n: 1 });
    expect((await getStatus({ project: ctx.project })).statusCode).toBe(401);
    expect((await getStatus({ ...ctx, method: 'POST' })).statusCode).toBe(405);
    expect((await getStatus({ userId: randomUUID(), project: ctx.project })).statusCode).toBe(404);
  });

  it('returns the contract shape with priced shots, cast, public jobs, balance, audio and rerolls', async () => {
    const ctx = await newProject({ n: 2 });
    await storyDb().insert('story_cast', { project_id: ctx.project.id, ord: 0, name: 'Maya', description: 'd', status: 'blocked', round: 1 });
    await generateAll(ctx, [ctx.shots[0].id]);
    const res = await getStatus(ctx);
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(Object.keys(body).sort()).toEqual(['audio', 'balance', 'cast', 'jobs', 'project', 'render', 'renderPrice', 'renders', 'rerolls', 'shots']);
    expect(body.project.id).toBe(ctx.project.id);
    expect(body.project).not.toHaveProperty('gen_claim_id');
    expect(body.project).not.toHaveProperty('pending_shots');
    expect(body.balance).toMatchObject({ held: 48, available: 2000 - 48 });
    expect(body.render).toBeNull();
    expect(body.audio).toHaveProperty('narration');
    expect(body.cast[0]).toMatchObject({ name: 'Maya', retry_credits: 0, regen_credits: 0 });
    const [s0, s1] = body.shots;
    expect(s0).toHaveProperty('needs_rebuild', false);
    expect(s0).toHaveProperty('retry_credits');
    expect(s0).toHaveProperty('still_credits');
    expect(s1).toMatchObject({ clip_credits: 48, clip_price: 48, reroll_credits: null });
    const job = body.jobs.find((j) => j.kind === 'clip');
    expect(Object.keys(job).sort()).toEqual(['created_at', 'error', 'id', 'kind', 'payload', 'project_id', 'shot_id', 'status', 'updated_at']);
    expect(job.payload).toEqual({ shotId: ctx.shots[0].id });
  });

  it('keeps finished jobs with their error so the screen can say why a picture was blocked', async () => {
    const ctx = await newProject({ n: 1 });
    const castJob = await enqueue({ projectId: ctx.project.id, kind: 'cast_image', payload: { stage: 'candidate', castId: randomUUID(), prompt: 'secret prompt', round: 1, slot: 0 } });
    await storyDb().update('story_jobs', { id: castJob.id }, { status: 'blocked', error: 'Stopped by our content rules.', applied_at: new Date().toISOString() });
    const res = await getStatus(ctx);
    const job = res.body.jobs.find((j) => j.id === castJob.id);
    expect(job).toMatchObject({ status: 'blocked', error: 'Stopped by our content rules.', payload: { castId: castJob.payload.castId } });
    expect(JSON.stringify(res.body.jobs)).not.toContain('secret prompt');
  });

  it('drives the project: repeated /status calls alone take the cast and the clips to ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 10 * 3_600_000));
    const ctx = await newProject({ n: 2 });
    await generateCast({ userId: ctx.userId, projectId: ctx.project.id });
    await generateAll(ctx);
    const advance = () => vi.setSystemTime(new Date(Date.now() + 20_000));
    let body;
    for (let i = 0; i < 6; i += 1) {
      advance();
      body = (await getStatus(ctx)).body;
    }
    expect(body.cast.length).toBeGreaterThan(0);
    expect(body.cast.every((c) => c.status === 'ready')).toBe(true);
    expect(body.shots.every((s) => s.status === 'ready' && s.clip_url)).toBe(true);
    expect(body.balance.held).toBe(0);
  });

  it('shows a clip job that is running as generating', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 20 * 3_600_000));
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const body = (await getStatus(ctx)).body; // submits; first poll is later
    expect(body.shots[0].status).toBe('generating');
    expect((await shotRow(ctx.shots[0].id)).status).toBe('queued');
  });
});

// ---------------------------------------------------------------- round 1

describe('round 1', () => {
  const storyboardMod = () => import('../../lib/story/storyboard.js');

  it('F-C1 (p1): a retry after a quality upgrade is priced and made at the new quality', async () => {
    const { updateShot: patch } = await storyboardMod();
    const ctx = await newProject({ n: 1, quality: 'economy', seconds: 6, descriptions: ['A calm shot [[mock:fail]]'] });
    const sid = ctx.shots[0].id;
    let q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    await finishJobs(ctx.project.id);
    await raw.query("update story_shots set description = 'A calm shot' where id = $1", [sid]);
    await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'pro_talking' } });
    q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.total).toBe(6 * 21);
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    const job = (await clipJobs(ctx.project.id)).at(-1);
    expect(job).toMatchObject({ cost_credits: 126 });
    expect(job.payload.quality).toBe('pro_talking');
    await finishJobs(ctx.project.id);
    expect(charged(await ledger(ctx.userId))).toBe(126);
  });

  it('F-C1 (p5 a): a retry after a downgrade costs the lower price', async () => {
    const { updateShot: patch } = await storyboardMod();
    const ctx = await newProject({ n: 1, quality: 'pro_talking', seconds: 6, descriptions: ['A calm shot [[mock:fail]]'] });
    const sid = ctx.shots[0].id;
    let q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    await finishJobs(ctx.project.id);
    await raw.query("update story_shots set description = 'A calm shot' where id = $1", [sid]);
    await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'economy' } });
    const v = (await getStatus(ctx)).body.shots[0];
    expect(v.clip_credits).toBe(6 * 7);
    q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id });
    expect(q.total).toBe(42);
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: q.total });
    await finishJobs(ctx.project.id);
    expect(charged(await ledger(ctx.userId))).toBe(42);
  });

  it('F-C1 (p5 b): a failed free re-roll is not a free clip of a changed shot', async () => {
    const { updateShot: patch } = await storyboardMod();
    const ctx = await newProject({ n: 5, quality: 'economy', seconds: 6 });
    const sid = ctx.shots[0].id;
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    const paid = charged(await ledger(ctx.userId));
    await raw.query("update story_shots set description = description || ' [[mock:fail]]' where id = $1", [sid]);
    await rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, expectedCredits: 0 });
    await finishJobs(ctx.project.id);
    await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { description: 'A completely different shot of a beach.', quality: 'pro_talking' } });
    await raw.query("update story_shots set still_url = '/still/new.png', still_key = 'still-new', status = 'still_ready' where id = $1", [sid]);
    const q = await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [sid] });
    expect(q.total).toBe(6 * 21);
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [sid], confirmTotal: q.total });
    await finishJobs(ctx.project.id);
    expect(charged(await ledger(ctx.userId)) - paid).toBe(126);
  });

  it('F-I1 (p2): free re-rolls come from delivered paid clips, and a quality change goes through Generate', async () => {
    const { updateShot: patch } = await storyboardMod();
    const ctx = await newProject({ n: 25, quality: 'economy', seconds: 3 });
    const sid = ctx.shots[0].id;
    expect((await getStatus(ctx)).body.rerolls.included).toBe(0);
    await generateAll(ctx, [sid]);
    await finishJobs(ctx.project.id);
    expect((await getStatus(ctx)).body.rerolls).toEqual({ included: 1, used: 0, left: 1 });
    const { shot } = await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'pro_talking' } });
    expect(shot).toMatchObject({ stale: true, clip_mismatch: true });
    await expect(rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, expectedCredits: 0 })).rejects.toMatchObject({ code: 'reroll_not_available' });
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id, shotIds: [sid] })).total).toBe(63);
    const copy = await duplicateProject({ userId: ctx.userId, id: ctx.project.id });
    expect((await getStatus({ userId: ctx.userId, project: copy })).body.rerolls.included).toBe(0);
  });

  it('F-I2 / G2 (p3 a): a claim recovered while the hold call was stalled leaves no hold behind', async () => {
    const ctx = await newProject({ n: 3 });
    const pid = ctx.project.id;
    _setShotsDeps({
      holdCredits: async (args) => {
        await raw.query("update story_projects set gen_claimed_at = gen_claimed_at - interval '31 seconds' where id = $1", [pid]);
        await recoverStalledClips(pid);
        return holdCredits(args);
      },
    });
    const err = await startGeneration({ userId: ctx.userId, projectId: pid, confirmTotal: 144 }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(await clipJobs(pid)).toHaveLength(0);
    expect((await balance(ctx.userId)).held).toBe(0);
    expect((await shotRows(pid)).every((s) => s.status === 'still_ready')).toBe(true);
  });

  it('F-I2 (p3 b): a claim recovered between enqueues stops the request; only the job recovery kept is charged', async () => {
    const ctx = await newProject({ n: 3 });
    const pid = ctx.project.id;
    let n = 0;
    _setShotsDeps({
      enqueue: async (args) => {
        n += 1;
        if (n === 2) {
          await raw.query("update story_projects set gen_claimed_at = gen_claimed_at - interval '31 seconds' where id = $1", [pid]);
          await recoverStalledClips(pid);
        }
        return enqueue(args);
      },
    });
    const err = await startGeneration({ userId: ctx.userId, projectId: pid, confirmTotal: 144 }).catch((e) => e);
    _setShotsDeps();
    expect(err.status).toBe(409);
    expect(await clipJobs(pid)).toHaveLength(1);
    expect((await balance(ctx.userId)).held).toBe(48);
    await finishJobs(pid);
    const b = await balance(ctx.userId);
    expect(b.held).toBe(0);
    expect(charged(await ledger(ctx.userId))).toBe(48);
    const rows = await shotRows(pid);
    expect(rows.filter((s) => s.status === 'ready')).toHaveLength(1);
    expect(rows.filter((s) => s.status === 'still_ready')).toHaveLength(2);
  });

  it('F-I2 (4): a job queued after recovery read the claim carries no hold share', async () => {
    const ctx = await newProject({ n: 2 });
    const pid = ctx.project.id;
    let n = 0;
    _setShotsDeps({
      enqueue: async (args) => {
        n += 1;
        const job = await enqueue(args);
        if (n === 2) {
          // Recovery ran between the request's claim check and this insert: it gave this share back already.
          await raw.query("update story_projects set gen_claimed_at = gen_claimed_at - interval '31 seconds' where id = $1", [pid]);
          await raw.query("update story_jobs set status = 'running' where id = $1", [job.id]); // the runner already took it
          await raw.query("update story_jobs set payload = payload - 'accounted' where id = $1", [job.id]);
          await recoverStalledClips(pid);
          await raw.query("update story_jobs set payload = payload - 'accounted' where id = $1", [job.id]);
        }
        return job;
      },
    });
    await startGeneration({ userId: ctx.userId, projectId: pid, confirmTotal: 96 }).catch((e) => e);
    _setShotsDeps();
    const jobs = await clipJobs(pid);
    const late = jobs.find((j) => j.status === 'running');
    expect(late).toMatchObject({ hold_id: null, cost_credits: null });
  });

  it('F-I2 (3): the action route ends before a claim can look stalled', async () => {
    const route = await import('../../pages/api/story/projects/[id]/[action].js');
    expect(route.config.maxDuration).toBeLessThan(STALE_CLAIM_MS / 1000);
  });

  it('G1: clips get character elements from the pick and the sheet; a one-picture character is left out', async () => {
    const ctx = await newProject({ n: 1 });
    const [maya, leo] = await storyDb().insert('story_cast', [
      { project_id: ctx.project.id, ord: 0, name: 'Maya', description: 'A barber in an apron.', status: 'ready', image_url: '/pick/maya.png', image_key: 'pm', sheet: { url: '/sheet/maya.png', key: 'sm', from_key: 'pm' } },
      { project_id: ctx.project.id, ord: 1, name: 'Leo', description: 'A friend.', status: 'ready', image_url: '/pick/leo.png', image_key: 'pl', sheet: {} },
    ]);
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { cast_ids: [maya.id, leo.id] });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    expect(job.payload.elements).toEqual([{ name: 'Maya', description: 'Maya: A barber in an apron.', imageUrls: ['/pick/maya.png', '/sheet/maya.png'] }]); // round 2 H7: display name in the description
    expect(job.payload.prompt).toContain('@Maya');
    expect(job.payload.prompt).not.toContain('@Leo');
    await expect(clipHandler.submit({ ...job, attempts: 1 })).resolves.toHaveProperty('taskId');
  });

  it('G3: the project fee is charged only once the clips are queued', async () => {
    const ctx = await newProject({ n: 2, feeCharged: false });
    _setShotsDeps({
      enqueue: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 90 + 96 })).rejects.toThrow('database unavailable');
    expect(await balance(ctx.userId)).toMatchObject({ held: 0, available: 2000 });
    expect((await projectRow(ctx.project.id)).fee_charged).toBe(false);
  });

  it('G4: the copy-tries give-up takes the lease first too', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Kept', seconds: 15 });
    const job = await enqueue({ projectId: project.id, kind: 'clip', payload: {} });
    const started = new Date(Date.now() - 5 * 60_000).toISOString();
    await storyDb().update('story_jobs', { id: job.id }, {
      status: 'running', started_at: started, submitted_at: started, provider: 'mock', provider_task_id: 'mock-clip-tries',
      provider_result: { url: '/api/mock/fixtures/clip.mp4' }, kept_at: new Date(Date.now() - 60_000).toISOString(), mirror_tries: 4,
      locked_until: started, lease_until: null,
    });
    afterQuery = {
      test: (sql, params) => /from public\.story_jobs/.test(sql) && (params || []).includes('running'),
      run: () => raw.query(`update story_jobs set lease_until = now() + interval '60 seconds' where id = $1`, [job.id]),
    };
    await sweep({});
    expect((await storyDb().select('story_jobs', { id: job.id }))[0].status).toBe('running');
  });

  it('G5: the quote says what was spent on the video once nothing is left to make', async () => {
    const ctx = await newProject({ n: 2, feeCharged: false });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    expect(await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).toMatchObject({ total: 0, shotIds: [], spent: 90 + 96 });
  });

  it('G6: a blocked shot stays out of the default set until its description changes', async () => {
    const { updateShot: patch } = await storyboardMod();
    const ctx = await newProject({ n: 2, descriptions: ['A wave [[mock:blocked]]'] });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    const sid = ctx.shots[0].id;
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).shotIds).toEqual([]);
    expect((await getStatus(ctx)).body.shots[0].clip_credits).toBeNull();
    await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { description: 'A calm wave' } });
    await raw.query("update story_shots set still_url = '/still/n.png', still_key = 'n', status = 'still_ready' where id = $1", [sid]);
    expect((await quoteGeneration({ userId: ctx.userId, projectId: ctx.project.id })).shotIds).toEqual([sid]);
  });

  it('G8: the project moves to review when every clip is ready', async () => {
    const ctx = await newProject({ n: 2 });
    await generateAll(ctx);
    expect((await projectRow(ctx.project.id)).step).toBe('generate');
    await finishJobs(ctx.project.id);
    expect((await projectRow(ctx.project.id)).step).toBe('review');
  });

  it('F-M1: a paid re-roll needs the price the customer saw', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    await storyDb().update('story_projects', { id: ctx.project.id }, { rerolls_used: 1 });
    await expect(rerollShot({ userId: ctx.userId, projectId: ctx.project.id, shotId: ctx.shots[0].id })).rejects.toMatchObject({ code: 'quote_changed', extra: { credits: 48 } });
    expect((await balance(ctx.userId)).held).toBe(0);
  });

  it('F-M2: a clip whose settle gave up does not stay on the shot', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { status: 'ready', clip_url: '/gone.mp4', clip_key: 'gone' });
    await clipHandler.onFail({ ...job, result: { url: '/gone.mp4', key: 'gone' } }, { blocked: false, error: 'x', final: true });
    expect(await shotRow(ctx.shots[0].id)).toMatchObject({ clip_url: null, clip_key: null, status: 'failed' });
  });

  it('F-M3: /status ticks a project at most once every 3 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 30 * 3_600_000));
    const ctx = await newProject({ n: 2 });
    await generateAll(ctx, [ctx.shots[0].id]);
    await getStatus(ctx);
    await generateAll(ctx, [ctx.shots[1].id]);
    await getStatus(ctx);
    const second = (await clipJobs(ctx.project.id)).find((j) => j.shot_id === ctx.shots[1].id);
    expect(second.status).toBe('queued');
    vi.setSystemTime(new Date(Date.now() + 4_000));
    await getStatus(ctx);
    expect((await clipJobs(ctx.project.id)).find((j) => j.shot_id === ctx.shots[1].id).status).toBe('running');
  });
});

// ---------------------------------------------------------------- round 2

describe('round 2', () => {
  it('H1 (q2): a lost claim that takes out a queued job puts its shot back', async () => {
    const ctx = await newProject({ n: 2 });
    const pid = ctx.project.id;
    const adapter = storyDb();
    const origUpdate = adapter.update;
    let gate = null;
    let open;
    adapter.update = async (table, match, patch, ...rest) => {
      if (table === 'story_jobs' && patch?.payload?.accounted && gate) {
        const g = gate;
        gate = null;
        await g;
      }
      return origUpdate.call(adapter, table, match, patch, ...rest);
    };
    let n = 0;
    let recovery;
    _setShotsDeps({
      enqueue: async (args) => {
        const job = await enqueue(args);
        n += 1;
        if (n === 1) {
          await raw.query("update story_projects set gen_claimed_at = now() - interval '1 hour' where id = $1", [pid]);
          gate = new Promise((r) => { open = r; });
          recovery = recoverStalledClips(pid);
          await new Promise((r) => setTimeout(r, 100));
        }
        return job;
      },
    });
    try {
      const err = await startGeneration({ userId: ctx.userId, projectId: pid, confirmTotal: 96 }).catch((e) => e);
      expect(err.status).toBe(409);
    } finally {
      open?.();
      await recovery;
      adapter.update = origUpdate;
      _setShotsDeps();
    }
    expect(await clipJobs(pid)).toHaveLength(0);
    expect((await shotRows(pid)).every((s) => s.status === 'still_ready')).toBe(true);
    expect((await balance(ctx.userId)).held).toBe(0);
    expect((await quoteGeneration({ userId: ctx.userId, projectId: pid })).shotIds).toHaveLength(2);
  });

  it('H3: a redone onDone still moves the project to review', async () => {
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    await clipHandler.onDone(job, { url: '/a.mp4', key: 'a' });
    await storyDb().update('story_projects', { id: ctx.project.id }, { step: 'generate' }); // as if the first run stopped before the step write
    await clipHandler.onDone(job, { url: '/a.mp4', key: 'a' });
    expect((await projectRow(ctx.project.id)).step).toBe('review');
  });

  it('H4: changing the quality back to the clip quality clears stale again', async () => {
    const { updateShot: patch } = await import('../../lib/story/storyboard.js');
    const ctx = await newProject({ n: 1 });
    await generateAll(ctx);
    await finishJobs(ctx.project.id);
    const sid = ctx.shots[0].id;
    await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'standard' } });
    expect(await shotRow(sid)).toMatchObject({ stale: true, clip_mismatch: true });
    const { shot } = await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'pro_narrated' } });
    expect(shot).toMatchObject({ stale: false, clip_mismatch: false });
    // Not after a description change since the clip.
    await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'standard' } });
    await raw.query("update story_shots set description = 'Something else' where id = $1", [sid]);
    const again = await patch({ userId: ctx.userId, projectId: ctx.project.id, shotId: sid, patch: { quality: 'pro_narrated' } });
    expect(again.shot.stale).toBe(true);
  });

  it('H5: a generate never moves the step back from review', async () => {
    const ctx = await newProject({ n: 2 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { step: 'storyboard' });
    _setShotsDeps({
      enqueue: async (args) => {
        await storyDb().update('story_projects', { id: ctx.project.id }, { step: 'review' });
        return enqueue(args);
      },
    });
    await startGeneration({ userId: ctx.userId, projectId: ctx.project.id, confirmTotal: 96 });
    expect((await projectRow(ctx.project.id)).step).toBe('review');
  });

  it('H7: a cast name with spaces becomes a safe element name, the display name stays in the description', async () => {
    const ctx = await newProject({ n: 1 });
    const [c] = await storyDb().insert('story_cast', [
      { project_id: ctx.project.id, ord: 0, name: 'Mr. Hall Senior', description: 'An older barber.', status: 'ready', image_url: '/p.png', image_key: 'p', sheet: { url: '/s.png', key: 's', from_key: 'p' } },
    ]);
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { cast_ids: [c.id] });
    await generateAll(ctx);
    const [job] = await clipJobs(ctx.project.id);
    expect(job.payload.elements).toEqual([{ name: 'MrHallSenior', description: 'Mr. Hall Senior: An older barber.', imageUrls: ['/p.png', '/s.png'] }]);
    expect(job.payload.prompt).toContain('@MrHallSenior');
  });
});

describe('story flow in clip prompts', () => {
  it('each clip prompt carries the scene setting and the shot before; the first has none; an old shot without a setting works', async () => {
    const ctx = await newProject({ n: 3 });
    await storyDb().update('story_shots', { id: [ctx.shots[0].id, ctx.shots[1].id] }, { setting: 'A small shop at night, warm lamp light.' });
    await generateAll(ctx);
    const prompts = new Map((await clipJobs(ctx.project.id)).map((j) => [j.shot_id, j.payload.prompt]));
    expect(prompts.get(ctx.shots[0].id)).toContain('Setting: A small shop at night, warm lamp light.');
    expect(prompts.get(ctx.shots[0].id)).not.toContain('Just before this');
    expect(prompts.get(ctx.shots[1].id)).toContain('Just before this: Shot number 1 of the shop.');
    expect(prompts.get(ctx.shots[1].id)).toContain('Shot number 2 of the shop.');
    expect(prompts.get(ctx.shots[2].id)).not.toContain('Setting:');
    expect(prompts.get(ctx.shots[2].id)).toContain('Just before this: Shot number 2 of the shop.');
  });
});
