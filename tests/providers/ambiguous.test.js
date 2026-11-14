import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError, toProviderError } from '../../lib/providers/errors.js';
import { getClip, submitClip } from '../../lib/providers/video.js';

// Task 12 round 2 (N4): the job runner must know when a submit may already
// have reached the provider, so it never submits a paid task twice.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const nested = (code) => new TypeError('fetch failed', { cause: Object.assign(new Error(`read ${code}`), { code }) });

describe('ProviderError.ambiguous', () => {
  it('keeps the nested cause code of a fetch failure', () => {
    const err = toProviderError(nested('ECONNRESET'), 'kie');
    expect(err.cause).toMatchObject({ name: 'TypeError', causeCode: 'ECONNRESET' });
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'UND_ERR_CLOSED'])('is true for a socket failure after sending (%s)', (code) => {
    expect(toProviderError(nested(code), 'kie').ambiguous).toBe(true);
  });

  it('is true for a timeout or an abort', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(toProviderError(timeout, 'kie').ambiguous).toBe(true);
    expect(toProviderError(abort, 'kie').ambiguous).toBe(true);
  });

  it.each([502, 503, 504])('is true for an HTTP %i answer', (status) => {
    expect(new ProviderError('failed', undefined, { cause: { status, message: 'gateway' } }).ambiguous).toBe(true);
  });

  it('is false when the request never left or the provider answered clearly', () => {
    expect(toProviderError(nested('ECONNREFUSED'), 'kie').ambiguous).toBe(false);
    expect(toProviderError(nested('ENOTFOUND'), 'kie').ambiguous).toBe(false);
    expect(new ProviderError('failed', undefined, { cause: { status: 500, message: 'x' } }).ambiguous).toBe(false);
    expect(new ProviderError('failed', undefined, { cause: { status: 400, message: 'x' } }).ambiguous).toBe(false);
    expect(new ProviderError('rate_limited').ambiguous).toBe(false);
  });
});

describe('kie calls', () => {
  const useRealMode = () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('KIE_API_KEY', 'test-kie-key');
  };
  const args = { quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 };

  it('a body that fails to read is a ProviderError, ambiguous when the socket closed', async () => {
    useRealMode();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw nested('UND_ERR_SOCKET'); },
    })));
    const err = await submitClip(args).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('failed');
    expect(err.ambiguous).toBe(true);
  });

  it('a 504 from createTask is ambiguous', async () => {
    useRealMode();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway timeout</html>', { status: 504 })));
    const err = await submitClip(args).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed', ambiguous: true });
  });

  it('a socket reset while sending createTask is ambiguous', async () => {
    useRealMode();
    vi.stubGlobal('fetch', vi.fn(async () => { throw nested('ECONNRESET'); }));
    const err = await submitClip(args).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed', ambiguous: true });
  });
});

describe('kie createTask answers that do not prove no task was made (R4)', () => {
  const useRealMode = () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('KIE_API_KEY', 'test-kie-key');
  };
  const args = { quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 };
  const answer = (body, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

  it.each([
    ['a body code 500 inside HTTP 200', JSON.stringify({ code: 500, msg: 'server error' }), 200],
    ['an HTTP 500', JSON.stringify({ code: 500, msg: 'server error' }), 500],
    ['an HTTP 200 / code 200 without a taskId', JSON.stringify({ code: 200, msg: 'success', data: {} }), 200],
    ['an unparsable HTTP 200 body', '<html>ok?</html>', 200],
  ])('%s is ambiguous', async (_name, body, status) => {
    useRealMode();
    answer(body, status);
    const err = await submitClip(args).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed', ambiguous: true });
  });

  it('a 4xx answer is definite', async () => {
    useRealMode();
    answer(JSON.stringify({ code: 400, msg: 'bad duration' }), 200);
    expect(await submitClip(args).catch((e) => e)).toMatchObject({ code: 'failed', ambiguous: false });
    answer(JSON.stringify({ code: 401, msg: 'unauthorized' }), 401);
    expect(await submitClip(args).catch((e) => e)).toMatchObject({ code: 'failed', ambiguous: false });
  });

  it('a status call (getClip) with code 500 is not marked: only submits are', async () => {
    useRealMode();
    answer(JSON.stringify({ code: 500, msg: 'server error' }), 200);
    const err = await getClip({ provider: 'kie', taskId: 't1' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed', ambiguous: false });
  });
});

describe('mirrorUrl signal (R5)', () => {
  it('an aborted signal stops the copy before anything is stored', async () => {
    const { mirrorUrl, mockStoragePath } = await import('../../lib/providers/storage.js');
    const { existsSync } = await import('node:fs');
    const controller = new AbortController();
    controller.abort(new Error('time is up'));
    const key = `test/abort-${Date.now()}.png`;
    await expect(mirrorUrl({ srcUrl: '/api/mock/fixtures/still.png', key, signal: controller.signal })).rejects.toThrow();
    expect(existsSync(mockStoragePath(key))).toBe(false);
  });

  it('downloadToFile passes the signal to the fetch', async () => {
    const http = await import('../../lib/providers/http.js');
    const controller = new AbortController();
    controller.abort(new Error('time is up'));
    await expect(http.downloadToFile('https://example.com/a.mp4', { signal: controller.signal, maxBytes: 10 })).rejects.toThrow();
  });
});
