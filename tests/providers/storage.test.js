import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s3 = vi.hoisted(() => ({ sent: [], configs: [], options: [] }));
const blob = vi.hoisted(() => ({ put: [], del: [] }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(config) { s3.configs.push(config); }
    async send(cmd, options) {
      s3.sent.push(cmd);
      s3.options.push(options);
      if (cmd.kind === 'DeleteObjects') {
        return { Deleted: cmd.input.Delete.Objects.map((o) => ({ Key: o.Key })) };
      }
      return {};
    }
  }
  class PutObjectCommand { constructor(input) { this.kind = 'PutObject'; this.input = input; } }
  class DeleteObjectsCommand { constructor(input) { this.kind = 'DeleteObjects'; this.input = input; } }
  return { S3Client, PutObjectCommand, DeleteObjectsCommand };
});

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (pathname, body, opts) => {
    blob.put.push({ pathname, body, opts });
    return { url: `https://store.public.blob.vercel-storage.com/${pathname}`, pathname };
  }),
  del: vi.fn(async (keys) => { blob.del.push(keys); }),
}));

// Guarded downloads use undici's fetch; route it to the stubbed global fetch.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal()),
  fetch: (...args) => globalThis.fetch(...args),
}));

import {
  assertPublicHttpUrl,
  deleteObject,
  deleteObjects,
  localPathFor,
  mirrorUrl,
  mockStoragePath,
  putObject,
  storageBackend,
  toAbsoluteUrl,
} from '../../lib/providers/storage.js';

const FIX = (f) => readFileSync(path.join('tests', 'fixtures', f));
const PNG = FIX('still.png');
const MP4 = FIX('clip.mp4');

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'akid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'story',
  R2_PUBLIC_URL: 'https://media.example.com/',
};

function realMode(extra = {}) {
  vi.stubEnv('STORY_MOCK', '0');
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

function publicDns() {
  return vi.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    process.nextTick(() => (opts?.all ? callback(null, [{ address: '93.184.216.34', family: 4 }]) : callback(null, '93.184.216.34', 4)));
  });
}

beforeEach(() => {
  s3.sent.length = 0;
  s3.configs.length = 0;
  s3.options.length = 0;
  blob.put.length = 0;
  blob.del.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('backend selection', () => {
  it('uses R2 when every R2_* variable is set', async () => {
    realMode(R2_ENV);
    expect(storageBackend()).toBe('r2');
    const out = await putObject({ key: 'projects/p1/still.png', body: PNG, contentType: 'image/png' });
    expect(out).toEqual({ url: 'https://media.example.com/projects/p1/still.png', key: 'projects/p1/still.png' });
    expect(s3.configs[0]).toMatchObject({
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'akid', secretAccessKey: 'secret' },
    });
    expect(s3.sent[0].input).toMatchObject({ Bucket: 'story', Key: 'projects/p1/still.png', ContentType: 'image/png' });
    expect(s3.sent[0].input).not.toHaveProperty('ContentDisposition');
    expect(blob.put).toHaveLength(0);
  });

  it('uses Vercel Blob when any R2_* variable is missing', async () => {
    realMode({ ...R2_ENV, R2_BUCKET: '', BLOB_READ_WRITE_TOKEN: 'blob-token' });
    expect(storageBackend()).toBe('blob');
    const out = await putObject({ key: 'projects/p1/a.mp4', body: MP4, contentType: 'video/mp4' });
    expect(out).toEqual({
      url: 'https://store.public.blob.vercel-storage.com/projects/p1/a.mp4',
      key: 'projects/p1/a.mp4',
    });
    expect(blob.put[0].opts).toMatchObject({ access: 'public', contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true });
    expect(s3.sent).toHaveLength(0);
  });

  it('throws config naming BLOB_READ_WRITE_TOKEN when Blob has no token', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: '' });
    await expect(putObject({ key: 'a.png', body: PNG })).rejects.toMatchObject({
      code: 'config', message: expect.stringContaining('BLOB_READ_WRITE_TOKEN'),
    });
  });

  it('rejects unsafe keys', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    await expect(putObject({ key: '../etc/passwd', body: 'x' })).rejects.toMatchObject({ code: 'failed' });
    await expect(putObject({ key: '/abs.png', body: 'x' })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('putObject abort signal (round 4 N6)', () => {
  it('passes the signal to the R2 upload', async () => {
    realMode(R2_ENV);
    const controller = new AbortController();
    await putObject({ key: 'projects/p1/still.png', body: PNG, signal: controller.signal });
    expect(s3.options[0]).toMatchObject({ abortSignal: controller.signal });
  });

  it('passes the signal to the Blob upload', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 'blob-token' });
    const controller = new AbortController();
    await putObject({ key: 'projects/p1/a.mp4', body: MP4, signal: controller.signal });
    expect(blob.put[0].opts.abortSignal).toBe(controller.signal);
  });

  it('mirrorUrl hands its signal to the upload', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    publicDns();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(MP4, {
      status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) },
    })));
    const controller = new AbortController();
    await mirrorUrl({ srcUrl: 'https://cdn.example.com/x.mp4', key: 'projects/p/sig.mp4', signal: controller.signal });
    expect(blob.put[0].opts.abortSignal).toBe(controller.signal);
  });

  it('an aborted signal stops a mock upload before the key is written', async () => {
    const controller = new AbortController();
    controller.abort(new Error('time is up'));
    const key = `tests/aborted-put-${Date.now()}.png`;
    await expect(putObject({ key, body: PNG, signal: controller.signal })).rejects.toThrow();
    expect(existsSync(mockStoragePath(key))).toBe(false);
  });
});

