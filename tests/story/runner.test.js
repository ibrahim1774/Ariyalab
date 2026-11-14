import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createPgAdapter, setStoryDb, storyDb } from '../../lib/story/db.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { ProviderError } from '../../lib/providers/errors.js';
import { MOCK_URLS } from '../../lib/providers/mock.js';
import { getImage, submitImage } from '../../lib/providers/image.js';

// mirrorUrl is the real mock-mode copy unless a test makes it fail or slow.
const mirror = vi.hoisted(() => ({ fail: 0, failWith: null, calls: [], delayMs: 0, inFlight: 0, maxInFlight: 0 }));
vi.mock('../../lib/providers/storage.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    mirrorUrl: async (args) => {
      mirror.calls.push(args);
      mirror.inFlight += 1;
      mirror.maxInFlight = Math.max(mirror.maxInFlight, mirror.inFlight);
      try {
        if (mirror.delayMs) await new Promise((r) => setTimeout(r, mirror.delayMs));
        if (mirror.fail > 0) {
          mirror.fail -= 1;
          throw mirror.failWith || new Error('upload refused');
        }
        return await real.mirrorUrl(args);
      } finally {
        mirror.inFlight -= 1;
      }
    },
  };
});

// releaseHold is real unless a test makes it fail.
const credit = vi.hoisted(() => ({ releaseFail: 0, releases: [] }));
vi.mock('../../lib/credits.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    releaseHold: async (args) => {
      credit.releases.push(args);
      if (credit.releaseFail > 0) {
        credit.releaseFail -= 1;
        throw new Error('database unavailable');
      }
      return real.releaseHold(args);
    },
  };
});

