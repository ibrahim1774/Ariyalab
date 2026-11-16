/*
 * Downloads a reference video from an Instagram, TikTok or Facebook link.
 *
 *   fetchReference(url, { timeoutMs }?) -> { filePath, platform, audioPath?, cleanup }
 *
 * timeoutMs (optional) bounds the whole fetch: the scraper run, the share-link
 * redirects and the downloads all end by then (a caller inside a time window,
 * such as the analyze worker, passes what it can spare). Without it each step
 * keeps its own default.
 *
 * cleanup() removes the temp directory holding the files; call it once the
 * files are processed. On any failure the directory is removed already.
 * TikTok share links (vm.tiktok.com, vt.tiktok.com) are resolved through the
 * guarded fetch first, and the final URL must be on the allowlist.
 * Mock mode: copies tests/fixtures/reference.mp4; with [[mock:silent-reel]]
 * in the URL it returns reference-silent.mp4 plus voice.mp3 as audioPath.
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
import { downloadToFile, makeTempDir, requestJson, resolveRedirects } from './http.js';
import { MOCK_FAIL, MOCK_SILENT_REEL, fixturePath, hasMockToken, isMock } from './mock.js';

const UNSUPPORTED = "We can only fetch Instagram, TikTok and Facebook links. Upload the file instead.";
const NOT_FOUND = "We couldn't download a video from that link. Make sure the post is public. Upload the file instead.";
export const SHARE_LINK_FAILED = "We couldn't open that TikTok share link. Paste the full video link.";
// Where a mock share link resolves to.
const MOCK_CANONICAL = 'https://www.tiktok.com/@mock/video/7300000000000000000';

const HOSTS = {
  'instagram.com': 'instagram',
  'tiktok.com': 'tiktok',
  'facebook.com': 'facebook',
  'fb.watch': 'facebook',
};

function parseHost(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ProviderError('failed', UNSUPPORTED);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('failed', UNSUPPORTED);
  return url.hostname.toLowerCase().replace(/\.+$/, '');
}

function isShareHost(host) {
  return PROVIDER_CONFIG.reference.shareHosts.includes(host);
}

/** -> 'instagram' | 'tiktok' | 'facebook'; throws for anything else. */
export function detectPlatform(raw) {
  const host = parseHost(raw);
  if (isShareHost(host)) return 'tiktok';
  const platform = HOSTS[host.replace(/^(www|m)\./, '')];
  if (!platform) throw new ProviderError('failed', UNSUPPORTED);
  return platform;
}

/** Milliseconds left before `deadline` (at least 1 s), capped at `fallback`; `fallback` when there is no deadline. */
function msLeft(deadline, fallback) {
  if (!deadline) return fallback;
  const left = Math.max(1000, deadline - Date.now());
  return fallback === undefined ? left : Math.min(fallback, left);
}

/** Resolves a share link to its canonical post URL (which must be allowlisted). */
async function canonicalUrl(url, deadline) {
  if (!isShareHost(parseHost(url))) return url;
  let finalUrl;
  try {
    finalUrl = await resolveRedirects(url, {
      provider: 'reference',
      timeoutMs: msLeft(deadline, PROVIDER_CONFIG.http.timeoutMs),
      stopAt: (u) => !isShareHost(u.hostname.toLowerCase()),
    });
  } catch (err) {
    throw new ProviderError('failed', SHARE_LINK_FAILED, { cause: err.cause || err, provider: 'reference' });
  }
  // A share link that never left the share host did not redirect to a video.
  if (isShareHost(parseHost(finalUrl))) throw new ProviderError('failed', SHARE_LINK_FAILED);
  detectPlatform(finalUrl);
  return finalUrl;
}

/**
 * The URL to scrape: a TikTok share link (vm./vt.tiktok.com) resolved to its canonical post URL through the guarded
 * redirect fetch; any other allowed link unchanged. No provider is called, so a caller can do this before it pays.
 * Throws ProviderError 'failed' (SHARE_LINK_FAILED for a share link that does not resolve). Mock mode resolves a share
 * link to a fixed TikTok URL, or fails when the URL holds [[mock:fail]].
 */
