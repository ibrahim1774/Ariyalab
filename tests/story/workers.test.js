import { afterEach, describe, expect, it, vi } from 'vitest';
import { kickWorker, RENDER_WORKER_PATH } from '../../lib/story/workers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function realMode() {
  vi.stubEnv('STORY_MOCK', '');
  vi.stubEnv('APP_URL', 'https://app.example.test');
  vi.stubEnv('CRON_SECRET', 's3');
}

describe('kickWorker', () => {
  it('logs a non-2xx answer from the worker route (a 401 would otherwise go unseen)', async () => {
    realMode();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await kickWorker(RENDER_WORKER_PATH)).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0].join(' '))).toMatch(/render-worker.*401/);
  });

  it('stays quiet on a 2xx answer and on the expected abort', async () => {
    realMode();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    await kickWorker(RENDER_WORKER_PATH);
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }));
    await kickWorker(RENDER_WORKER_PATH);
    expect(err).not.toHaveBeenCalled();
  });
});
