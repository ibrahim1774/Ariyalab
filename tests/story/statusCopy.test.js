import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setPricingDb } from '../../lib/pricing.js';
import { MOCK_URLS } from '../../lib/providers/mock.js';

// A finished kie.ai picture waits to be copied into storage. The copy takes about 8 s (measured live, 2026-11-17).
const mirror = vi.hoisted(() => ({ calls: [], delayMs: 0 }));
vi.mock('../../lib/providers/storage.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    mirrorUrl: async (args) => {
      mirror.calls.push(args);
      if (mirror.delayMs) await new Promise((r) => setTimeout(r, mirror.delayMs));
      return { url: `https://store.test/${args.key}`, key: args.key };
    },
  };
});

const { setCreditsDb } = await import('../../lib/credits.js');
const runner = await import('../../lib/story/runner.js');
const { getProjectStatus, STATUS_TICK_MS } = await import('../../lib/story/status.js');

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
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STORY_MOCK', ''); // real mode: no cron-less shortcut, the status tick has its short real budget
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where status in ('queued', 'running') or applied_at is null`);
});
afterEach(() => {
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

describe('a page that is open copies finished pictures and clips', () => {
  it('the real status tick has time to copy a picture (8 s) and a clip (25 s) and stays inside the route\'s 60 s', () => {
    // mirrorBudget: remaining time less the 2 s margin must reach the media class minimum (image 8 s, video 25 s).
    expect(STATUS_TICK_MS.real - runner.RUNNER_CONFIG.mirrorDeadlineMarginMs).toBeGreaterThanOrEqual(runner.RUNNER_CONFIG.mirrorMinMs.video);
    // pages/api/story/projects/[id]/status.js has maxDuration 60: leave room for the answer's own queries.
    expect(STATUS_TICK_MS.real).toBeLessThanOrEqual(45_000);
  });

  it('GET status copies a finished picture whose copy takes 8 s (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.delayMs = 8_000;
    const { userId, project, job } = await keptJob('still');
    const status = getProjectStatus({ userId, projectId: project.id });
    await vi.advanceTimersByTimeAsync(9_000);
    await status;
    expect(mirror.calls).toHaveLength(1);
    expect(await row(job.id)).toMatchObject({ status: 'done', mirror_tries: 1 });
  });

  it('GET status copies a finished clip whose copy takes 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.delayMs = 20_000;
    const { userId, project, job } = await keptJob('clip');
    const status = getProjectStatus({ userId, projectId: project.id });
    await vi.advanceTimersByTimeAsync(21_000);
    await status;
    expect(await row(job.id)).toMatchObject({ status: 'done', mirror_tries: 1 });
  });

  it('the page and the cron overlapping copy the picture once (lease)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mirror.delayMs = 8_000;
    const { userId, project, job } = await keptJob('still');
    const status = getProjectStatus({ userId, projectId: project.id });
    const cron = runner.runCron({ deadline: Date.now() + 45_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    await Promise.all([status, cron]);
    expect(mirror.calls).toHaveLength(1);
    expect(await row(job.id)).toMatchObject({ status: 'done', mirror_tries: 1 });
  });

  it('with nothing to copy the status answer does not wait', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', { user_id: userId });
    const started = Date.now();
    await getProjectStatus({ userId, projectId: project.id });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
