import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectPlatform, fetchReference } from '../../lib/providers/fetchVideo.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
    expect(calls[0].url).toMatch(/^https:\/\/api\.apify\.com\/v2\/acts\/apify~instagram-scraper\/run-sync-get-dataset-items/);
    expect(calls[0].init.headers.Authorization).toBe('Bearer apify-token');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      directUrls: ['https://www.instagram.com/reel/abc/'], resultsType: 'posts',
    });
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