const { setCreditsDb, grantCredits, holdCredits, settleHold, getBalance } = await import('../../lib/credits.js');
const runner = await import('../../lib/story/runner.js');
const {
  enqueue, tick, sweep, handleProviderCallback, registerHandler, _resetHandlers, registeredKinds,
  activeJobs, callbackUrl, callbackSignature, runWorkerJob, runCron, RUNNER_CONFIG, JOB_KINDS,
} = runner;

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
let warnSpy;
beforeEach(async () => {
  Object.assign(mirror, { fail: 0, failWith: null, calls: [], delayMs: 0, inFlight: 0, maxInFlight: 0 });
  Object.assign(credit, { releaseFail: 0, releases: [] });
  logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('KIE_WEBHOOK_SECRET', 's3cret');
  // Every test starts with no other job in flight (sweep and the cron look at every project).
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where status in ('queued', 'running') or applied_at is null`);
});
afterEach(() => {
  setStoryDb(raw);
  _resetHandlers();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
});

const T0 = new Date('2026-11-14T12:00:00.000Z');
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);
const MIN = 60;

async function newProject() {
  const [project] = await storyDb().insert('story_projects', { user_id: randomUUID() });
  return project;
}
const jobRow = async (id) => (await raw.query('select * from story_jobs where id = $1', [id])).rows[0];
const held = async (project) => (await getBalance(project.user_id)).held;

/** An async handler whose provider is a controllable fake. */
function fakeAsync({ submit, poll, onDone, onFail } = {}) {
  const calls = { submit: [], poll: [], done: [], fail: [] };
  let n = 0;
  const handler = {
    submit: async (job) => {
      calls.submit.push(job.id);
      if (submit) return submit(job);
      n += 1;
      return { provider: 'mock', taskId: `task-${job.id}-${job.attempts}-${n}` };
    },
    poll: async (job) => {
      calls.poll.push(job.id);
      return poll ? poll(job) : { status: 'pending', url: null, error: null };
    },
    onDone: async (job, result) => {
      calls.done.push({ id: job.id, status: job.status, result });
      if (onDone) await onDone(job, result);
    },
    onFail: async (job, info) => {
      calls.fail.push({ id: job.id, status: job.status, ...info });
      if (onFail) await onFail(job, info);
    },
  };
  return { handler, calls };
}
const doneWith = (url) => async () => ({ status: 'done', url, error: null });

async function withHold(project, { grant = 100, hold = 60 } = {}) {
  await grantCredits({ userId: project.user_id, currency: 'video', amount: grant, bucket: 'plan', reason: 'test', ref: randomUUID() });
  return holdCredits({ userId: project.user_id, currency: 'video', amount: hold, projectId: project.id });
}

/** A storyDb adapter that throws for updates matching `fails(patch)` (n times). */
function flakyDb(fails, times = 1) {
  const base = createPgAdapter(raw);
  let left = times;
  return {
    ...base,
    update: async (table, match, patch) => {
      if (left > 0 && fails(table, match, patch)) {
        left -= 1;
        throw new Error('connection reset');
      }
      return base.update(table, match, patch);
    },
  };
}

const sigFor = (jobId, attempt) => createHmac('sha256', 's3cret').update(`kie:${jobId}:${attempt}`).digest('hex');
const kieBody = (taskId, extra = {}) => ({ code: 200, data: { taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://evil.example/x.mp4'] }), ...extra } });

// ---------------------------------------------------------------- claiming and throttling

describe('tick: claiming', () => {
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
  });

  it('throttle never submits more than 15 in one tick', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    for (let i = 0; i < 20; i++) await enqueue({ projectId: project.id, kind: 'still' });
    const s = await tick({ projectId: project.id, now: T0, limit: 50 });
    expect(RUNNER_CONFIG.submitsPerTick).toBe(15);
    expect(s).toMatchObject({ claimed: 15, submitted: 15 });
    expect(calls.submit).toHaveLength(15);
    const queued = (await activeJobs(project.id)).filter((j) => j.status === 'queued');
    expect(queued).toHaveLength(5);
    const rows = await raw.query(`select attempts from story_jobs where project_id = $1 and status = 'queued'`, [project.id]);
    expect(rows.rows.every((r) => r.attempts === 0)).toBe(true);
  });

  it('sync jobs do not use the provider-submit budget', async () => {
    const project = await newProject();
    const { handler } = fakeAsync();
    registerHandler('still', handler);
    registerHandler('script', { sync: true, run: async () => ({ ok: true }) });
    for (let i = 0; i < 15; i++) await enqueue({ projectId: project.id, kind: 'still' });
    for (let i = 0; i < 3; i++) await enqueue({ projectId: project.id, kind: 'script' });
    const budget = { submits: 15 };
    const s = await tick({ projectId: project.id, now: T0, limit: 50, budget });
    expect(s).toMatchObject({ claimed: 18, submitted: 15, done: 3 });
    expect(budget.submits).toBe(0);
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
    await tick({ projectId: p1.id, now: T0, budget, limit: 50 });
    await tick({ projectId: p2.id, now: T0, budget, limit: 50 });
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
  });

  it('claims nothing once the deadline has passed', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    await enqueue({ projectId: project.id, kind: 'clip' });
    const s = await tick({ projectId: project.id, now: T0, deadline: Date.now() - 1 });
    expect(s.claimed).toBe(0);
    expect(calls.submit).toHaveLength(0);
    expect((await activeJobs(project.id))[0].status).toBe('queued');
  });

  it('claims account-level jobs (no project) when projectId is null', async () => {
    const userId = randomUUID();
    registerHandler('voice_clone', { sync: true, run: async () => ({ voiceId: 'v1' }) });
    const job = await enqueue({ userId, kind: 'voice_clone', payload: { name: 'Me' } });
    expect(await tick({ projectId: null, now: T0 })).toMatchObject({ claimed: 1, done: 1 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'done', result: { voiceId: 'v1' } });
  });

  it('one job failing unexpectedly does not stop the rest of the tick', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    const a = await enqueue({ projectId: project.id, kind: 'still' });
    const b = await enqueue({ projectId: project.id, kind: 'still' });
    // Every write of a's task id fails (the database is unreachable for that row).
    setStoryDb(flakyDb((t, m, p) => m.id === a.id && p.provider_task_id, 10));
    const s = await tick({ projectId: project.id, now: T0 });
    setStoryDb(raw);
    expect([...calls.submit].sort()).toEqual([a.id, b.id].sort());
    expect(s.submitted).toBe(1);
    expect(await jobRow(b.id)).toMatchObject({ status: 'running' });
    // a reached the provider but its task id was never stored: never re-submitted.
    const rowA = await jobRow(a.id);
    expect(rowA).toMatchObject({ status: 'running', provider_task_id: null });
    expect(rowA.submitted_at).not.toBeNull();
    await sweep({ now: at(3 * MIN) });
    expect(await jobRow(a.id)).toMatchObject({ status: 'failed' });
    expect(calls.submit).toHaveLength(2);
  });

  it('retries the task-id write in place', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    setStoryDb(flakyDb((t, m, p) => p.provider_task_id, 2));
    await tick({ projectId: project.id, now: T0 });
    setStoryDb(raw);
    expect((await jobRow(job.id)).provider_task_id).toMatch(/^task-/);
    expect(calls.submit).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- submit outcomes

describe('submit outcomes', () => {
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
    const j1 = await enqueue({ projectId: project.id, kind: 'clip' });
    const j2 = await enqueue({ projectId: project.id, kind: 'clip' });

    await tick({ projectId: project.id, now: T0 });
    // Whichever was claimed first met the rate limit; the other was never claimed.
    const job = calls.submit[0] === j1.id ? j1 : j2;
    const other = job === j1 ? j2 : j1;
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 0, provider_task_id: null, started_at: null });
    expect(row.run_after.getTime()).toBe(at(10).getTime());
    expect(calls.submit).toEqual([job.id]); // the provider is busy: nothing else is submitted this tick
    expect(await jobRow(other.id)).toMatchObject({ status: 'queued', attempts: 0 });

    expect((await tick({ projectId: project.id, now: at(9), limit: 1 })).claimed).toBe(1); // only `other` is due
    busy = false;
    await tick({ projectId: project.id, now: at(10) });
    row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'running', attempts: 1, provider_task_id: `t-${job.id}`, rate_limited_since: null });
  });

  it('a job rate-limited for more than 30 minutes fails for good and releases its hold share', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('rate_limited'); } });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 20 });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(29 * MIN) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
    await tick({ projectId: project.id, now: at(30 * MIN + 1) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    expect(await held(project)).toBe(40);
    expect(calls.fail).toEqual([expect.objectContaining({ blocked: false, final: true })]);
  });

  it('an ambiguous submit (timed out) fails for good instead of submitting again', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('failed', undefined, { cause: timeout }); } });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 25 });
    await tick({ projectId: project.id, now: T0 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    await tick({ projectId: project.id, now: at(MIN) });
    expect(calls.submit).toHaveLength(1);
    expect(await held(project)).toBe(35);
  });

  it("a 'blocked' result marks the job blocked and calls onFail with blocked: true", async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'blocked', url: null, error: 'Not allowed.' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 25 });
    await tick({ projectId: project.id, now: T0 });
    expect((await tick({ projectId: project.id, now: at(20) })).failed).toBe(1);
    expect(await jobRow(job.id)).toMatchObject({ status: 'blocked', error: 'Not allowed.', attempts: 1 });
    expect(calls.fail).toEqual([{ id: job.id, status: 'blocked', blocked: true, error: 'Not allowed.', final: true }]);
    expect(calls.submit).toHaveLength(1);
    expect(await held(project)).toBe(35);
    expect((await jobRow(job.id)).applied_at).not.toBeNull();
  });

  it('a blocked submit is final too', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('blocked'); } });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'blocked' });
    expect(calls.fail).toEqual([expect.objectContaining({ blocked: true, final: true })]);
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

  it('a provider failure retries once after 30 seconds, then fails for good', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'failed', url: null, error: 'Generation failed. Please try again.' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 20 });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, provider_task_id: null });
    expect(row.run_after.getTime()).toBe(at(45).getTime());
    expect(await held(project)).toBe(60); // a retry keeps the hold
    await tick({ projectId: project.id, now: at(45) });
    await tick({ projectId: project.id, now: at(60) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await held(project)).toBe(40);
    expect(calls.submit).toHaveLength(2);
    expect(calls.fail).toHaveLength(1);
    expect(RUNNER_CONFIG.maxAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------- polling

describe('tick: polling', () => {
  it('polls when locked_until passed, mirrors under our key and runs onDone once', async () => {
    const project = await newProject();
    let ready = false;
    const { handler, calls } = fakeAsync({ poll: async () => (ready ? { status: 'done', url: MOCK_URLS.clip, error: null } : { status: 'pending', url: null, error: null }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    expect((await tick({ projectId: project.id, now: at(5) })).polled).toBe(0);
    expect((await tick({ projectId: project.id, now: at(15) })).polled).toBe(1);
    ready = true;
    expect(await tick({ projectId: project.id, now: at(30) })).toMatchObject({ polled: 1, done: 1 });
    const key = `story/${project.id}/clip/${job.id}.mp4`;
    expect(calls.done).toEqual([{ id: job.id, status: 'done', result: { url: `/api/mock/storage/${key}`, key } }]);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'done', result: { url: `/api/mock/storage/${key}`, key } });
    expect(row.applied_at).not.toBeNull();
    expect(await tick({ projectId: project.id, now: at(60) })).toMatchObject({ polled: 0, done: 0 });
  });

  it('caps polls at 20 per tick', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    for (let i = 0; i < 25; i++) await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(1) });
    expect((await tick({ projectId: project.id, now: at(60) })).polled).toBe(20);
    expect(calls.poll).toHaveLength(20);
  });

  it('overlapping ticks poll a job once (lease) ', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ poll: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: 'pending', url: null, error: null };
    } });
    registerHandler('clip', handler);
    await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    await Promise.all([1, 2, 3].map(() => tick({ projectId: project.id, now: at(20) })));
    expect(calls.poll).toHaveLength(1);
  });

  it('runs at most 4 mirrors at once', async () => {
    const project = await newProject();
    const { handler } = fakeAsync({ poll: doneWith(MOCK_URLS.still) });
    registerHandler('still', handler);
    for (let i = 0; i < 10; i++) await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    mirror.delayMs = 15;
    const s = await tick({ projectId: project.id, now: at(20) });
    expect(s.done).toBe(10);
    expect(mirror.maxInFlight).toBe(4);
  });

  it('a thrown network error from poll counts as pending; a provider error twice in a row is a failure', async () => {
    const project = await newProject();
    let mode = 'network';
    const { handler, calls } = fakeAsync({ poll: async () => {
      if (mode === 'network') throw new ProviderError('failed', undefined, { cause: new TypeError('fetch failed') });
      throw new ProviderError('failed', undefined, { cause: { status: 200, code: 500, message: 'task error' } });
    } });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(20) });
    await tick({ projectId: project.id, now: at(40) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'running', poll_errors: 0 });
    mode = 'provider';
    await tick({ projectId: project.id, now: at(60) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'running', poll_errors: 1 });
    await tick({ projectId: project.id, now: at(80) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 1 }); // treated as a provider failure
    expect(calls.poll).toHaveLength(4);
  });

  it('sets files_expire_at once, from retentionDays in pricing config', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('retentionDays', '7'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const project = await newProject();
      const { handler } = fakeAsync({ poll: doneWith(MOCK_URLS.still) });
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
});

// ---------------------------------------------------------------- slow tasks (C2)

describe('slow provider tasks', () => {
  it('a clip still generating after 10 minutes keeps its task (no second submit); at 45 minutes it fails for good', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 30 });
    await tick({ projectId: project.id, now: T0 });
    const taskId = (await jobRow(job.id)).provider_task_id;

    await sweep({ now: at(11 * MIN) });
    await tick({ projectId: project.id, now: at(11 * MIN) });
    await sweep({ now: at(30 * MIN) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'running', provider_task_id: taskId, attempts: 1 });
    expect(await held(project)).toBe(60);

    await tick({ projectId: project.id, now: at(45 * MIN) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', error: 'This took too long. Please try again.' });
    expect(calls.submit).toHaveLength(1);
    expect(await held(project)).toBe(30);
    expect(calls.fail).toHaveLength(1);
  });

  it('images get a 15 minute cap', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    await sweep({ now: at(14 * MIN) });
    expect((await jobRow(job.id)).status).toBe('running');
    await sweep({ now: at(15 * MIN) });
    expect((await jobRow(job.id)).status).toBe('failed');
    expect(calls.poll.length).toBeGreaterThan(0); // asked once more before giving up
    expect(RUNNER_CONFIG.taskHardCapMinutes).toMatchObject({ clip: 45, still: 15, cast_image: 15 });
  });

  it('keeps a result that finished just before the cap', async () => {
    const project = await newProject();
    let ready = false;
    const { handler, calls } = fakeAsync({ poll: async () => (ready ? { status: 'done', url: MOCK_URLS.still, error: null } : { status: 'pending', url: null, error: null }) });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    ready = true;
    await sweep({ now: at(16 * MIN) });
    expect((await jobRow(job.id)).status).toBe('done');
    expect(calls.done).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- mirror failures (C3)

describe('mirror failures', () => {
  it('a transient mirror failure retries the mirror only, then finishes', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ poll: doneWith(MOCK_URLS.still) });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    const taskId = (await tick({ projectId: project.id, now: T0 }), (await jobRow(job.id)).provider_task_id);
    mirror.fail = 1;
    await tick({ projectId: project.id, now: at(15) });
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'running', provider_task_id: taskId, mirror_tries: 1 });
    expect(row.locked_until.getTime()).toBe(at(15 + 30).getTime());
    await tick({ projectId: project.id, now: at(45) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(calls.submit).toHaveLength(1);
    expect(calls.done).toHaveLength(1);
  });

  it('fails for good after 4 mirror failures without submitting again', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ poll: doneWith(MOCK_URLS.still) });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still', holdId, costCredits: 10 });
    await tick({ projectId: project.id, now: T0 });
    mirror.fail = 10;
    for (const t of [15, 60, 200, 500, 1000]) await tick({ projectId: project.id, now: at(t) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', mirror_tries: 4 });
    expect(mirror.calls).toHaveLength(4);
    expect(calls.submit).toHaveLength(1);
    expect(await held(project)).toBe(50);
  });

  it('fails at once when the file is not the right kind of media', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync({ poll: doneWith(MOCK_URLS.clip) }); // a video for an image job
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    expect(calls.submit).toHaveLength(1);
    // every image type was tried under its own extension
    expect(mirror.calls.map((c) => c.key.split('.').pop())).toEqual(['png', 'jpg', 'webp']);
  });

  it('stores only extensions storage accepts', () => {
    expect(RUNNER_CONFIG.mediaExtensions).toEqual({ image: ['png', 'jpg', 'webp'], video: ['mp4'], audio: ['mp3', 'm4a', 'wav'] });
  });
});

// ---------------------------------------------------------------- side effects and repair (C1)

describe('applying results', () => {
  it('an onDone that throws is retried by the sweeper until it succeeds', async () => {
    const project = await newProject();
    let throws = 2;
    const { handler, calls } = fakeAsync({
      poll: doneWith(MOCK_URLS.still),
      onDone: async () => { if (throws-- > 0) throw new Error('shot table locked'); },
    });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'done', applied_at: null, apply_tries: 1 });
    await sweep({ now: at(15 + 30) }); // lease not over yet
    expect(calls.done).toHaveLength(1);
    await sweep({ now: at(15 + 61) });
    await sweep({ now: at(15 + 61 + 121) });
    row = await jobRow(job.id);
    expect(row.applied_at).not.toBeNull();
    expect(calls.done).toHaveLength(3);
    expect(calls.done.every((d) => d.result.key === row.result.key)).toBe(true);
  });

  it('an onDone that keeps throwing turns into a final failure after 5 tries', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ poll: doneWith(MOCK_URLS.still), onDone: async () => { throw new Error('bug'); } });
    registerHandler('still', handler);
    const job = await enqueue({ projectId: project.id, kind: 'still', holdId, costCredits: 10 });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    for (let i = 1; i <= 6; i++) await sweep({ now: at(15 + i * 3600) });
    expect(calls.done).toHaveLength(5);
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    expect(calls.fail).toHaveLength(1);
    expect(await held(project)).toBe(50);
    expect((await jobRow(job.id)).applied_at).not.toBeNull();
  });

  it('a hold release that fails is repaired by the sweeper, then onFail runs once', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('blocked'); } });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 20 });
    credit.releaseFail = 1;
    await tick({ projectId: project.id, now: T0 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'blocked', applied_at: null });
    expect(await held(project)).toBe(60);
    expect(calls.fail).toHaveLength(0);
    await sweep({ now: at(2 * MIN) });
    expect(await held(project)).toBe(40);
    expect(calls.fail).toHaveLength(1);
    expect((await jobRow(job.id)).applied_at).not.toBeNull();
    await sweep({ now: at(10 * MIN) });
    expect(calls.fail).toHaveLength(1);
  });

  it('a hold share is released exactly once on final failure', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const { handler, calls } = fakeAsync({ poll: async () => ({ status: 'failed', url: null, error: 'Generation failed. Please try again.' }) });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 20 });
    await tick({ projectId: project.id, now: T0 });
    await tick({ projectId: project.id, now: at(15) });
    await tick({ projectId: project.id, now: at(45) });
    await tick({ projectId: project.id, now: at(60) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    await sweep({ now: at(3600) });
    await tick({ projectId: project.id, now: at(3600) });
    expect(await held(project)).toBe(40);
    expect(calls.fail).toHaveLength(1);
    const { rows } = await raw.query(
      `select count(*)::int as n from credit_ledger where hold_id = $1 and ref = $2 and op = 'release'`,
      [holdId, `${holdId}:job:${job.id}`]
    );
    expect(rows[0].n).toBe(1);
  });

  it('a hold that is already closed does not block onFail', async () => {
    const project = await newProject();
    const holdId = await withHold(project, { hold: 20 });
    await settleHold({ holdId, amount: 20, reason: 'test_settle', ref: randomUUID() });
    const { handler, calls } = fakeAsync({ submit: async () => { throw new ProviderError('blocked'); } });
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 20 });
    await tick({ projectId: project.id, now: T0 });
    expect(calls.fail).toHaveLength(1);
    expect((await jobRow(job.id)).applied_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------- sweep of jobs without a task

describe('sweep', () => {
  it('re-queues a job that crashed before it was submitted, giving the attempt back', async () => {
    const project = await newProject();
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await storyDb().rpc('story_claim_jobs', { p_project: project.id, p_limit: 1, p_now: T0.toISOString() });
    expect((await sweep({ now: at(MIN) })).swept).toBe(0); // the claim lease (2 min) still runs
    await sweep({ now: at(2 * MIN) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('fails a job whose submit outcome is unknown instead of submitting it again', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const job = await enqueue({ projectId: project.id, kind: 'clip', holdId, costCredits: 15 });
    await storyDb().rpc('story_claim_jobs', { p_project: project.id, p_limit: 1, p_now: T0.toISOString() });
    await raw.query(`update story_jobs set submitted_at = $2 where id = $1`, [job.id, T0]);
    await sweep({ now: at(2 * MIN) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    expect(await held(project)).toBe(45);
  });

  it('retries a sync job left running after 10 minutes (keeping the attempt)', async () => {
    const project = await newProject();
    registerHandler('analyze', { sync: true, run: async () => ({}) });
    const job = await enqueue({ projectId: project.id, kind: 'analyze' });
    await storyDb().rpc('story_claim_jobs', { p_project: project.id, p_limit: 1, p_now: T0.toISOString() });
    expect((await sweep({ now: at(9 * MIN) })).retried).toBe(0);
    expect(await sweep({ now: at(10 * MIN) })).toMatchObject({ swept: 1, retried: 1 });
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('does nothing once its deadline has passed', async () => {
    const project = await newProject();
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await storyDb().rpc('story_claim_jobs', { p_project: project.id, p_limit: 1, p_now: T0.toISOString() });
    await sweep({ now: at(10 * MIN), deadline: Date.now() - 1 });
    expect((await jobRow(job.id)).status).toBe('running');
  });

  it('a job with no handler is put back for 5 minutes, outside the submit budget, and fails after 5 rounds', async () => {
    const project = await newProject();
    const holdId = await withHold(project);
    const job = await enqueue({ projectId: project.id, kind: 'music', holdId, costCredits: 5 });
    const budget = { submits: 15 };
    await tick({ projectId: project.id, now: T0, budget });
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 0, no_handler_rounds: 1 });
    expect(row.run_after.getTime()).toBe(at(5 * MIN).getTime());
    expect(budget.submits).toBe(15);
    for (let i = 1; i < 5; i++) await tick({ projectId: project.id, now: at(i * 5 * MIN) });
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' });
    expect(await held(project)).toBe(55);
  });
});

// ---------------------------------------------------------------- sync, worker kinds

describe('sync and worker kinds', () => {
  it('runs a sync job inside the tick and marks it done', async () => {
    const project = await newProject();
    const done = [];
    registerHandler('script', {
      sync: true,
      run: async (job) => ({ scenes: [{ id: 's1' }], echo: job.payload.x }),
      onDone: async (job, result) => done.push({ id: job.id, result }),
    });
    const job = await enqueue({ projectId: project.id, kind: 'script', payload: { x: 1 } });
    expect(await tick({ projectId: project.id, now: T0 })).toMatchObject({ claimed: 1, done: 1 });
    expect(done).toEqual([{ id: job.id, result: { scenes: [{ id: 's1' }], echo: 1 } }]);
    expect(mirror.calls).toHaveLength(0);
  });

  it('mirrors a sync media result that has a provider url but no key', async () => {
    const project = await newProject();
    const done = [];
    registerHandler('narration', { sync: true, run: async () => ({ url: MOCK_URLS.voice, seconds: 30 }), onDone: async (j, r) => done.push(r) });
    const job = await enqueue({ projectId: project.id, kind: 'narration' });
    await tick({ projectId: project.id, now: T0 });
    const key = `story/${project.id}/narration/${job.id}.mp3`;
    expect(done).toEqual([{ url: `/api/mock/storage/${key}`, key, seconds: 30 }]);
  });

  it('retries a failed sync job once after 30 seconds, then fails it for good', async () => {
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
    expect((await jobRow(job.id)).run_after.getTime()).toBe(at(30).getTime());
    expect((await tick({ projectId: project.id, now: at(29) })).claimed).toBe(0);
    expect(await tick({ projectId: project.id, now: at(30) })).toMatchObject({ failed: 1 });
    expect(runs).toBe(2);
    expect(fails).toEqual([{ status: 'failed', blocked: false, error: 'Generation failed. Please try again.', final: true }]);
  });

  it('runSync false leaves sync jobs queued', async () => {
    const project = await newProject();
    const { handler } = fakeAsync();
    registerHandler('still', handler);
    registerHandler('script', { sync: true, run: async () => ({}) });
    const s1 = await enqueue({ projectId: project.id, kind: 'script' });
    const st = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0, runSync: false });
    expect((await jobRow(s1.id)).status).toBe('queued');
    expect((await jobRow(st.id)).status).toBe('running');
  });

  it('never runs a worker kind (render) inside tick; runWorkerJob does', async () => {
    const project = await newProject();
    const ran = [];
    registerHandler('render', { sync: true, run: async (job) => { ran.push(job.id); return { url: MOCK_URLS.clip }; } });
    const job = await enqueue({ projectId: project.id, kind: 'render' });
    await tick({ projectId: project.id, now: T0 });
    expect((await jobRow(job.id)).status).toBe('queued');
    expect(await runWorkerJob('render', { now: T0 })).toMatchObject({ claimed: true, jobId: job.id, outcome: 'done' });
    expect(ran).toEqual([job.id]);
    expect((await jobRow(job.id)).result.key).toBe(`story/${project.id}/render/${job.id}.mp4`);
    expect(await runWorkerJob('render', { now: T0 })).toEqual({ claimed: false });
    await expect(runWorkerJob('clip', { now: T0 })).rejects.toThrow(/worker kind/);
  });
});

// ---------------------------------------------------------------- webhook (nudge only)

describe('handleProviderCallback (nudge only)', () => {
  async function submitted(opts) {
    const project = await newProject();
    const { handler, calls } = fakeAsync(opts);
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    return { project, job: await jobRow(job.id), calls };
  }
  const call = (job, { sig = sigFor(job.id, job.attempts), body = kieBody(job.provider_task_id), headers = {}, now = at(5) } = {}) =>
    handleProviderCallback('mock', body, { jobId: job.id, sig, headers, now });

  it('verifies the signature, nudges the job (locked_until = now) and changes nothing else', async () => {
    const { project, job, calls } = await submitted();
    expect(await call(job)).toEqual({ ok: true, nudged: true, jobId: job.id });
    const row = await jobRow(job.id);
    expect(row.locked_until.getTime()).toBe(at(5).getTime());
    expect(row.status).toBe('running');
    expect(calls.poll).toHaveLength(0); // no provider call inside the webhook
    expect(mirror.calls).toHaveLength(0);
    await tick({ projectId: project.id, now: at(5) }); // polls at once
    expect(calls.poll).toHaveLength(1);
  });

  it('never trusts status or url from the callback body', async () => {
    const { project, job, calls } = await submitted({ poll: doneWith(MOCK_URLS.clip) });
    await call(job, { body: kieBody(job.provider_task_id) }); // says success with an attacker URL
    await tick({ projectId: project.id, now: at(5) });
    expect(mirror.calls.map((c) => c.srcUrl)).toEqual([MOCK_URLS.clip]);
    expect(calls.done).toHaveLength(1);
  });

  it('a duplicate callback is a no-op', async () => {
    const { project, job, calls } = await submitted({ poll: doneWith(MOCK_URLS.clip) });
    await call(job);
    await tick({ projectId: project.id, now: at(5) });
    const after = await jobRow(job.id);
    expect(await call(job, { now: at(6) })).toEqual({ ok: true, ignored: true });
    expect(await jobRow(job.id)).toEqual(after);
    expect(calls.done).toHaveLength(1);
  });

  it('a callback with a wrong, short or missing signature changes nothing', async () => {
    const { job } = await submitted();
    const before = await jobRow(job.id);
    for (const sig of ['wrong', '', null, sigFor(job.id, job.attempts).slice(0, 10), sigFor(job.id, job.attempts + 1)]) {
      expect(await call(job, { sig })).toEqual({ ok: false, reason: 'unauthorized' });
    }
    expect(await handleProviderCallback('mock', kieBody(job.provider_task_id), { jobId: 'not-a-uuid', sig: 'x' }))
      .toEqual({ ok: false, reason: 'unauthorized' });
    expect(await jobRow(job.id)).toEqual(before);
  });

  it("a URL for job A cannot nudge job B", async () => {
    const a = await submitted();
    const b = await submitted();
    const before = await jobRow(b.job.id);
    expect(await handleProviderCallback('mock', kieBody(b.job.provider_task_id), { jobId: b.job.id, sig: sigFor(a.job.id, a.job.attempts) }))
      .toEqual({ ok: false, reason: 'unauthorized' });
    expect(await jobRow(b.job.id)).toEqual(before);
  });

  it("a stale attempt's signature is rejected after a retry", async () => {
    const { project, job } = await submitted({ poll: async () => ({ status: 'failed', url: null, error: null }) });
    const oldSig = sigFor(job.id, job.attempts);
    await tick({ projectId: project.id, now: at(15) }); // failed -> retry
    await tick({ projectId: project.id, now: at(45) }); // attempt 2 submitted
    const now2 = await jobRow(job.id);
    expect(now2.attempts).toBe(2);
    expect(await call(now2, { sig: oldSig })).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await call(now2)).toMatchObject({ ok: true, nudged: true });
  });

  it('ignores a callback whose task id is not the current one, with a warning naming the task', async () => {
    const { job } = await submitted();
    const before = await jobRow(job.id);
    expect(await call(job, { body: kieBody('orphan-task-1') })).toEqual({ ok: true, ignored: true });
    expect(await jobRow(job.id)).toEqual(before);
    expect(warnSpy.mock.calls.some((c) => c.join(' ').includes('orphan-task-1'))).toBe(true);
  });

  it('fails closed without KIE_WEBHOOK_SECRET outside mock mode', async () => {
    const { job } = await submitted();
    vi.stubEnv('KIE_WEBHOOK_SECRET', '');
    vi.stubEnv('STORY_MOCK', '');
    expect(await call(job, { sig: 'anything' })).toEqual({ ok: false, reason: 'unauthorized' });
    vi.stubEnv('STORY_MOCK', '1');
    expect(await call(job, { sig: 'anything' })).toMatchObject({ ok: true, nudged: true });
  });

  it("checks kie's own signature headers when KIE_WEBHOOK_HMAC_KEY is set", async () => {
    const { job } = await submitted();
    vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'kie-key');
    const ts = String(Math.floor(at(5).getTime() / 1000));
    const good = createHmac('sha256', 'kie-key').update(`${job.provider_task_id}.${ts}`).digest('base64');
    expect(await call(job, { headers: {} })).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await call(job, { headers: { 'x-webhook-timestamp': ts, 'x-webhook-signature': 'bad' } })).toEqual({ ok: false, reason: 'unauthorized' });
    const stale = String(Math.floor(at(-3600).getTime() / 1000));
    const staleSig = createHmac('sha256', 'kie-key').update(`${job.provider_task_id}.${stale}`).digest('base64');
    expect(await call(job, { headers: { 'x-webhook-timestamp': stale, 'x-webhook-signature': staleSig } })).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await call(job, { headers: { 'x-webhook-timestamp': ts, 'x-webhook-signature': good } })).toMatchObject({ ok: true, nudged: true });
  });

  it('a mock image job finished after a webhook nudge is stored as a png', async () => {
    const project = await newProject();
    const done = [];
    registerHandler('still', {
      submit: async () => submitImage({ prompt: 'A red kite over a beach' }),
      poll: async (job) => getImage({ provider: job.provider, taskId: job.provider_task_id }),
      onDone: async (job, result) => done.push(result),
    });
    const job = await enqueue({ projectId: project.id, kind: 'still' });
    await tick({ projectId: project.id, now: T0 });
    const row = await jobRow(job.id);
    await handleProviderCallback('mock', { code: 200, data: { taskId: row.provider_task_id, state: 'success' } }, { jobId: job.id, sig: sigFor(job.id, row.attempts), now: at(1) });
    await tick({ projectId: project.id, now: at(1) });
    await tick({ projectId: project.id, now: at(20) });
    expect(done).toEqual([expect.objectContaining({ key: `story/${project.id}/still/${job.id}.png` })]);
  });

  it('callbackUrl carries the job id and a per-attempt signature, never the secret', () => {
    vi.stubEnv('APP_URL', 'https://app.example.test/');
    const job = { id: randomUUID(), attempts: 2 };
    const url = callbackUrl(job);
    expect(url).toBe(`https://app.example.test/api/webhooks/kie?job=${job.id}&sig=${sigFor(job.id, 2)}`);
    expect(url).not.toContain('s3cret');
    expect(callbackSignature(job.id, 2)).toBe(sigFor(job.id, 2));
    vi.stubEnv('KIE_WEBHOOK_SECRET', '');
    expect(callbackUrl(job)).toBeNull();
  });
});

