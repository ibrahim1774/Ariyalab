import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixturesRoute from '../../pages/api/mock/fixtures/[file].js';
import storageRoute from '../../pages/api/mock/storage/[...key].js';
import { putObject } from '../../lib/providers/storage.js';

function makeRes() {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  const res = Object.assign(sink, {
    statusCode: 200,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    body: () => Buffer.concat(chunks),
  });
  const done = new Promise((resolve) => sink.on('finish', resolve));
  return { res, done };
}

afterEach(() => vi.unstubAllEnvs());

describe('dev-only mock fixture route', () => {
  it('serves a fixture in mock mode', async () => {
    const { res, done } = makeRes();
    await fixturesRoute({ query: { file: 'clip.mp4' } }, res);
    await done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body().equals(readFileSync('tests/fixtures/clip.mp4'))).toBe(true);
  });

  it('404s outside mock mode, in production, and for unknown names', async () => {
    for (const [env, file] of [[{ STORY_MOCK: '0' }, 'clip.mp4'], [{ NODE_ENV: 'production' }, 'clip.mp4'], [{}, '..%2F.env.local'], [{}, 'nope.mp4']]) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const { res, done } = makeRes();
      await fixturesRoute({ query: { file } }, res);
      await done;
      expect(res.statusCode).toBe(404);
      vi.unstubAllEnvs();
    }
  });

  it('public/mock no longer ships fixtures as static files', () => {
    expect(existsSync('public/mock/clip.mp4')).toBe(false);
  });
});

describe('dev-only mock storage route', () => {
  it('serves a stored file with nosniff and attachment for non-media', async () => {
    await putObject({ key: 'routes/t.json', body: '{"ok":true}' });
    const { res, done } = makeRes();
    await storageRoute({ query: { key: ['routes', 't.json'] } }, res);
    await done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.body().toString()).toBe('{"ok":true}');
  });

  it('ends with 500 instead of hanging when the read stream errors', async () => {
    const fs = await import('node:fs');
    await putObject({ key: 'routes/err.json', body: '{}' });
    const real = fs.default.createReadStream;
    vi.spyOn(fs.default, 'createReadStream').mockImplementation((...args) => {
      const s = real(...args);
      process.nextTick(() => s.destroy(new Error('disk gone')));
      return s;
    });
    const { res, done } = makeRes();
    await storageRoute({ query: { key: ['routes', 'err.json'] } }, res);
    await done;
    expect(res.statusCode).toBe(500);
    vi.restoreAllMocks();
  });
});
