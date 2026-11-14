import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, holdCredits, getBalance } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { ProviderError } from '../../lib/providers/errors.js';

// mirrorUrl is the real mock-mode copy unless a test makes it fail.
const mirror = vi.hoisted(() => ({ fail: 0, calls: [] }));
vi.mock('../../lib/providers/storage.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    mirrorUrl: async (args) => {
      mirror.calls.push(args);
      if (mirror.fail > 0) {
        mirror.fail -= 1;
        throw new Error('upload refused');
      }
      return real.mirrorUrl(args);
    },
  };
});

const {
  enqueue, tick, sweep, handleProviderCallback, registerHandler, _resetHandlers,
  activeJobs, callbackUrl, verifyCallbackToken, SUBMITS_PER_TICK,
} = await import('../../lib/story/runner.js');

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
  await raw?.close();
});

let logSpy;
beforeEach(() => {
  mirror.fail = 0;
  mirror.calls = [];
  logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  _resetHandlers();
  logSpy.mockRestore();
  vi.unstubAllEnvs();
});

const T0 = new Date('2026-11-14T12:00:00.000Z');
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

async function newProject() {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId });
  return project;
}
const jobRow = async (id) => (await storyDb().select('story_jobs', { id }))[0];

/** An async handler whose provider is a controllable fake. */
function fakeAsync({ submit, poll } = {}) {
  const calls = { submit: [], poll: [], done: [], fail: [] };
  let n = 0;
  const handler = {
    submit: async (job) => {
      calls.submit.push(job.id);
      if (submit) return submit(job);
      n += 1;
      return { provider: 'mock', taskId: `task-${job.id}-${n}` };
    },
    poll: async (job) => {
      calls.poll.push(job.id);
      return poll ? poll(job) : { status: 'pending' };
    },
    onDone: async (job, result) => {
      calls.done.push({ id: job.id, status: job.status, result });
    },
    onFail: async (job, info) => {
      calls.fail.push({ id: job.id, status: job.status, ...info });
    },
  };
  return { handler, calls };
}

async function withHold(project, { grant = 100, hold = 60 } = {}) {
  await grantCredits({ userId: project.user_id, currency: 'video', amount: grant, bucket: 'plan', reason: 'test', ref: randomUUID() });
  return holdCredits({ userId: project.user_id, currency: 'video', amount: hold, projectId: project.id });
}

