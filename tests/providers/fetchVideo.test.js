import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal()),
  fetch: (...args) => globalThis.fetch(...args),
}));

import { detectPlatform, fetchReference } from '../../lib/providers/fetchVideo.js';

beforeEach(() => {
  // Every name resolves to a public address; no real DNS in tests.
  vi.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    process.nextTick(() => (opts?.all ? callback(null, [{ address: '93.184.216.34', family: 4 }]) : callback(null, '93.184.216.34', 4)));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('detectPlatform', () => {
  it.each([
    ['https://www.instagram.com/reel/abc123/', 'instagram'],
    ['https://instagram.com/p/abc/', 'instagram'],
    ['https://m.tiktok.com/@a/video/1', 'tiktok'],
    ['https://www.tiktok.com/@a/video/1', 'tiktok'],
    ['https://www.facebook.com/reel/123', 'facebook'],
    ['https://m.facebook.com/watch/?v=1', 'facebook'],
    ['https://fb.watch/abcd/', 'facebook'],
    ['https://vm.tiktok.com/ZMabc123/', 'tiktok'],
    ['https://vt.tiktok.com/ZSabc123/', 'tiktok'],
  ])('%s -> %s', (url, platform) => {
    expect(detectPlatform(url)).toBe(platform);
  });

  it.each([
    'https://www.youtube.com/watch?v=1',
    'https://evil-instagram.com/reel/1',
    'https://instagram.com.evil.io/reel/1',
    'https://cdn.example.com/video.mp4',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s with "Upload the file instead"', (url) => {
    expect(() => detectPlatform(url)).toThrow(expect.objectContaining({
      code: 'failed', message: expect.stringContaining('Upload the file instead'),
    }));
  });
});

describe('fetchReference (mock mode)', () => {
  it('copies the reference fixture without network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await fetchReference('https://www.tiktok.com/@a/video/1');
    expect(out.platform).toBe('tiktok');
    expect(existsSync(out.filePath)).toBe(true);
    expect(readFileSync(out.filePath).length).toBe(readFileSync('tests/fixtures/reference.mp4').length);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.audioPath).toBeUndefined();
    await out.cleanup();
    expect(existsSync(path.dirname(out.filePath))).toBe(false);
  });

  it('returns a separate audio track for [[mock:silent-reel]]', async () => {
    const out = await fetchReference('https://www.instagram.com/reel/abc/?x=[[mock:silent-reel]]');
    expect(out.platform).toBe('instagram');
    expect(readFileSync(out.filePath).equals(readFileSync('tests/fixtures/reference-silent.mp4'))).toBe(true);
    expect(readFileSync(out.audioPath).equals(readFileSync('tests/fixtures/voice.mp3'))).toBe(true);
    await out.cleanup();
    expect(existsSync(out.audioPath)).toBe(false);
  });

  it('still rejects unsupported hosts in mock mode', async () => {
    await expect(fetchReference('https://vimeo.com/1')).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('fetchReference (real mode)', () => {
  function media(body, type) {
    return new Response(Buffer.from(body), { status: 200, headers: { 'content-type': type } });
  }

  it('uses Apify for Instagram and returns the separate audio track', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('APIFY_TOKEN', 'apify-token');
    vi.stubEnv('SCRAPECREATORS_API_KEY', 'sc-key');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://api.apify.com/v2/acts/')) {
        return new Response(JSON.stringify([{ videoUrl: 'https://scontent.cdninstagram.com/v.mp4', audioUrl: 'https://scontent.cdninstagram.com/a.mp4' }]));
      }
      if (String(url).endsWith('/v.mp4')) return media('VIDEO', 'video/mp4');
      return media('AUDIO', 'audio/mp4');
    }));
    const out = await fetchReference('https://www.instagram.com/reel/abc/');
    expect(out.platform).toBe('instagram');
    expect(readFileSync(out.filePath, 'utf8')).toBe('VIDEO');
    expect(readFileSync(out.audioPath, 'utf8')).toBe('AUDIO');
    expect(typeof out.cleanup).toBe('function');
    await out.cleanup();
    expect(existsSync(out.filePath)).toBe(false);
    expect(calls[0].url).toMatch(/^https:\/\/api\.apify\.com\/v2\/acts\/apify~instagram-scraper\/run-sync-get-dataset-items/);
    expect(calls[0].init.headers.Authorization).toBe('Bearer apify-token');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      directUrls: ['https://www.instagram.com/reel/abc/'], resultsType: 'posts',
    });
  });

  it('resolves a vm.tiktok.com share link to the canonical URL before scraping', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('APIFY_TOKEN', 'apify-token');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://vm.tiktok.com/')) {
        return new Response(null, { status: 301, headers: { location: 'https://www.tiktok.com/@baker/video/7300000000000000000?_r=1' } });
      }
      if (String(url).startsWith('https://api.apify.com/v2/acts/')) {
        return new Response(JSON.stringify([{ videoMeta: { downloadAddr: 'https://api.apify.com/v2/key-value-stores/s/records/v.mp4' } }]));
      }
      return media('TT', 'video/mp4');
    }));
    const out = await fetchReference('https://vm.tiktok.com/ZMabc123/');
    expect(out.platform).toBe('tiktok');
    const apify = calls.find((c) => c.url.startsWith('https://api.apify.com/v2/acts/'));
    expect(apify.url).toContain('clockworks~tiktok-scraper');
    expect(JSON.parse(apify.init.body).postURLs).toEqual(['https://www.tiktok.com/@baker/video/7300000000000000000?_r=1']);
    const download = calls.at(-1);
    expect(download.init.headers).toEqual({ Authorization: 'Bearer apify-token' });
    await out.cleanup();
  });

  it('rejects a share link that redirects off the allowlist', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('APIFY_TOKEN', 'apify-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } })));
    const err = await fetchReference('https://vt.tiktok.com/ZSabc/').catch((e) => e);
    expect(err.code).toBe('failed');
    expect(err.message).toMatch(/Upload the file instead/);
  });

  it('uses ScrapeCreators only when APIFY_TOKEN is not set', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('APIFY_TOKEN', '');
    vi.stubEnv('SCRAPECREATORS_API_KEY', 'sc-key');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://api.scrapecreators.com/')) {
        return new Response(JSON.stringify({ video: { hd_url: 'https://video.fbcdn.net/hd.mp4' } }));
      }
      return media('FBVIDEO', 'video/mp4');
    }));
    const out = await fetchReference('https://www.facebook.com/reel/123');
    expect(out).toMatchObject({ platform: 'facebook' });
    expect(out.audioPath).toBeUndefined();
    expect(readFileSync(out.filePath, 'utf8')).toBe('FBVIDEO');
    expect(calls[0].url).toBe('https://api.scrapecreators.com/v1/facebook/post?url=' + encodeURIComponent('https://www.facebook.com/reel/123'));
    expect(calls[0].init.headers['x-api-key']).toBe('sc-key');
  });

  it('throws config naming APIFY_TOKEN when no downloader is configured', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('APIFY_TOKEN', '');
    vi.stubEnv('SCRAPECREATORS_API_KEY', '');
    await expect(fetchReference('https://www.tiktok.com/@a/video/1'))
      .rejects.toMatchObject({ code: 'config', message: expect.stringContaining('APIFY_TOKEN') });
  });

  it('fails with a customer-readable message when the scraper finds no video', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('APIFY_TOKEN', 't');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const err = await fetchReference('https://www.tiktok.com/@a/video/1').catch((e) => e);
    expect(err.code).toBe('failed');
    expect(err.message).toMatch(/Upload the file instead/);
  });
});