describe('content-type allowlist (stored XSS guard)', () => {
  it('derives the stored type from the key and ignores the caller type', async () => {
    realMode(R2_ENV);
    await putObject({ key: 'p/still.png', body: PNG, contentType: 'text/html' });
    expect(s3.sent[0].input.ContentType).toBe('image/png');
  });

  it.each(['p/page.html', 'p/icon.svg', 'p/script.js', 'p/noext'])('rejects key %s', async (key) => {
    realMode(R2_ENV);
    await expect(putObject({ key, body: '<script>alert(1)</script>' })).rejects.toMatchObject({ code: 'failed' });
    expect(s3.sent).toHaveLength(0);
  });

  it('rejects bytes that do not match the extension', async () => {
    realMode(R2_ENV);
    await expect(putObject({ key: 'p/fake.png', body: Buffer.from('<html><script>x</script></html>') }))
      .rejects.toMatchObject({ code: 'failed' });
    await expect(putObject({ key: 'p/fake.mp4', body: PNG })).rejects.toMatchObject({ code: 'failed' });
    expect(s3.sent).toHaveLength(0);
  });

  it('stores json/text as attachments', async () => {
    realMode(R2_ENV);
    await putObject({ key: 'p/transcript.json', body: '{"a":1}' });
    expect(s3.sent[0].input).toMatchObject({ ContentType: 'application/json', ContentDisposition: 'attachment' });
  });

  it('mirrorUrl rejects an html page served as .mp4', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    publicDns();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>hi</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })));
    await expect(mirrorUrl({ srcUrl: 'https://cdn.example.com/x.mp4', key: 'p/x.mp4' })).rejects.toMatchObject({ code: 'failed' });
    expect(blob.put).toHaveLength(0);
  });

  it('mirrorUrl only accepts media keys', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    await expect(mirrorUrl({ srcUrl: 'https://cdn.example.com/x.json', key: 'p/x.json' })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('deleteObject(s)', () => {
  it('deletes through R2 in one batch and returns the count', async () => {
    realMode(R2_ENV);
    expect(await deleteObjects({ keys: ['a.png', 'b.mp4'] })).toBe(2);
    expect(s3.sent[0].input).toEqual({
      Bucket: 'story',
      Delete: { Objects: [{ Key: 'a.png' }, { Key: 'b.mp4' }], Quiet: false },
    });
    expect(await deleteObject({ key: 'c.png' })).toBe(1);
  });

  it('deletes through Blob by pathname', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    expect(await deleteObjects({ keys: ['a.png', 'b.png'] })).toBe(2);
    expect(blob.del[0]).toEqual(['a.png', 'b.png']);
  });

  it('returns 0 for an empty list without calling anything', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    expect(await deleteObjects({ keys: [] })).toBe(0);
    expect(blob.del).toHaveLength(0);
  });
});