describe('tick', () => {
  it('claim is exclusive across two concurrent ticks', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    for (let i = 0; i < 6; i++) await enqueue({ projectId: project.id, kind: 'clip' });

    const [a, b] = await Promise.all([
      tick({ projectId: project.id, now: T0 }),
      tick({ projectId: project.id, now: T0 }),
    ]);
    expect(a.claimed + b.claimed).toBe(6);
    expect(calls.submit).toHaveLength(6);
    expect(new Set(calls.submit).size).toBe(6);
    const jobs = await activeJobs(project.id);
    expect(jobs.every((j) => j.status === 'running' && j.attempts === 1 && j.provider_task_id)).toBe(true);
  });

  it('throttle never submits more than 15 in one tick', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    for (let i = 0; i < 20; i++) await enqueue({ projectId: project.id, kind: 'still' });

    const s = await tick({ projectId: project.id, now: T0 });
    expect(SUBMITS_PER_TICK).toBe(15);
    expect(s).toMatchObject({ claimed: 15, submitted: 15 });
    expect(calls.submit).toHaveLength(15);
    const jobs = await activeJobs(project.id);
    expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(5);
    expect(jobs.filter((j) => j.status === 'queued').every((j) => j.attempts === 0)).toBe(true);
  });

  it('shares one submit budget across ticks of several projects', async () => {
    const p1 = await newProject();
    const p2 = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    for (let i = 0; i < 10; i++) {
      await enqueue({ projectId: p1.id, kind: 'still' });
      await enqueue({ projectId: p2.id, kind: 'still' });
    }
    const budget = { submits: 15 };
    await tick({ projectId: p1.id, now: T0, budget });
    await tick({ projectId: p2.id, now: T0, budget });
    expect(calls.submit).toHaveLength(15);
    expect(budget.submits).toBe(0);
  });

  it('is a no-op when nothing is due', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    await enqueue({ projectId: project.id, kind: 'clip', runAfter: at(60) });
    expect(await tick({ projectId: project.id, now: T0 })).toEqual({ claimed: 0, submitted: 0, polled: 0, done: 0, failed: 0, retried: 0 });
    expect(calls.submit).toHaveLength(0);
    expect((await activeJobs(project.id))[0]).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it("a 'rate_limited' submit leaves the job queued with run_after 10 seconds ahead and does not use an attempt", async () => {
    const project = await newProject();
    let busy = true;
    const { handler, calls } = fakeAsync({
      submit: async (job) => {
        if (busy) throw new ProviderError('rate_limited');
        return { provider: 'mock', taskId: `t-${job.id}` };
      },
    });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });

    await tick({ projectId: project.id, now: T0 });
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 0, provider_task_id: null, started_at: null });
    expect(new Date(row.run_after).getTime()).toBe(at(10).getTime());

    expect((await tick({ projectId: project.id, now: at(9) })).claimed).toBe(0);
    busy = false;
    expect((await tick({ projectId: project.id, now: at(10) })).submitted).toBe(1);
    row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'running', attempts: 1, provider_task_id: `t-${job.id}` });
    expect(calls.submit).toHaveLength(2);
  });

  it('a rate limit puts the rest of the claimed batch back without using their attempts', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('rate_limited'); } });
    registerHandler('still', handler);
    for (let i = 0; i < 3; i++) await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    expect(calls.submit).toHaveLength(1);
    const jobs = await activeJobs(project.id);
    expect(jobs.every((j) => j.status === 'queued' && j.attempts === 0)).toBe(true);
  });

  it('polls running jobs whose locked_until passed, mirrors the result and runs onDone once', async () => {
    const project = await newProject();
    let ready = false;
    const { handler, calls } = fakeAsync({ poll: async () => (ready ? { status: 'done', url: '/mock/clip.mp4' } : { status: 'pending' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });

    await tick({ projectId: project.id, now: T0 });
    expect((await tick({ projectId: project.id, now: at(5) })).polled).toBe(0); // locked_until not reached
    expect((await tick({ projectId: project.id, now: at(15) })).polled).toBe(1); // pending
    ready = true;
    const s = await tick({ projectId: project.id, now: at(30) });
    expect(s).toMatchObject({ polled: 1, done: 1 });

    const key = `story/${project.id}/clip/${job.id}.mp4`;
    expect(calls.done).toEqual([{ id: job.id, status: 'done', result: { url: `/api/mock/storage/${key}`, key } }]);
    expect(mirror.calls).toEqual([{ srcUrl: '/mock/clip.mp4', key }]);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'done', result: { url: `/api/mock/storage/${key}`, key } });
    expect(await tick({ projectId: project.id, now: at(60) })).toMatchObject({ polled: 0, done: 0 });
  });

  it("caps polls at 20 per tick", async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    for (let i = 0; i < 25; i++) await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0, limit: 15 });
    await tick({ projectId: project.id, now: at(1), limit: 15 }); // claims the other 10
    const s = await tick({ projectId: project.id, now: at(60) });
    expect(s.polled).toBe(20);
    expect(calls.poll).toHaveLength(20);
  });

  it('sets files_expire_at once, from retentionDays in pricing config', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('retentionDays', '7'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const project = await newProject();
      const { handler } = fakeAsync({ poll: async () => ({ status: 'done', url: '/mock/still.png' }) });
      registerHandler('still', handler);
      await enqueue({ projectId: project.id, kind: 'still' });
      await enqueue({ projectId: project.id, kind: 'still' });
      await tick({ projectId: project.id, now: T0, limit: 1 });
      await tick({ projectId: project.id, now: at(20), limit: 0 });
      const [p1] = await storyDb().select('story_projects', { id: project.id });
      expect(new Date(p1.files_expire_at).getTime()).toBe(at(20 + 7 * 86400).getTime());

      await tick({ projectId: project.id, now: at(40), limit: 1 });
      await tick({ projectId: project.id, now: at(100), limit: 0 });
      const [p2] = await storyDb().select('story_projects', { id: project.id });
      expect(p2.files_expire_at).toBe(p1.files_expire_at);
    } finally {
      await raw.query(`delete from pricing_config where key = 'retentionDays'`);
      _resetPricingCache();
    }
  });

  it('claims account-level jobs (no project) when projectId is null', async () => {
    const userId = randomUUID();
    const calls = [];
    registerHandler('voice_clone', { sync: true, run: async (job) => { calls.push(job.id); return { voiceId: 'v1' }; } });
    const job = await enqueue({ userId, kind: 'voice_clone', payload: { name: 'Me' } });
    const s = await tick({ projectId: null, now: T0 });
    expect(s).toMatchObject({ claimed: 1, done: 1 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'done', result: { voiceId: 'v1' } });
  });
});

