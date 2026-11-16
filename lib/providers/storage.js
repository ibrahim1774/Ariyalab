/*
 * File storage for generated media.
 *
 * Backend: Vercel Blob by default; Cloudflare R2 (S3 API) only when every
 * R2_* variable is set; a temp directory in mock mode (STORY_MOCK=1), served
 * in dev by pages/api/mock/storage/[...key].js.
 *
 *   putObject({ key, body, contentType, contentLength, signal }) -> { url, key }
 *   mirrorUrl({ srcUrl, key, signal })                           -> { url, key }
 *   deleteObject({ key })                                -> count deleted
 *   deleteObjects({ keys })                              -> count deleted
 *   localPathFor(url)            -> local file path for a mock URL, else null
 *   toAbsoluteUrl(url, origin)   -> absolute URL (mock URLs are relative)
 *
 * `key` is the object path (e.g. "story/<project>/<shot>.mp4"); store it to
 * delete the object later. A missing object is not an error. Neither R2 nor
 * Blob reports whether a key existed, so the count there is the number of
 * keys the backend accepted for deletion; the mock backend counts real files.
 *
 * Content types (stored-XSS guard): the stored type always comes from the
 * key's extension via PROVIDER_CONFIG.storage (`contentType` from the caller
 * and the source's Content-Type are ignored). Media (jpg/png/webp/mp4/mp3/
 * wav/m4a) must match its magic bytes; json/txt/srt/vtt are stored as
 * attachments; anything else is refused. mirrorUrl accepts media keys only.
 */

import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { del, put } from '@vercel/blob';

import { PROVIDER_CONFIG } from './config.js';
import { ProviderError, requireEnv, toProviderError } from './errors.js';
import { assertPublicHttpUrl, downloadToFile } from './http.js';
import { fixturePath, fixturePathForUrl, isMock } from './mock.js';

export { assertPublicHttpUrl };

export const MOCK_STORAGE_DIR = path.join(os.tmpdir(), 'story-mock-storage');
export const MOCK_STORAGE_PREFIX = '/api/mock/storage/';

export function storageBackend() {
  if (isMock()) return 'mock';
  return PROVIDER_CONFIG.storage.r2Env.every((name) => process.env[name]) ? 'r2' : 'blob';
}

function checkKey(key) {
  const k = String(key || '');
  if (!k || k.startsWith('/') || k.includes('\\') || k.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new ProviderError('failed', undefined, { cause: { message: `Unsafe storage key: ${k}` } });
  }
  return k;
}

/** Absolute temp path for a mock-storage key (for tests and the dev route). */
export function mockStoragePath(key) {
  return path.join(MOCK_STORAGE_DIR, ...checkKey(key).split('/'));
}

// ---- content types ----------------------------------------------------------

/** -> { type, media: boolean } for an allowed key extension; throws otherwise. */
export function storedTypeFor(key) {
  const ext = path.extname(String(key || '')).toLowerCase();
  const { mediaTypes, attachmentTypes } = PROVIDER_CONFIG.storage;
  if (mediaTypes[ext]) return { type: mediaTypes[ext], media: true };
  if (attachmentTypes[ext]) return { type: attachmentTypes[ext], media: false };
  throw new ProviderError('failed', 'That file type cannot be stored.', { cause: { message: `Refused extension "${ext}" for ${key}` } });
}

const ascii = (buf, start, text) => buf.length >= start + text.length && buf.toString('latin1', start, start + text.length) === text;

/** True when the first bytes match the media type. */
export function matchesMagic(type, head) {
  const b = head || Buffer.alloc(0);
  switch (type) {
    case 'image/jpeg': return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp': return ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP');
    case 'audio/wav': return ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE');
    case 'video/mp4':
    case 'video/quicktime':
    case 'audio/mp4': return ascii(b, 4, 'ftyp');
    case 'audio/mpeg': return ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    default: return false;
  }
}

function wrongContent(key) {
  return new ProviderError('failed', "That file's contents don't match its type.", { cause: { message: `Magic bytes do not match ${key}` } });
}

