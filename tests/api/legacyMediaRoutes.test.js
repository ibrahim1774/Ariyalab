// Final review I4: the legacy frame and concat routes fetch customer URLs through the guarded downloader with a byte
// cap, refuse anything that is not an mp4/mov, and open it with the file protocol only and the mov demuxer forced.
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq, makeRes, signIn, signOut, USER_A } from '../helpers/apiMock';

vi.mock('../../lib/supabaseServer', async () => (await import('../helpers/apiMock')).supabaseServerModule);
vi.mock('@vercel/blob', () => ({ put: vi.fn(async (name) => ({ url: `https://blob.example.test/${name}` })) }));
// Every ffmpeg the routes spawn is recorded (and still run).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal();
  const spawn = vi.fn((bin, args, opts) => { globalThis.__legacySpawned.push(args); return real.spawn(bin, args, opts); });
  return { ...real, spawn, default: { ...real, spawn } };
});
// The download: the real guarded one unless a test serves the bytes itself (there is no public host in a test).
vi.mock('../../lib/providers/http.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    downloadToFile: vi.fn(async (url, opts) => {
      if (globalThis.__legacyServe) {
        real.assertPublicHttpUrl(url);
        return globalThis.__legacyServe(url, opts);
      }
      return real.downloadToFile(url, opts);
    }),
  };
});

const { downloadToFile } = await import('../../lib/providers/http.js');
const { LEGACY_VIDEO_MAX_BYTES } = await import('../../lib/legacyMedia.js');
const routes = {
  'extract-frame': (await import('../../pages/api/extract-frame')).default,
  'extract-last-frame': (await import('../../pages/api/extract-last-frame')).default,
  'concat-videos': (await import('../../pages/api/concat-videos')).default,
};
const CLIP = path.join(process.cwd(), 'tests', 'fixtures', 'clip.mp4');

const bodyFor = (name, url) => (name === 'concat-videos' ? { videoUrls: [url, url] } : { videoUrl: url });
async function call(name, url) {
  const res = makeRes();
  await routes[name](makeReq({ body: bodyFor(name, url) }), res);
  return res;
}

beforeEach(() => {
  signIn(USER_A);
  globalThis.__legacySpawned = [];
  globalThis.__legacyServe = null;
  downloadToFile.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  signOut();
  vi.restoreAllMocks();
});

describe.each(Object.keys(routes))('/api/%s (final review I4)', (name) => {
  it('refuses private, loopback and metadata addresses before any download or ffmpeg', async () => {
    for (const url of ['http://127.0.0.1/a.mp4', 'http://169.254.169.254/latest/meta-data', 'http://localhost:3000/x.mp4', 'http://[::1]/x.mp4', 'http://10.0.0.5/v.mp4']) {
      const res = await call(name, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.body.error, url).toMatch(/private address/);
    }
    expect(globalThis.__legacySpawned).toEqual([]);
  });

  it('downloads with a byte cap and refuses a file over it', async () => {
    globalThis.__legacyServe = async (url, opts) => {
      expect(opts.maxBytes).toBe(LEGACY_VIDEO_MAX_BYTES);
      const { ProviderError } = await import('../../lib/providers/errors.js');
      throw new ProviderError('failed', 'That file is larger than 200 MB.');
    };
    const res = await call(name, 'https://videos.example.com/huge.mp4');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/larger than 200 MB/);
    expect(downloadToFile).toHaveBeenCalled();
    expect(globalThis.__legacySpawned).toEqual([]);
  });

  it('refuses a file that is not an mp4/mov (a playlist) without running ffmpeg', async () => {
    globalThis.__legacyServe = async (url, { dest }) => {
      await writeFile(dest, '#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/latest/meta-data\n');
      return { filePath: dest, bytes: 60, contentType: 'video/mp4' };
    };
    const res = await call(name, 'https://videos.example.com/list.mp4');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/MP4 or MOV/);
    expect(globalThis.__legacySpawned).toEqual([]);
  });

  it('works on a real mp4, and every ffmpeg input is opened with the file protocol only and a forced demuxer', async () => {
    globalThis.__legacyServe = async (url, { dest }) => {
      await copyFile(CLIP, dest);
      return { filePath: dest, bytes: 1, contentType: 'video/mp4' };
    };
    const res = await call(name, 'https://videos.example.com/clip.mp4');
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(globalThis.__legacySpawned.length).toBeGreaterThan(0);
    for (const args of globalThis.__legacySpawned) {
      args.forEach((a, i) => {
        if (a !== '-i') return;
        const before = args.slice(0, i);
        const wl = before.lastIndexOf('-protocol_whitelist');
        expect(wl, args.join(' ')).toBeGreaterThanOrEqual(0);
        expect(before[wl + 1]).toBe('file');
        const f = before.lastIndexOf('-f');
        expect(f, args.join(' ')).toBeGreaterThan(wl);
        expect(['mov', 'concat']).toContain(before[f + 1]);
      });
    }
  });
});
