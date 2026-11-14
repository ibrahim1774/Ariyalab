/*
 * Downloads a reference video from an Instagram, TikTok or Facebook link.
 *
 *   fetchReference(url) -> { filePath, platform, audioPath? }
 *
 * Downloader: Apify (APIFY_TOKEN) by default; ScrapeCreators only when
 * SCRAPECREATORS_API_KEY is set and APIFY_TOKEN is not. Some Instagram reels
 * come back silent with the sound in a separate track: audioPath is then set
 * so a later step can mux the two. Files land in a fresh temp directory,
 * capped at 100 MB each. Any other host throws ProviderError 'failed' with
 * "Upload the file instead".
 */

import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { PROVIDER_CONFIG } from './config.js';
import { ProviderError, configError } from './errors.js';
import { downloadToFile, makeTempDir, requestJson } from './http.js';
import { fixturePath, isMock } from './mock.js';

const UNSUPPORTED = "We can only fetch Instagram, TikTok and Facebook links. Upload the file instead.";
const NOT_FOUND = "We couldn't download a video from that link. Make sure the post is public. Upload the file instead.";

const HOSTS = {
  'instagram.com': 'instagram',
  'tiktok.com': 'tiktok',
  'facebook.com': 'facebook',
  'fb.watch': 'facebook',
};

/** -> 'instagram' | 'tiktok' | 'facebook'; throws for anything else. */
export function detectPlatform(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ProviderError('failed', UNSUPPORTED);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('failed', UNSUPPORTED);
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const platform = HOSTS[host];
  if (!platform) throw new ProviderError('failed', UNSUPPORTED);
  return platform;
}

function notFound(cause, provider) {
  return new ProviderError('failed', NOT_FOUND, { cause, provider });
}

// ---- Apify ------------------------------------------------------------

function apifyInput(platform, url) {
  if (platform === 'instagram') return { directUrls: [url], resultsType: 'posts', resultsLimit: 1 };
  if (platform === 'tiktok') return { postURLs: [url], shouldDownloadVideos: true, resultsPerPage: 1 };
  return { startUrls: [{ url }], resultsLimit: 1 };
}

function apifyMedia(platform, item) {
  if (!item || item.error) return {};
  if (platform === 'instagram') return { videoUrl: item.videoUrl, audioUrl: item.audioUrl };
  if (platform === 'tiktok') {
    return { videoUrl: item.videoMeta?.downloadAddr || (Array.isArray(item.mediaUrls) ? item.mediaUrls[0] : null) };
  }
  const pv = item.playback_video || {};
  return { videoUrl: pv.browser_native_hd_url || pv.browser_native_sd_url || item.videoUrl };
}

async function viaApify(platform, url, token) {
  const cfg = PROVIDER_CONFIG.apify;
  const actor = cfg.actors[platform].replace('/', '~');
  const items = await requestJson(
    `${cfg.baseUrl}/acts/${actor}/run-sync-get-dataset-items?timeout=${cfg.timeoutSecs}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(apifyInput(platform, url)),
    },
    { provider: 'apify', timeoutMs: (cfg.timeoutSecs + 30) * 1000 },
  );
  const item = Array.isArray(items) ? items[0] : null;
  const media = apifyMedia(platform, item);
  if (!media.videoUrl) throw notFound(new Error(`Apify ${platform}: no video in ${JSON.stringify(item)?.slice(0, 300)}`), 'apify');
  // TikTok downloads land in Apify's key-value store, which needs the token.
  const authFor = (u) => (new URL(u).hostname === 'api.apify.com' ? { Authorization: `Bearer ${token}` } : undefined);
  return { ...media, authFor };
}

// ---- ScrapeCreators ---------------------------------------------------

function scrapeCreatorsMedia(platform, body) {
  if (platform === 'instagram') {
    return { videoUrl: body?.data?.xdt_shortcode_media?.video_url };
  }
  if (platform === 'tiktok') {
    const v = body?.aweme_detail?.video || {};
    const pick = (addr) => (Array.isArray(addr?.url_list) ? addr.url_list[0] : null);
    return { videoUrl: pick(v.download_no_watermark_addr) || pick(v.play_addr) || pick(v.download_addr) };
  }
  return { videoUrl: body?.video?.hd_url || body?.video?.sd_url };
}

async function viaScrapeCreators(platform, url, key) {
  const cfg = PROVIDER_CONFIG.scrapecreators;
  const body = await requestJson(
    `${cfg.baseUrl}${cfg.paths[platform]}?url=${encodeURIComponent(url)}`,
    { headers: { 'x-api-key': key } },
    { provider: 'scrapecreators' },
  );
  const media = scrapeCreatorsMedia(platform, body);
  if (!media.videoUrl) throw notFound(new Error(`ScrapeCreators ${platform}: no video url`), 'scrapecreators');
  return { ...media, authFor: () => undefined };
}

// ---- entry point --------------------------------------------------------

export async function fetchReference(url) {
  const platform = detectPlatform(url);
  const dir = await makeTempDir('story-ref');
  const filePath = path.join(dir, 'reference.mp4');

  if (isMock()) {
    await copyFile(fixturePath('reference.mp4'), filePath);
    return { filePath, platform };
  }

  try {
    return await downloadReference(platform, url, dir, filePath);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function downloadReference(platform, url, dir, filePath) {
  const apifyToken = process.env[PROVIDER_CONFIG.apify.env];
  const scKey = process.env[PROVIDER_CONFIG.scrapecreators.env];
  let media;
  if (apifyToken) media = await viaApify(platform, url, apifyToken);
  else if (scKey) media = await viaScrapeCreators(platform, url, scKey);
  else throw configError(PROVIDER_CONFIG.apify.env, 'apify');

  const maxBytes = PROVIDER_CONFIG.reference.maxBytes;
  await downloadToFile(media.videoUrl, { dest: filePath, maxBytes, headers: media.authFor(media.videoUrl), provider: 'reference' });
  const out = { filePath, platform };
  if (media.audioUrl) {
    const audioPath = path.join(dir, 'reference-audio.mp4');
    await downloadToFile(media.audioUrl, { dest: audioPath, maxBytes, headers: media.authFor(media.audioUrl), provider: 'reference' });
    out.audioPath = audioPath;
  }
  return out;
}