describe('sync jobs', () => {
  it('runs a sync job inside the tick and marks it done', async () => {
    const project = await newProject();
    const done = [];
    registerHandler('script', {
      sync: true,
      run: async (job) => ({ scenes: [{ id: 's1' }], echo: job.payload.x }),
      onDone: async (job, result) => done.push({ id: job.id, result }),
    });
    const job = await enqueue({ projectId: project.id, kind: 'script', payload: { x: 1 } });
    const s = await tick({ projectId: project.id, now: T0 });
    expect(s).toMatchObject({ claimed: 1, submitted: 1, done: 1 });
    expect(done).toEqual([{ id: job.id, result: { scenes: [{ id: 's1' }], echo: 1 } }]);
    expect(mirror.calls).toHaveLength(0);
    const [p] = await storyDb().select('story_projects', { id: project.id });
    expect(p.files_expire_at).toBeNull(); // no file stored
  });

  it('mirrors a sync media result that has a provider url but no key', async () => {
    const project = await newProject();
    const done = [];
    registerHandler('render', {
      sync: true,
      run: async () => ({ url: '/mock/clip.mp4', seconds: 30 }),
      onDone: async (job, result) => done.push(result),
    });
    const job = await enqueue({ projectId: project.id, kind: 'render' });
    await tick({ projectId: project.id, now: T0 });
    const key = `story/${project.id}/render/${job.id}.mp4`;
    expect(done).toEqual([{ url: `/api/mock/storage/${key}`, key, seconds: 30 }]);
  });

  it('retries a failed sync job once with a 30 second backoff, then fails it for good', async () => {
    const project = await newProject();
    const fails = [];
    let runs = 0;
    registerHandler('narration', {
      sync: true,
      run: async () => { runs += 1; throw new ProviderError('failed'); },
      onFail: async (job, info) => fails.push({ status: job.status, ...info }),
    });
    const job = await enqueue({ projectId: project.id, kind: 'narration' });

    expect(await tick({ projectId: project.id, now: T0 })).toMatchObject({ retried: 1, failed: 0 });
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'Generation failed. Please try again.' });
    expect(new Date(row.run_after).getTime()).toBe(at(30).getTime());
    expect(fails).toHaveLength(0);

    expect((await tick({ projectId: project.id, now: at(29) })).claimed).toBe(0);
    expect(await tick({ projectId: project.id, now: at(30) })).toMatchObject({ failed: 1 });
    row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
    expect(runs).toBe(2);
    expect(fails).toEqual([{ status: 'failed', blocked: false, error: 'Generation failed. Please try again.', final: true }]);
  });

  it("a 'config' error fails the job at once with an operator log line", async () => {
    const project = await newProject();
    const fails = [];
    registerHandler('music', {
      sync: true,
      run: async () => { throw new ProviderError('config', 'GOOGLE_AI_API_KEY is not set. Add it to .env.local.'); },
      onFail: async (job, info) => fails.push(info),
    });
    const job = await enqueue({ projectId: project.id, kind: 'music' });
    await tick({ projectId: project.id, now: T0 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', attempts: 1, error: 'Generation failed. Please try again.' });
    expect(fails).toEqual([{ blocked: false, error: 'Generation failed. Please try again.', final: true }]);
    expect(logSpy.mock.calls.some((c) => /CONFIG ERROR.*GOOGLE_AI_API_KEY/.test(c.join(' ')))).toBe(true);
  });
});