/**
 * Returns { body, head } where head holds the first bytes. Streams are peeked
 * and rebuilt so nothing is lost.
 */
async function peekBody(body) {
  if (typeof body === 'string') {
    const buf = Buffer.from(body);
    return { body: buf, head: buf.subarray(0, 16) };
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return { body, head: buf.subarray(0, 16) };
  }
  let stream = body;
  if (stream && typeof stream.getReader === 'function') stream = Readable.fromWeb(stream);
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new ProviderError('failed', undefined, { cause: { message: 'Unsupported body type' } });
  }
  const iterator = stream[Symbol.asyncIterator]();
  const first = [];
  let size = 0;
  let done = false;
  while (size < 16) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const chunk = Buffer.from(next.value);
    first.push(chunk);
    size += chunk.length;
  }
  const head = Buffer.concat(first).subarray(0, 16);
  const rebuilt = Readable.from((async function* replay() {
    for (const c of first) yield c;
    if (!done) {
      for (let n = await iterator.next(); !n.done; n = await iterator.next()) yield n.value;
    }
  })());
  return { body: rebuilt, head };
}

/** Validates key + bytes. -> { body, type, media } */
async function vetUpload(key, body) {
  const { type, media } = storedTypeFor(key);
  const peeked = await peekBody(body);
  if (media && !matchesMagic(type, peeked.head)) throw wrongContent(key);
  return { body: peeked.body, type, media };
}

// ---- backends ---------------------------------------------------------------

function r2() {
  const account = process.env.R2_ACCOUNT_ID;
  return {
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    }),
    bucket: process.env.R2_BUCKET,
    publicBase: process.env.R2_PUBLIC_URL.replace(/\/+$/, ''),
  };
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function streamToBuffer(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') return body;
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function abortedError(signal) {
  return new ProviderError('failed', undefined, { cause: signal.reason ?? new DOMException('Aborted', 'AbortError') });
}

/**
 * Stores `body` under `key`. `contentType` is accepted for compatibility but
 * ignored: the stored type comes from the key's extension. `signal`
 * (optional) aborts the upload (R2 and Blob get it as their abortSignal); an
 * already-aborted signal stores nothing.
 */
export async function putObject({ key, body, contentLength, signal }) {
  const k = checkKey(key);
  if (signal?.aborted) throw abortedError(signal);
  const vetted = await vetUpload(k, body);
  const backend = storageBackend();
  if (backend === 'mock') {
    const dest = mockStoragePath(k);
    await mkdir(path.dirname(dest), { recursive: true });
    const bytes = await streamToBuffer(vetted.body);
    if (signal?.aborted) throw abortedError(signal);
    await writeFile(dest, bytes, signal ? { signal } : undefined).catch((err) => {
      if (signal?.aborted) throw abortedError(signal);
      throw err;
    });
    return { url: MOCK_STORAGE_PREFIX + encodeKey(k), key: k };
  }
  try {
    if (backend === 'r2') {
      const { client, bucket, publicBase } = r2();
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: k,
        Body: vetted.body,
        ContentType: vetted.type,
        ...(vetted.media ? {} : { ContentDisposition: 'attachment' }),
        ...(contentLength ? { ContentLength: contentLength } : {}),
      }), signal ? { abortSignal: signal } : undefined);
      return { url: `${publicBase}/${encodeKey(k)}`, key: k };
    }
    const token = requireEnv(PROVIDER_CONFIG.storage.blobEnv, 'blob');
    const res = await put(k, vetted.body, {
      access: 'public',
      contentType: vetted.type,
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return { url: res.url, key: res.pathname || k };
  } catch (err) {
    throw toProviderError(err, backend);
  }
}

// ---- mock URL helpers ---------------------------------------------------------

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Local file for a mock URL (/api/mock/fixtures/<file>, /mock/<file>,
 * /api/mock/storage/<key>; absolute forms of those only in mock mode).
 * null for real URLs and anything that escapes the mock directories.
 */
