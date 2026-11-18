import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setPricingDb } from '../../lib/pricing.js';
import { MOCK_URLS } from '../../lib/providers/mock.js';

// A finished kie.ai picture waits to be copied into storage. The copy takes about 8 s (measured live, 2026-11-17).
const mirror = vi.hoisted(() => ({ calls: [], delayMs: 0, fail: false }));
vi.mock('../../lib/providers/storage.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    mirrorUrl: async (args) => {
      mirror.calls.push(args);
      if (mirror.delayMs) await new Promise((r) => setTimeout(r, mirror.delayMs));
      if (mirror.fail) throw new Error('upload refused');
      return { url: `https://store.test/${args.key}`, key: args.key };
    },
  };
});

const { setCreditsDb } = await import('../../lib/credits.js');
const runner = await import('../../lib/story/runner.js');
const { getProjectStatus, STATUS_TICK_MS, STATUS_COPY_MS, backgroundCopy } = await import('../../lib/story/status.js');

let raw;
beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  await runner.sweep({ deadline: Date.now() - 1 });
}, 60_000);
afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  await raw?.close();
});

beforeEach(async () => {
  mirror.calls = [];
  mirror.delayMs = 0;
  mirror.fail = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STORY_MOCK', ''); // real mode: no cron-less shortcut, the status tick has its short real budget
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where status in ('queued', 'running') or applied_at is null`);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  runner._resetHandlers();
});

async function keptJob(kind = 'still') {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', { user_id: userId });
  runner.registerHandler(kind, {
    submit: async () => ({ provider: 'mock', taskId: 'task-1' }),
    poll: async () => ({ status: 'pending', url: null, error: null }),
    onDone: async () => {},
    onFail: async () => {},
  });
  const job = await runner.enqueue({ projectId: project.id, kind });
  const past = new Date(Date.now() - 60_000).toISOString();
  await raw.query(
    `update story_jobs set status = 'running', provider = 'mock', provider_task_id = 'task-1', submitted_at = $2, started_at = $2,
       provider_result = $3::jsonb, kept_at = $2, locked_until = $2, mirror_tries = 0 where id = $1`,
    [job.id, past, JSON.stringify({ url: kind === 'clip' ? MOCK_URLS.clip : MOCK_URLS.still })],
  );
  return { userId, project, job };
}
const row = async (id) => (await raw.query('select * from story_jobs where id = $1', [id])).rows[0];

const flush = async (projectId) => { await vi.advanceTimersByTimeAsync(0); await backgroundCopy(projectId); };

describe('a page that is open copies finished pictures and clips, after the answer is sent', () => {
  it('the status request keeps its short budget (5 s, paid submits included); copies get 40 s in the background; the route allows 60 s', () => {
    expect(STATUS_TICK_MS.real).toBe(5_000);
    // mirrorBudget: remaining time less the 2 s margin must reach the media class minimum (image 8 s, video 25 s).
    expect(STATUS_COPY_MS - runner.RUNNER_CONFIG.mirrorDeadlineMarginMs).toBeGreaterThanOrEqual(runner.RUNNER_CONFIG.mirrorMinMs.video);
    expect(STATUS_COPY_MS).toBe(40_000);
  });

  it('GET status answers at once while an 8 s copy completes afterwards; the next poll sees the picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.delayMs = 8_000;
    const { userId, project, job } = await keptJob('still');
    const status = getProjectStatus({ userId, projectId: project.id });
    await vi.advanceTimersByTimeAsync(1_000); // the answer needs no copy time
    const answer = await status;
    expect(mirror.calls).toHaveLength(1); // the copy has started...
    expect(await row(job.id)).toMatchObject({ status: 'running', mirror_tries: 1 }); // ...and is not finished: the answer did not wait for it
    expect(answer.jobs.find((j) => j.id === job.id).status).toBe('running');
    await vi.advanceTimersByTimeAsync(9_000);
    await backgroundCopy(project.id);
    expect(await row(job.id)).toMatchObject({ status: 'done', mirror_tries: 1 });
    vi.advanceTimersByTime(4_000); // past the 3 s turn gap
    const next = await getProjectStatus({ userId, projectId: project.id });
    expect(next.jobs.find((j) => j.id === job.id).status).toBe('done');
  });

  it('a finished clip (20 s copy) is copied in the background too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.delayMs = 20_000;
    const { userId, project, job } = await keptJob('clip');
    await getProjectStatus({ userId, projectId: project.id });
    await vi.advanceTimersByTimeAsync(21_000);
    await backgroundCopy(project.id);
    expect(await row(job.id)).toMatchObject({ status: 'done', mirror_tries: 1 });
  });

  it('two overlapping polls start one copy (single flight), and so does the cron', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.delayMs = 8_000;
    const { userId, project, job } = await keptJob('still');
    const a = getProjectStatus({ userId, projectId: project.id });
    const b = getProjectStatus({ userId, projectId: project.id });
    const cron = runner.runCron({ deadline: Date.now() + 45_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([a, b]);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([cron, backgroundCopy(project.id)]);
    expect(mirror.calls).toHaveLength(1);
    expect(await row(job.id)).toMatchObject({ status: 'done', mirror_tries: 1 });
  });

  it('a copy that throws does not crash the answer, leaves no lease and may be tried again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.fail = true;
    const { userId, project, job } = await keptJob('still');
    await expect(getProjectStatus({ userId, projectId: project.id })).resolves.toMatchObject({ project: { id: project.id } });
    await flush(project.id);
    const failed = await row(job.id);
    expect(failed).toMatchObject({ status: 'running', mirror_tries: 1, lease_until: null });
    expect(await backgroundCopy(project.id)).toBeNull(); // nothing is left running: the next poll may start a new one
    mirror.fail = false;
    await raw.query('update story_jobs set locked_until = now() - interval \'1 second\' where id = $1', [job.id]);
    vi.advanceTimersByTime(4_000);
    await getProjectStatus({ userId, projectId: project.id });
    await flush(project.id);
    expect(await row(job.id)).toMatchObject({ status: 'done' });
  });

  it('with nothing to copy the status answer does not wait and starts no copy', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', { user_id: userId });
    const started = Date.now();
    await getProjectStatus({ userId, projectId: project.id });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await backgroundCopy(project.id)).toBeNull();
  });
});