describe('blocked results', () => {
  it("a 'blocked' result marks the job blocked and calls onFail with blocked: true", async () => {
    const project = await newProject();
    const holdId = await withHold(project, { hold: 60 });
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'blocked', error: 'Not allowed.' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 25 });

    await tick({ projectId: project.id, now: T0 });
    const s = await tick({ projectId: project.id, now: at(20) });
    expect(s.failed).toBe(1);
    expect(await jobRow(job.id)).toMatchObject({ status: 'blocked', error: 'Not allowed.', attempts: 1 });
    expect(calls.fail).toEqual([{ id: job.id, status: 'blocked', blocked: true, error: 'Not allowed.', final: true }]);
    expect(calls.submit).toHaveLength(1); // no retry
    expect((await getBalance(project.user_id)).held).toBe(35);
  });

  it('a blocked submit is final too', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('blocked'); } });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'blocked' });
    expect(calls.fail).toHaveLength(1);
    expect(calls.fail[0]).toMatchObject({ blocked: true, final: true });
  });
});

describe('failures, retries and holds', () => {
  it('a hold share is released exactly once on final failure', async () => {
    const project = await newProject();
    const holdId = await withHold(project, { hold: 60 });
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'failed', error: 'Generation failed. Please try again.' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 20 });

    await tick({ projectId: project.id, now: T0 }); // submit try 1
    await tick({ projectId: project.id, now: at(15) }); // poll: failed -> retry in 30 s
    expect((await getBalance(project.user_id)).held).toBe(60); // a retry keeps the hold
    await tick({ projectId: project.id, now: at(45) }); // submit try 2
    const taskId = (await jobRow(job.id)).provider_task_id;
    await tick({ projectId: project.id, now: at(60) }); // poll: failed -> final
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect((await getBalance(project.user_id)).held).toBe(40);

    // A late callback, another sweep and another tick change nothing.
    expect(await handleProviderCallback('mock', { code: 501, data: { taskId, state: 'fail' } }, { token: 'x', now: at(70) }))
      .toMatchObject({ ok: true, ignored: true });
    await sweep({ now: at(3600) });
    await tick({ projectId: project.id, now: at(3600) });
    expect((await getBalance(project.user_id)).held).toBe(40);
    expect(calls.fail).toHaveLength(1);
    const { rows } = await raw.query(`select count(*)::int as n from credit_ledger where hold_id = $1 and ref = $2 and op = 'release'`, [holdId, `${holdId}:job:${job.id}`]);
    expect(rows[0].n).toBe(1);
  });

  it('a mirror failure retries, then fails for good', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'done', url: '/mock/still.png' }) });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    mirror.fail = 2;

    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(calls.done).toHaveLength(0);
    await tick({ projectId: project.id, now: at(45) });
    await tick({ projectId: project.id, now: at(60) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(mirror.calls).toHaveLength(2);
    expect(calls.done).toHaveLength(0);
    expect(calls.fail).toEqual([expect.objectContaining({ blocked: false, final: true })]);
  });

  it('a mirror failure once, then success, finishes the job on the retry', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'done', url: '/mock/still.png' }) });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    mirror.fail = 1;
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    await tick({ projectId: project.id, now: at(45) });
    await tick({ projectId: project.id, now: at(60) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(calls.done).toHaveLength(1);
    expect(calls.fail).toHaveLength(0);
  });
});