export async function resolveReferenceUrl(url, { timeoutMs } = {}) {
  detectPlatform(url);
  if (!isShareHost(parseHost(url))) return url;
  if (isMock()) {
    if (hasMockToken(String(url), MOCK_FAIL)) throw new ProviderError('failed', SHARE_LINK_FAILED);
    return MOCK_CANONICAL;
  }
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
  return canonicalUrl(url, deadline);
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

async function viaApify(platform, url, token, deadline) {
  const cfg = PROVIDER_CONFIG.apify;
  const actor = cfg.actors[platform].replace('/', '~');
  // Inside a deadline the actor run gets what is left, less 20 s for the download.
  const runSecs = deadline ? Math.max(10, Math.min(cfg.timeoutSecs, Math.floor((deadline - Date.now()) / 1000) - 20)) : cfg.timeoutSecs;
  const items = await requestJson(
    `${cfg.baseUrl}/acts/${actor}/run-sync-get-dataset-items?timeout=${runSecs}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(apifyInput(platform, url)),
    },
    { provider: 'apify', timeoutMs: msLeft(deadline, (runSecs + 30) * 1000) },
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

async function viaScrapeCreators(platform, url, key, deadline) {
  const cfg = PROVIDER_CONFIG.scrapecreators;
  const body = await requestJson(
    `${cfg.baseUrl}${cfg.paths[platform]}?url=${encodeURIComponent(url)}`,
    { headers: { 'x-api-key': key } },
    { provider: 'scrapecreators', timeoutMs: msLeft(deadline, PROVIDER_CONFIG.http.timeoutMs) },
  );
  const media = scrapeCreatorsMedia(platform, body);
  if (!media.videoUrl) throw notFound(new Error(`ScrapeCreators ${platform}: no video url`), 'scrapecreators');
  return { ...media, authFor: () => undefined };
}

// ---- entry point --------------------------------------------------------

export async function fetchReference(url, { timeoutMs } = {}) {
  let platform = detectPlatform(url);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
  const dir = await makeTempDir('story-ref');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const filePath = path.join(dir, 'reference.mp4');
  try {
    if (isMock()) {
      if (String(url).includes(MOCK_SILENT_REEL)) {
        const audioPath = path.join(dir, 'reference-audio.mp3');
        await copyFile(fixturePath('reference-silent.mp4'), filePath);
        await copyFile(fixturePath('voice.mp3'), audioPath);
        return { filePath, platform, audioPath, cleanup };
      }
      await copyFile(fixturePath('reference.mp4'), filePath);
      return { filePath, platform, cleanup };
    }
    // The platform (and so the scraper) follows the RESOLVED URL, not the share link.
    const canonical = await canonicalUrl(url, deadline);
    platform = detectPlatform(canonical);
    const out = await downloadReference(platform, canonical, dir, filePath, deadline);
    return { ...out, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function downloadReference(platform, url, dir, filePath, deadline) {
  const apifyToken = process.env[PROVIDER_CONFIG.apify.env];
  const scKey = process.env[PROVIDER_CONFIG.scrapecreators.env];
  let media;
  if (apifyToken) media = await viaApify(platform, url, apifyToken, deadline);
  else if (scKey) media = await viaScrapeCreators(platform, url, scKey, deadline);
  else throw configError(PROVIDER_CONFIG.apify.env, 'apify');

  const maxBytes = PROVIDER_CONFIG.reference.maxBytes;
  await downloadToFile(media.videoUrl, { dest: filePath, maxBytes, headers: media.authFor(media.videoUrl), provider: 'reference', timeoutMs: msLeft(deadline) });
  const out = { filePath, platform };
  if (media.audioUrl) {
    const audioPath = path.join(dir, 'reference-audio.mp4');
    await downloadToFile(media.audioUrl, { dest: audioPath, maxBytes, headers: media.authFor(media.audioUrl), provider: 'reference', timeoutMs: msLeft(deadline) });
    out.audioPath = audioPath;
  }
  return out;
}
