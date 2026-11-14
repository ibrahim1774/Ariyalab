/*
 * Small HTTP helpers shared by the providers: JSON requests with error
 * mapping, a basic SSRF guard, and capped streaming downloads.
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ProviderError, errorFromStatus, toProviderError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 120 * 1000;

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Basic SSRF guard. Resolves nothing: blocks non-http(s) schemes and literal
 * localhost / loopback / private / link-local hosts. Returns the parsed URL.
 */
export function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ProviderError('failed', 'That link is not a valid web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderError('failed', 'Only http and https links can be used.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIPv6 = host.includes(':');
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isPrivateIPv4(host) ||
    (isIPv6 && (host === '::1' || host === '::' || /^(fe80|fc|fd)/.test(host) || host.startsWith('::ffff:')));
  if (blocked) throw new ProviderError('failed', 'That link points to a private address and cannot be used.');
  return url;
}

function withTimeout(init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (init.signal || !timeoutMs) return init;
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * fetch + JSON parse with ProviderError mapping. HTTP 429 -> rate_limited,
 * content refusals on 400/422 -> blocked, anything else non-2xx -> failed.
 */
export async function requestJson(url, init = {}, { provider, timeoutMs } = {}) {
  let res;
  try {
    res = await fetch(url, withTimeout(init, timeoutMs));
  } catch (err) {
    throw toProviderError(err, provider);
  }
  const text = await res.text();
  if (!res.ok) throw errorFromStatus(res.status, text, provider);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError('failed', undefined, { cause: new Error(`Non-JSON response: ${text.slice(0, 300)}`), provider });
  }
}

/** fetch that returns raw bytes, with the same error mapping. */
export async function requestBuffer(url, init = {}, { provider, timeoutMs } = {}) {
  let res;
  try {
    res = await fetch(url, withTimeout(init, timeoutMs));
  } catch (err) {
    throw toProviderError(err, provider);
  }
  if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''), provider);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

export async function makeTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function tooLarge(maxBytes) {
  return new ProviderError('failed', `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
}

/**
 * Streams a public URL to `dest` (created when omitted), aborting past
 * `maxBytes`. Runs the SSRF guard first.
 * -> { filePath, bytes, contentType }
 */
const MAX_REDIRECTS = 5;

/**
 * Follows redirects by hand so every hop passes the SSRF guard. Headers
 * (e.g. Authorization) are dropped once the origin changes.
 */
async function fetchPublic(rawUrl, { headers, provider, timeoutMs }) {
  let url = assertPublicHttpUrl(rawUrl);
  const origin = url.origin;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res;
    try {
      res = await fetch(url.toString(), {
        headers: url.origin === origin ? headers : undefined,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      throw toProviderError(err, provider);
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel().catch(() => {});
    url = assertPublicHttpUrl(new URL(location, url).toString());
  }
  throw new ProviderError('failed', undefined, { cause: new Error('Too many redirects'), provider });
}

export async function downloadToFile(rawUrl, { maxBytes, dest, headers, provider, timeoutMs = 10 * 60 * 1000 } = {}) {
  const res = await fetchPublic(rawUrl, { headers, provider, timeoutMs });
  if (!res.ok || !res.body) throw errorFromStatus(res.status, await res.text().catch(() => ''), provider);
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }

  const filePath = dest || path.join(await makeTempDir('story-dl'), 'download');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (maxBytes && bytes > maxBytes) cb(tooLarge(maxBytes));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(filePath));
  } catch (err) {
    await rm(filePath, { force: true });
    throw toProviderError(err, provider);
  }
  return { filePath, bytes, contentType: res.headers.get('content-type') || '' };
}