describe('sweep', () => {
  // The sweeper looks at every project; start each test with no other job running.
  beforeEach(async () => {
    await raw.query(`update story_jobs set status = 'failed' where status in ('queued', 'running')`);
  });

  it('sweeper releases and retries once, then fails for good on the second timeout', async () => {
    const project = await newProject();
    const holdId = await withHold(project, { hold: 60 });
    const { handler, calls } = fakeAsync(); // the provider never finishes
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 30 });

    await tick({ projectId: project.id, now: T0 });
    expect((await sweep({ now: at(9 * 60) })).swept).toBe(0);

    const first = await sweep({ now: at(10 * 60) });
    expect(first).toMatchObject({ swept: 1, retried: 1, failed: 0 });
    expect(calls.poll).toContain(job.id); // polled once before giving up on it
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, provider_task_id: null });
    expect(new Date(row.run_after).getTime()).toBe(at(10 * 60 + 30).getTime());
    expect((await getBalance(project.user_id)).held).toBe(60); // kept for the retry
    expect(calls.fail).toHaveLength(0);

    await tick({ projectId: project.id, now: at(10 * 60 + 30) }); // resubmitted
    expect(calls.submit).toHaveLength(2);
    expect((await sweep({ now: at(10 * 60 + 30 + 9 * 60) })).swept).toBe(0);
    const second = await sweep({ now: at(10 * 60 + 30 + 10 * 60) });
    expect(second).toMatchObject({ swept: 1, failed: 1 });
    row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 2, error: 'This took too long. Please try again.' });
    expect((await getBalance(project.user_id)).held).toBe(30); // its share released
    expect(calls.fail).toEqual([expect.objectContaining({ id: job.id, blocked: false, final: true })]);

    await sweep({ now: at(7200) });
    expect((await getBalance(project.user_id)).held).toBe(30);
  });

  it('keeps a result that finished while the job looked stuck', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'done', url: '/mock/clip.mp4' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    const s = await sweep({ now: at(11 * 60) });
    expect(s).toMatchObject({ swept: 1, done: 1, retried: 0 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'done' });
    expect(calls.done).toHaveLength(1);
  });

  it('retries a sync job left running (the function died)', async () => {
    const project = await newProject();
    registerHandler('analyze', { sync: true, run: async () => ({}) });
    const job = await enqueue({ projectId: project.id, kind: 'analyze' });
    await storyDb().rpc('story_claim_jobs', { p_project: project.id, p_limit: 1, p_now: T0.toISOString() });
    const s = await sweep({ now: at(10 * 60) });
    expect(s).toMatchObject({ swept: 1, retried: 1 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
  });
});

describe('handleProviderCallback', () => {
  const kieDone = (taskId) => ({
    code: 200,
    data: { taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: ['/mock/clip.mp4'] }) },
  });

  async function submitted(handlerOpts) {
    const project = await newProject();
    const { handler, calls } = fakeAsync(handlerOpts);
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    return { project, job: await jobRow(job.id), calls };
  }

  it('finishes the job from a callback; a duplicate callback is a no-op', async () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
    const { job, calls } = await submitted();
    const first = await handleProviderCallback('mock', kieDone(job.provider_task_id), { token: 's3cret', now: at(5) });
    expect(first).toMatchObject({ ok: true, jobId: job.id, outcome: 'done' });
    const after = await jobRow(job.id);
    expect(after.status).toBe('done');

    const again = await handleProviderCallback('mock', kieDone(job.provider_task_id), { token: 's3cret', now: at(6) });
    expect(again).toEqual({ ok: true, ignored: true });
    expect(calls.done).toHaveLength(1);
    expect(mirror.calls).toHaveLength(1);
    expect(await jobRow(job.id)).toEqual(after);
  });

  it('onDone runs once when a callback and a poll finish the same job concurrently', async () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
    const { project, job, calls } = await submitted({ poll: async () => ({ status: 'done', url: '/mock/clip.mp4' }) });
    const [cb, t] = await Promise.all([
      handleProviderCallback('mock', kieDone(job.provider_task_id), { token: 's3cret', now: at(20) }),
      tick({ projectId: project.id, now: at(20) }),
    ]);
    expect(calls.done).toHaveLength(1);
    expect([cb.outcome === 'done' ? 1 : 0, t.done].reduce((a, b) => a + b)).toBe(1);
    expect(await jobRow(job.id)).toMatchObject({ status: 'done' });
  });

  it('a callback with a wrong token changes nothing', async () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
    const { job, calls } = await submitted();
    const before = await jobRow(job.id);
    expect(await handleProviderCallback('mock', kieDone(job.provider_task_id), { token: 'wrong', now: at(5) }))
      .toEqual({ ok: false, reason: 'unauthorized' });
    expect(await handleProviderCallback('mock', kieDone(job.provider_task_id), { now: at(5) }))
      .toEqual({ ok: false, reason: 'unauthorized' });
    expect(await jobRow(job.id)).toEqual(before);
    expect(calls.done).toHaveLength(0);
    expect(mirror.calls).toHaveLength(0);
  });

  it('fails closed without KIE_WEBHOOK_SECRET outside mock mode', () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', '');
    vi.stubEnv('STORY_MOCK', '');
    expect(verifyCallbackToken('anything')).toBe(false);
    vi.stubEnv('STORY_MOCK', '1');
    expect(verifyCallbackToken('anything')).toBe(true);
  });

  it('ignores callbacks for unknown tasks and pending updates', async () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
    const { job } = await submitted();
    expect(await handleProviderCallback('mock', kieDone('no-such-task'), { token: 's3cret' })).toEqual({ ok: true, ignored: true });
    expect(await handleProviderCallback('mock', { code: 200, data: { taskId: job.provider_task_id, state: 'generating' } }, { token: 's3cret' }))
      .toEqual({ ok: true, ignored: true });
    expect(await handleProviderCallback('mock', 'not json', { token: 's3cret' })).toEqual({ ok: true, ignored: true });
    expect((await jobRow(job.id)).status).toBe('running');
  });

  it('a failed callback retries the job', async () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
    const { job } = await submitted();
    const out = await handleProviderCallback('mock', { code: 501, msg: 'boom', data: { taskId: job.provider_task_id, state: 'fail' } }, { token: 's3cret', now: at(5) });
    expect(out.outcome).toBe('retried');
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', provider_task_id: null });
  });
});

