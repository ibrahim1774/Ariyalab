/*
 * Small HTTP helpers shared by the providers: JSON requests with error
 * mapping, an SSRF guard for URLs that come from customers or third parties,
 * and capped streaming downloads.
 *
 * SSRF rules (assertPublicHttpUrl + resolvePublicUrl + guardedLookup):
 *   - only http(s); trailing dots stripped; localhost, *.localhost and
 *     single-label names refused;
 *   - IP literals (any notation the URL parser accepts) and every address a
 *     name resolves to must be public: no loopback, private, CGNAT,
 *     link-local, benchmark, documentation, multicast, broadcast/reserved,
 *     unique-local/site-local IPv6, NAT64/6to4/Teredo, or IPv4-mapped/
 *     -compatible IPv6 of any of those;
 *   - the connection is pinned: downloads use an undici Agent whose DNS
 *     lookup re-checks the address it connects to, so a rebinding answer
 *     between check and connect is refused;
 *   - redirects are followed by hand and every hop is checked again;
 *     request headers are dropped once the origin changes.
 */

import dns from 'node:dns';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Agent, fetch as undiciFetch } from 'undici';

import { PROVIDER_CONFIG } from './config.js';
import { ProviderError, errorFromStatus, toProviderError } from './errors.js';

// ---- address classification ----------------------------------------------

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/** Expands an IPv6 literal to 8 numeric hextets (null if malformed). */
function ipv6Hextets(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const p = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...rest].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d) or -compatible (::a.b.c.d) address. */
function embeddedIPv4(hextets) {
  if (hextets.slice(0, 5).some((h) => h !== 0)) return null;
  if (hextets[5] !== 0 && hextets[5] !== 0xffff) return null;
  const [a, b] = [hextets[6], hextets[7]];
  return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
}

/** True for any address that must never be fetched (and for non-addresses). */
export function isPrivateAddress(ip) {
  const family = net.isIP(String(ip || ''));
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family === 6) {
    const hextets = ipv6Hextets(ip);
    if (!hextets) return true;
    const v4 = embeddedIPv4(hextets);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(ip.split('%')[0], 'ipv6');
  }
  return true;
}

const PRIVATE_LINK = 'That link points to a private address and cannot be used.';

/**
 * Synchronous string checks (no DNS). Returns the parsed URL.
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
  const host = hostOf(url);
  if (!host) throw new ProviderError('failed', 'That link is not a valid web address.');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new ProviderError('failed', PRIVATE_LINK);
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    throw new ProviderError('failed', PRIVATE_LINK);
  }
  return url;
}

/** Lowercased hostname without IPv6 brackets or trailing dots. */
function hostOf(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function lookupAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses || [])));
  });
}

/** String checks plus DNS: refuses if ANY resolved address is private. */
export async function resolvePublicUrl(raw) {
  const url = assertPublicHttpUrl(raw);
  const host = hostOf(url);
  if (net.isIP(host)) return url;
  let addresses;
  try {
    addresses = await lookupAll(host);
  } catch (err) {
    throw new ProviderError('failed', "We couldn't reach that link.", { cause: err });
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ProviderError('failed', PRIVATE_LINK);
  }
  return url;
}

/**
 * net/tls `lookup` replacement used at connect time: resolves, refuses if any
 * address is private, and hands back only checked addresses.
 */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = (addresses || []).filter((a) => !opts.family || a.family === opts.family);
    if (list.length === 0 || (addresses || []).some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`Refused to connect to a private address for ${hostname}`);
      e.code = 'ESSRF';
      return cb(e);
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

let pinnedAgent;
function guardedAgent() {
  if (!pinnedAgent) pinnedAgent = new Agent({ connect: { lookup: guardedLookup } });
  return pinnedAgent;
}

// ---- JSON / bytes requests to fixed provider endpoints ---------------------

function withTimeout(init = {}, timeoutMs = PROVIDER_CONFIG.http.timeoutMs) {
  if (init.signal || !timeoutMs) return init;
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * fetch + JSON parse with ProviderError mapping. HTTP 429 -> rate_limited,
 * content refusals on 400/422 -> blocked, anything else non-2xx -> failed.
 * Only for fixed provider endpoints; customer URLs go through downloadToFile.
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
  } catch {
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
  return fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

// ---- guarded fetches of untrusted URLs -------------------------------------

/**
 * Fetches an untrusted URL: every hop is DNS-checked, the connection is
 * pinned to checked addresses, and headers are dropped across origins.
 * -> { res, url } where url is the final URL.
 */
export async function fetchPublic(rawUrl, {
  headers, provider, timeoutMs = PROVIDER_CONFIG.http.downloadTimeoutMs, method = 'GET', stopAt,
} = {}) {
  let url = await resolvePublicUrl(rawUrl);
  const origin = url.origin;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= PROVIDER_CONFIG.http.maxRedirects; hop += 1) {
    // `stopAt(url)` lets a caller stop before fetching a hop (res is then null).
    if (hop > 0 && stopAt?.(url)) return { res: null, url };
    let res;
    try {
      res = await undiciFetch(url.toString(), {
        method,
        headers: url.origin === origin ? headers : undefined,
        redirect: 'manual',
        signal,
        dispatcher: guardedAgent(),
      });
    } catch (err) {
      throw toProviderError(err, provider);
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return { res, url };
    await res.body?.cancel().catch(() => {});
    url = await resolvePublicUrl(new URL(location, url).toString());
  }
  throw new ProviderError('failed', undefined, { cause: new Error('Too many redirects'), provider });
}

/**
 * Follows a share link's redirects (guarded) and returns the final URL.
 * With `stopAt(url)`, stops at the first hop it accepts without fetching it.
 */
export async function resolveRedirects(rawUrl, opts = {}) {
  const { res, url } = await fetchPublic(rawUrl, opts);
  await res?.body?.cancel().catch(() => {});
  return url.toString();
}

function tooLarge(maxBytes) {
  return new ProviderError('failed', `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
}

/**
 * Streams an untrusted URL to `dest` (or to a new temp directory when `dest`
 * is omitted), aborting past `maxBytes`. On failure the partial file is
 * removed, and the temp directory too when this call created it.
 * -> { filePath, bytes, contentType }
 */
export async function downloadToFile(rawUrl, { maxBytes, dest, headers, provider, timeoutMs } = {}) {
  const { res } = await fetchPublic(rawUrl, { headers, provider, timeoutMs });
  if (!res.ok || !res.body) throw errorFromStatus(res.status, await res.text().catch(() => ''), provider);
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }

  const ownDir = dest ? null : await makeTempDir('story-dl');
  const filePath = dest || path.join(ownDir, 'download');
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
    await fsp.rm(ownDir || filePath, { recursive: true, force: true });
    throw toProviderError(err, provider);
  }
  return { filePath, bytes, contentType: res.headers.get('content-type') || '' };
}