export function localPathFor(url) {
  const raw = String(url || '');
  if (!raw) return null;
  if (ABSOLUTE.test(raw) && !isMock()) return null;
  let pathname;
  try {
    pathname = new URL(raw, 'http://mock.invalid').pathname;
  } catch {
    return null;
  }
  const fixture = fixturePathForUrl(pathname);
  if (fixture) return fixture;
  if (pathname.startsWith(MOCK_STORAGE_PREFIX)) {
    try {
      return mockStoragePath(decodeURIComponent(pathname.slice(MOCK_STORAGE_PREFIX.length)));
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolves a (possibly relative) URL against `origin`; absolute URLs are returned as they are. */
export function toAbsoluteUrl(url, origin) {
  const raw = String(url || '');
  if (ABSOLUTE.test(raw)) return raw;
  return new URL(raw, origin).toString();
}

function mockSourceFor(srcUrl, key) {
  // The mock's own URLs (relative, or their absolute dev-server form) map to
  // local files; everything else gets the same URL checks as real mode.
  const local = localPathFor(srcUrl);
  if (local) return local;
  assertPublicHttpUrl(srcUrl);
  const { type } = storedTypeFor(key);
  if (type.startsWith('image/')) return fixturePath('still.png');
  if (type.startsWith('audio/')) return fixturePath('voice.mp3');
  return fixturePath('clip.mp4');
}

/** Copies a public URL into storage (streamed, 200 MB cap, SSRF-guarded, media keys only). */
export async function mirrorUrl({ srcUrl, key, signal }) {
  const k = checkKey(key);
  // `signal` (optional): stop the copy; nothing is stored once it has fired.
  const stopIfAborted = () => {
    if (signal?.aborted) throw abortedError(signal);
  };
  stopIfAborted();
  if (!storedTypeFor(k).media) {
    throw new ProviderError('failed', 'That file type cannot be stored.', { cause: { message: `mirrorUrl needs a media key: ${k}` } });
  }
  if (storageBackend() === 'mock') {
    const src = mockSourceFor(srcUrl, k);
    const body = await readFile(src, signal ? { signal } : undefined).catch(() => {
      stopIfAborted();
      throw new ProviderError('failed', undefined, { cause: { message: `Mock source missing: ${srcUrl}` } });
    });
    stopIfAborted();
    return putObject({ key: k, body, signal });
  }
  assertPublicHttpUrl(srcUrl);
  const { filePath, bytes } = await downloadToFile(srcUrl, {
    maxBytes: PROVIDER_CONFIG.storage.mirrorMaxBytes,
    provider: 'mirror',
    signal,
  });
  try {
    const handle = await open(filePath, 'r');
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0).finally(() => handle.close());
    if (!matchesMagic(storedTypeFor(k).type, head)) throw wrongContent(k);
    stopIfAborted();
    return await putObject({ key: k, body: createReadStream(filePath), contentLength: bytes, signal });
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
}

// ---- delete -------------------------------------------------------------------

export async function deleteObjects({ keys }) {
  const list = [...new Set((keys || []).map(checkKey))];
  if (list.length === 0) return 0;
  const backend = storageBackend();
  if (backend === 'mock') {
    let count = 0;
    for (const k of list) {
      const p = mockStoragePath(k);
      const exists = await stat(p).then(() => true, () => false);
      if (exists) {
        await rm(p, { force: true });
        count += 1;
      }
    }
    return count;
  }
  try {
    if (backend === 'r2') {
      const { client, bucket } = r2();
      let count = 0;
      for (let i = 0; i < list.length; i += PROVIDER_CONFIG.storage.deleteBatch) {
        const chunk = list.slice(i, i + PROVIDER_CONFIG.storage.deleteBatch);
        const res = await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
        }));
        count += Array.isArray(res?.Deleted) ? res.Deleted.length : 0;
      }
      return count;
    }
    const token = requireEnv(PROVIDER_CONFIG.storage.blobEnv, 'blob');
    await del(list, { token });
    return list.length;
  } catch (err) {
    throw toProviderError(err, backend);
  }
}

export async function deleteObject({ key }) {
  return deleteObjects({ keys: [key] });
}