describe('helpers', () => {
  it('enqueue takes the owner from the project and needs userId without one', async () => {
    const project = await newProject();
    const job = await enqueue({ projectId: project.id, kind: 'clip', payload: { a: 1 } });
    expect(job).toMatchObject({ user_id: project.user_id, status: 'queued', attempts: 0, payload: { a: 1 } });
    await expect(enqueue({ kind: 'voice_clone' })).rejects.toThrow(/userId/);
    await expect(enqueue({ projectId: project.id, kind: 'dance' })).rejects.toThrow(/unknown job kind/);
    await expect(enqueue({ projectId: project.id, kind: 'clip', userId: randomUUID() })).rejects.toThrow(/own/);
  });

  it('registerHandler checks the handler shape', () => {
    expect(() => registerHandler('clip', { submit: async () => {} })).toThrow(/poll/);
    expect(() => registerHandler('script', { sync: true })).toThrow(/run/);
    expect(() => registerHandler('nope', { sync: true, run: async () => {} })).toThrow(/unknown/);
  });

  it('a job with no registered handler is put back without using an attempt', async () => {
    const project = await newProject();
    const job = await enqueue({ projectId: project.id, kind: 'music' });
    await tick({ projectId: project.id, now: T0 });
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 0 });
    expect(new Date(row.run_after).getTime()).toBe(at(60).getTime());
  });

  it('callbackUrl builds the kie webhook URL with the token', () => {
    vi.stubEnv('APP_URL', 'https://app.example.test/');
    vi.stubEnv('KIE_WEBHOOK_SECRET', 'a b&c');
    expect(callbackUrl()).toBe('https://app.example.test/api/webhooks/kie?token=a%20b%26c');
    vi.stubEnv('KIE_WEBHOOK_SECRET', '');
    expect(callbackUrl()).toBeNull();
  });
});

describe('routes', () => {
  const resMock = () => {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    return res;
  };

  it('webhook: POST only, 401 on a bad token, 200 otherwise', async () => {
    vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
    const { default: kie } = await import('../../pages/api/webhooks/kie.js');
    let res = resMock();
    await kie({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(405);
    res = resMock();
    await kie({ method: 'POST', query: { token: 'nope' }, body: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });

    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    const taskId = (await jobRow(job.id)).provider_task_id;
    res = resMock();
    await kie({
      method: 'POST',
      query: { token: 's3cret' },
      body: { code: 200, data: { taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: ['/mock/clip.mp4'] }) } },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(calls.done).toHaveLength(1);
  });

  it('cron: needs the CRON_SECRET bearer, then sweeps and ticks', async () => {
    const { default: cron, config } = await import('../../pages/api/cron/story-tick.js');
    expect(config.maxDuration).toBe(60);
    let res = resMock();
    await cron({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(401);
    res = resMock();
    await cron({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);

    // Other tests leave jobs behind; this one wants the budget to itself.
    await raw.query(`update story_jobs set status = 'failed' where status in ('queued', 'running')`);
    const project = await newProject();
    const ran = [];
    registerHandler('script', { sync: true, run: async (job) => { ran.push(job.id); return {}; } });
    const job = await enqueue({ projectId: project.id, kind: 'script' });
    res = resMock();
    await cron({ method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ran).toContain(job.id);
    expect((await jobRow(job.id)).status).toBe('done');
  });
});