describe('mirrorUrl SSRF guard', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/a.mp4',
    'http://localhost/a.mp4',
    'http://127.0.0.1/a.mp4',
    'http://10.1.2.3/a.mp4',
    'http://172.20.0.1/a.mp4',
    'http://192.168.1.1/a.mp4',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/a.mp4',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(expect.objectContaining({ code: 'failed' }));
  });

  it('allows a public https url', () => {
    expect(assertPublicHttpUrl('https://cdn.example.com/a.mp4').hostname).toBe('cdn.example.com');
    expect(assertPublicHttpUrl('http://172.32.0.1/a.mp4').hostname).toBe('172.32.0.1');
  });

  it('refuses before fetching', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(mirrorUrl({ srcUrl: 'http://127.0.0.1:3000/x.mp4', key: 'x.mp4' })).rejects.toMatchObject({ code: 'failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address, without fetching', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    vi.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      process.nextTick(() => callback(null, [{ address: '10.0.0.5', family: 4 }]));
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(mirrorUrl({ srcUrl: 'https://internal.example.com/x.mp4', key: 'x.mp4' })).rejects.toMatchObject({ code: 'failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a private address without fetching it', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    publicDns();
    const fetchSpy = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'http://127.0.0.1/x.mp4' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(mirrorUrl({ srcUrl: 'https://cdn.example.com/x.mp4', key: 'x.mp4' })).rejects.toMatchObject({ code: 'failed' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(blob.put).toHaveLength(0);
  });

  it('follows a public redirect, pins the connection and drops auth headers across origins', async () => {
    publicDns();
    const { downloadToFile } = await import('../../lib/providers/http.js');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn2.example.com/y.mp4' } });
      return new Response('ok', { status: 200 });
    }));
    const out = await downloadToFile('https://api.example.com/y', { headers: { Authorization: 'Bearer secret' } });
    expect(readFileSync(out.filePath, 'utf8')).toBe('ok');
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(calls[0].init.dispatcher).toBeTruthy();
    expect(calls[1].url).toBe('https://cdn2.example.com/y.mp4');
    expect(calls[1].init.headers).toBeUndefined();
  });

  it('removes its temp directory when a download fails', async () => {
    publicDns();
    const { downloadToFile } = await import('../../lib/providers/http.js');
    const fsp = (await import('node:fs/promises')).default;
    const made = [];
    const real = fsp.mkdtemp;
    vi.spyOn(fsp, 'mkdtemp').mockImplementation(async (p) => { const d = await real(p); made.push(d); return d; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(50), { status: 200 })));
    await expect(downloadToFile('https://cdn.example.com/big', { maxBytes: 10 })).rejects.toMatchObject({ code: 'failed' });
    expect(made).toHaveLength(1);
    expect(existsSync(made[0])).toBe(false);
  });

  it('streams a public file into storage', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    publicDns();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(MP4, {
      status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(MP4.length) },
    })));
    const out = await mirrorUrl({ srcUrl: 'https://cdn.example.com/x.mp4', key: 'projects/p/x.mp4' });
    expect(out).toEqual({ url: 'https://store.public.blob.vercel-storage.com/projects/p/x.mp4', key: 'projects/p/x.mp4' });
    expect(blob.put[0].opts.contentType).toBe('video/mp4');
  });

  it('rejects files over the cap', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    publicDns();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
      status: 200, headers: { 'content-length': String(500 * 1024 * 1024) },
    })));
    await expect(mirrorUrl({ srcUrl: 'https://cdn.example.com/huge.mp4', key: 'h.mp4' })).rejects.toMatchObject({ code: 'failed' });
    expect(blob.put).toHaveLength(0);
  });
});

