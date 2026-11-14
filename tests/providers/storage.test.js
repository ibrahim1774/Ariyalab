import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s3 = vi.hoisted(() => ({ sent: [], configs: [] }));
const blob = vi.hoisted(() => ({ put: [], del: [] }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(config) { s3.configs.push(config); }
    async send(cmd) {
      s3.sent.push(cmd);
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

import {
  assertPublicHttpUrl,
  deleteObject,
  deleteObjects,
  mirrorUrl,
  mockStoragePath,
  putObject,
  storageBackend,
} from '../../lib/providers/storage.js';

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

beforeEach(() => {
  s3.sent.length = 0;
  s3.configs.length = 0;
  blob.put.length = 0;
  blob.del.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('backend selection', () => {
  it('uses R2 when every R2_* variable is set', async () => {
    realMode(R2_ENV);
    expect(storageBackend()).toBe('r2');
    const out = await putObject({ key: 'projects/p1/still.png', body: Buffer.from('x'), contentType: 'image/png' });
    expect(out).toEqual({ url: 'https://media.example.com/projects/p1/still.png', key: 'projects/p1/still.png' });
    expect(s3.configs[0]).toMatchObject({
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'akid', secretAccessKey: 'secret' },
    });
    expect(s3.sent[0].input).toMatchObject({ Bucket: 'story', Key: 'projects/p1/still.png', ContentType: 'image/png' });
    expect(blob.put).toHaveLength(0);
  });

  it('uses Vercel Blob when any R2_* variable is missing', async () => {
    realMode({ ...R2_ENV, R2_BUCKET: '', BLOB_READ_WRITE_TOKEN: 'blob-token' });
    expect(storageBackend()).toBe('blob');
    const out = await putObject({ key: 'projects/p1/a.mp4', body: Buffer.from('x'), contentType: 'video/mp4' });
    expect(out).toEqual({
      url: 'https://store.public.blob.vercel-storage.com/projects/p1/a.mp4',
      key: 'projects/p1/a.mp4',
    });
    expect(blob.put[0].opts).toMatchObject({ access: 'public', contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true });
    expect(s3.sent).toHaveLength(0);
  });

  it('throws config naming BLOB_READ_WRITE_TOKEN when Blob has no token', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: '' });
    await expect(putObject({ key: 'a.png', body: Buffer.from('x') })).rejects.toMatchObject({
      code: 'config', message: expect.stringContaining('BLOB_READ_WRITE_TOKEN'),
    });
  });

  it('rejects unsafe keys', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    await expect(putObject({ key: '../etc/passwd', body: 'x' })).rejects.toMatchObject({ code: 'failed' });
    await expect(putObject({ key: '/abs.png', body: 'x' })).rejects.toMatchObject({ code: 'failed' });
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

  it('streams a public file into storage', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('video-bytes'), {
      status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '11' },
    })));
    const out = await mirrorUrl({ srcUrl: 'https://cdn.example.com/x.mp4', key: 'projects/p/x.mp4' });
    expect(out).toEqual({ url: 'https://store.public.blob.vercel-storage.com/projects/p/x.mp4', key: 'projects/p/x.mp4' });
    expect(blob.put[0].opts.contentType).toBe('video/mp4');
  });

  it('rejects files over the cap', async () => {
    realMode({ BLOB_READ_WRITE_TOKEN: 't' });
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
    const out = await putObject({ key: 'tests/hello.txt', body: 'hi', contentType: 'text/plain' });
    expect(out).toEqual({ url: '/api/mock/storage/tests/hello.txt', key: 'tests/hello.txt' });
    expect(readFileSync(mockStoragePath('tests/hello.txt'), 'utf8')).toBe('hi');

    const m = await mirrorUrl({ srcUrl: '/mock/clip.mp4', key: 'tests/clip.mp4' });
    expect(m.url).toBe('/api/mock/storage/tests/clip.mp4');
    expect(existsSync(mockStoragePath('tests/clip.mp4'))).toBe(true);

    const remote = await mirrorUrl({ srcUrl: 'https://cdn.example.com/out.png', key: 'tests/out.png' });
    expect(remote.key).toBe('tests/out.png');

    expect(await deleteObjects({ keys: ['tests/hello.txt', 'tests/clip.mp4', 'tests/missing.bin'] })).toBe(2);
    expect(existsSync(mockStoragePath('tests/hello.txt'))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s3.sent).toHaveLength(0);
    expect(blob.put).toHaveLength(0);
  });
});
