import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError, toProviderError } from '../../lib/providers/errors.js';
import { submitClip } from '../../lib/providers/video.js';

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