describe('mock mode', () => {
  it('writes under a temp directory and returns a mock url without network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const lookupSpy = vi.spyOn(dns, 'lookup');
    const out = await putObject({ key: 'tests/hello.txt', body: 'hi', contentType: 'text/plain' });
    expect(out).toEqual({ url: '/api/mock/storage/tests/hello.txt', key: 'tests/hello.txt' });
    expect(readFileSync(mockStoragePath('tests/hello.txt'), 'utf8')).toBe('hi');

    const m = await mirrorUrl({ srcUrl: '/api/mock/fixtures/clip.mp4', key: 'tests/clip.mp4' });
    expect(m.url).toBe('/api/mock/storage/tests/clip.mp4');
    expect(existsSync(mockStoragePath('tests/clip.mp4'))).toBe(true);

    const legacy = await mirrorUrl({ srcUrl: '/mock/still.png', key: 'tests/legacy.png' });
    expect(readFileSync(mockStoragePath(legacy.key)).equals(PNG)).toBe(true);

    const abs = await mirrorUrl({ srcUrl: 'http://localhost:3000/api/mock/fixtures/still.png', key: 'tests/abs.png' });
    expect(readFileSync(mockStoragePath(abs.key)).equals(PNG)).toBe(true);

    const copy = await mirrorUrl({ srcUrl: m.url, key: 'tests/clip-copy.mp4' });
    expect(readFileSync(mockStoragePath(copy.key)).equals(MP4)).toBe(true);

    const remote = await mirrorUrl({ srcUrl: 'https://cdn.example.com/out.png', key: 'tests/out.png' });
    expect(remote.key).toBe('tests/out.png');

    expect(await deleteObjects({ keys: ['tests/hello.txt', 'tests/clip.mp4', 'tests/missing.bin'] })).toBe(2);
    expect(existsSync(mockStoragePath('tests/hello.txt'))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(s3.sent).toHaveLength(0);
    expect(blob.put).toHaveLength(0);
  });

  it('runs the same URL and key validation as real mode', async () => {
    await expect(mirrorUrl({ srcUrl: 'http://127.0.0.1/x.mp4', key: 'tests/x.mp4' })).rejects.toMatchObject({ code: 'failed' });
    await expect(mirrorUrl({ srcUrl: 'file:///etc/passwd', key: 'tests/x.mp4' })).rejects.toMatchObject({ code: 'failed' });
    await expect(putObject({ key: 'tests/x.html', body: '<b>' })).rejects.toMatchObject({ code: 'failed' });
    await expect(putObject({ key: 'tests/x.png', body: 'not a png' })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('localPathFor / toAbsoluteUrl', () => {
  it('maps mock urls to local files and real urls to null', async () => {
    expect(localPathFor('/api/mock/fixtures/clip.mp4')).toBe(path.join(process.cwd(), 'tests', 'fixtures', 'clip.mp4'));
    expect(localPathFor('/mock/voice.mp3')).toBe(path.join(process.cwd(), 'tests', 'fixtures', 'voice.mp3'));
    expect(localPathFor('/api/mock/storage/tests/a%20b.png')).toBe(mockStoragePath('tests/a b.png'));
    expect(localPathFor('http://localhost:3000/api/mock/fixtures/still.png')).toBe(path.join(process.cwd(), 'tests', 'fixtures', 'still.png'));
    expect(localPathFor('https://store.public.blob.vercel-storage.com/a.mp4')).toBeNull();
    expect(localPathFor('/api/mock/storage/../../etc/passwd')).toBeNull();
    expect(localPathFor('/mock/../../.env.local')).toBeNull();
  });

  it('resolves relative urls against an origin and leaves absolute urls alone', () => {
    expect(toAbsoluteUrl('/api/mock/fixtures/clip.mp4', 'http://localhost:3000')).toBe('http://localhost:3000/api/mock/fixtures/clip.mp4');
    expect(toAbsoluteUrl('https://cdn.example.com/a.mp4', 'http://localhost:3000')).toBe('https://cdn.example.com/a.mp4');
  });
});