// ---------------------------------------------------------------- cron

describe('runCron', () => {
  it('shares the budget round-robin: at most 3 claims per project per pass', async () => {
    const big = await newProject();
    const small = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    for (let i = 0; i < 20; i++) await enqueue({ projectId: big.id, kind: 'clip' });
    const smallJobs = [];
    for (let i = 0; i < 5; i++) smallJobs.push((await enqueue({ projectId: small.id, kind: 'clip' })).id);
    const out = await runCron({ now: T0, deadline: Date.now() + 30_000 });
    expect(calls.submit).toHaveLength(15);
    expect(smallJobs.every((id) => calls.submit.includes(id))).toBe(true);
    expect(out.submitted).toBe(15);
  });

  it('lists projects with pending work through story_pending_projects', async () => {
    const p = await newProject();
    const userId = randomUUID();
    await enqueue({ projectId: p.id, kind: 'clip' });
    await enqueue({ projectId: p.id, kind: 'clip' });
    await enqueue({ userId, kind: 'voice_clone' });
    await enqueue({ projectId: (await newProject()).id, kind: 'clip', runAfter: at(3600) });
    const rows = await storyDb().rpc('story_pending_projects', { p_now: T0.toISOString(), p_limit: 100 });
    expect(rows.map((r) => r.project_id).sort()).toEqual([p.id, null].sort());
  });

  it('does no work once its deadline has passed', async () => {
    const project = await newProject();
    const { handler, calls } = fakeAsync();
    registerHandler('clip', handler);
    await enqueue({ projectId: project.id, kind: 'clip' });
    await runCron({ now: T0, deadline: Date.now() - 1 });
    expect(calls.submit).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- helpers, registry, schema

describe('helpers', () => {
  it('enqueue takes the owner from the project and validates its input', async () => {
    const project = await newProject();
    const job = await enqueue({ projectId: project.id, kind: 'clip', payload: { a: 1 } });
    expect(job).toMatchObject({ user_id: project.user_id, status: 'queued', attempts: 0, payload: { a: 1 } });
    await expect(enqueue({ kind: 'voice_clone' })).rejects.toThrow(/userId/);
    await expect(enqueue({ projectId: project.id, kind: 'dance' })).rejects.toThrow(/unknown job kind/);
    await expect(enqueue({ projectId: project.id, kind: 'clip', userId: randomUUID() })).rejects.toThrow(/own/);
    await expect(enqueue({ projectId: project.id, kind: 'clip', holdId: randomUUID() })).rejects.toThrow(/together/);
    await expect(enqueue({ projectId: project.id, kind: 'clip', costCredits: 5 })).rejects.toThrow(/together/);
    await expect(enqueue({ projectId: project.id, kind: 'clip', holdId: randomUUID(), costCredits: 0 })).rejects.toThrow(/positive/);
  });

  it('activeJobs returns only the public job columns', async () => {
    const project = await newProject();
    await enqueue({ projectId: project.id, kind: 'clip', payload: { secret: 1 } });
    const [j] = await activeJobs(project.id);
    expect(Object.keys(j).sort()).toEqual(['created_at', 'error', 'id', 'kind', 'project_id', 'shot_id', 'status', 'updated_at']);
  });

  it('registerHandler checks the handler shape against the kind', () => {
    expect(() => registerHandler('clip', { submit: async () => {} })).toThrow(/poll/);
    expect(() => registerHandler('clip', { sync: true, run: async () => {} })).toThrow(/async kind/);
    expect(() => registerHandler('script', { submit: async () => {}, poll: async () => {} })).toThrow(/sync kind/);
    expect(() => registerHandler('nope', { sync: true, run: async () => {} })).toThrow(/unknown/);
  });

  it('every job kind is registered by lib/story/handlers.js or listed as registered by a later task', async () => {
    const { KINDS_REGISTERED_LATER } = await import('../../lib/story/handlers.js');
    _resetHandlers(); // back to what handlers.js registered
    const registered = registeredKinds();
    for (const kind of JOB_KINDS) {
      expect(registered.includes(kind) || KINDS_REGISTERED_LATER.includes(kind), kind).toBe(true);
    }
    for (const kind of KINDS_REGISTERED_LATER) expect(registered, `${kind} is registered now: drop it from the list`).not.toContain(kind);
  });

  it('two jobs cannot share a provider task id', async () => {
    const project = await newProject();
    const a = await enqueue({ projectId: project.id, kind: 'clip' });
    const b = await enqueue({ projectId: project.id, kind: 'clip' });
    await raw.query(`update story_jobs set provider = 'kie', provider_task_id = 'same' where id = $1`, [a.id]);
    await expect(raw.query(`update story_jobs set provider = 'kie', provider_task_id = 'same' where id = $1`, [b.id])).rejects.toThrow(/unique/i);
  });

  it('story_claim_jobs stamps millisecond times when called without p_now, and still takes two arguments', async () => {
    const project = await newProject();
    await enqueue({ projectId: project.id, kind: 'clip' });
    const { rows } = await raw.query(`select * from story_claim_jobs($1, 5)`, [project.id]);
    expect(rows).toHaveLength(1);
    const { rows: us } = await raw.query(`select extract(microseconds from started_at)::bigint % 1000 as sub from story_jobs where id = $1`, [rows[0].id]);
    expect(Number(us[0].sub)).toBe(0);
  });
});

// ---------------------------------------------------------------- routes

describe('routes', () => {
  const resMock = () => {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    return res;
  };

  it('webhook: POST only, 401 on a bad signature, 200 and a nudge otherwise, maxDuration 10', async () => {
    const { default: kie, config } = await import('../../pages/api/webhooks/kie.js');
    expect(config.maxDuration).toBe(10);
    let res = resMock();
    await kie({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(405);

    const project = await newProject();
    const { handler } = fakeAsync();
    registerHandler('clip', handler);
    const job = await enqueue({ projectId: project.id, kind: 'clip' });
    await tick({ projectId: project.id, now: T0 });
    const row = await jobRow(job.id);

    res = resMock();
    await kie({ method: 'POST', query: { job: job.id, sig: 'nope' }, headers: {}, body: kieBody(row.provider_task_id) }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });

    res = resMock();
    await kie({ method: 'POST', query: { job: job.id, sig: sigFor(job.id, row.attempts) }, headers: {}, body: kieBody(row.provider_task_id) }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await jobRow(job.id)).locked_until.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('webhook answers 200 when our own processing fails', async () => {
    const { default: kie } = await import('../../pages/api/webhooks/kie.js');
    setStoryDb({ ...createPgAdapter(raw), select: async () => { throw new Error('db down'); } });
    const res = resMock();
    await kie({ method: 'POST', query: { job: randomUUID(), sig: 'x'.repeat(64) }, headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/db down/);
  });

  it('cron: needs the CRON_SECRET bearer (constant time), then runs', async () => {
    const { default: cron, config } = await import('../../pages/api/cron/story-tick.js');
    expect(config.maxDuration).toBe(60);
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer ', `Bearer ${process.env.CRON_SECRET}x`]) {
      const res = resMock();
      await cron({ method: 'GET', headers: authorization ? { authorization } : {} }, res);
      expect(res.statusCode, String(authorization)).toBe(401);
    }
    const project = await newProject();
    const ran = [];
    registerHandler('script', { sync: true, run: async (job) => { ran.push(job.id); return {}; } });
    const job = await enqueue({ projectId: project.id, kind: 'script' });
    const res = resMock();
    await cron({ method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ran).toEqual([job.id]);
  });
});
