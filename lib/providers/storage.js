/*
 * File storage for generated media.
 *
 * Backend: Vercel Blob by default; Cloudflare R2 (S3 API) only when every
 * R2_* variable is set; a temp directory in mock mode (STORY_MOCK=1), served
 * in dev by pages/api/mock/storage/[...key].js.
 *
 *   putObject({ key, body, contentType, contentLength }) -> { url, key }
 *   mirrorUrl({ srcUrl, key })                           -> { url, key }
 *   deleteObject({ key })                                -> count deleted
 *   deleteObjects({ keys })                              -> count deleted
 *
 * `key` is the object path (e.g. "story/<project>/<shot>.mp4"); store it to
 * delete the object later. A missing object is not an error. Neither R2 nor
 * Blob reports whether a key existed, so the count there is the number of
 * keys the backend accepted for deletion; the mock backend counts real files.
 */

import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { del, put } from '@vercel/blob';

import { PROVIDER_CONFIG } from './config.js';
import { ProviderError, requireEnv, toProviderError } from './errors.js';
import { assertPublicHttpUrl, downloadToFile } from './http.js';
import { fixturePath, fixturePathForUrl, isMock } from './mock.js';

export { assertPublicHttpUrl };

export const MOCK_STORAGE_DIR = path.join(os.tmpdir(), 'story-mock-storage');
const MOCK_URL_PREFIX = '/api/mock/storage/';

export function storageBackend() {
  if (isMock()) return 'mock';
  return PROVIDER_CONFIG.storage.r2Env.every((name) => process.env[name]) ? 'r2' : 'blob';
}

function checkKey(key) {
  const k = String(key || '');
  if (!k || k.startsWith('/') || k.includes('\\') || k.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new ProviderError('failed', undefined, { cause: new Error(`Unsafe storage key: ${k}`) });
  }
  return k;
}

/** Absolute temp path for a mock-storage key (for tests and the dev route). */
export function mockStoragePath(key) {
  return path.join(MOCK_STORAGE_DIR, ...checkKey(key).split('/'));
}

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

export async function putObject({ key, body, contentType, contentLength }) {
  const k = checkKey(key);
  const backend = storageBackend();
  if (backend === 'mock') {
    const dest = mockStoragePath(k);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body);
    return { url: MOCK_URL_PREFIX + encodeKey(k), key: k };
  }
  try {
    if (backend === 'r2') {
      const { client, bucket, publicBase } = r2();
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: k,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
        ...(contentLength ? { ContentLength: contentLength } : {}),
      }));
      return { url: `${publicBase}/${encodeKey(k)}`, key: k };
    }
    const token = requireEnv(PROVIDER_CONFIG.storage.blobEnv, 'blob');
    const res = await put(k, body, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });
    return { url: res.url, key: res.pathname || k };
  } catch (err) {
    throw toProviderError(err, backend);
  }
}

function mockSourceFor(srcUrl, key) {
  const fromUrl = fixturePathForUrl(srcUrl);
  if (fromUrl) return fromUrl;
  const ext = path.extname(key).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') return fixturePath('still.png');
  if (ext === '.mp3' || ext === '.wav' || ext === '.m4a') return fixturePath('voice.mp3');
  return fixturePath('clip.mp4');
}

/** Copies a public URL into storage (streamed, 200 MB cap, SSRF-guarded). */
export async function mirrorUrl({ srcUrl, key }) {
  const k = checkKey(key);
  if (storageBackend() === 'mock') {
    const dest = mockStoragePath(k);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(mockSourceFor(srcUrl, k), dest);
    return { url: MOCK_URL_PREFIX + encodeKey(k), key: k };
  }
  assertPublicHttpUrl(srcUrl);
  const { filePath, bytes, contentType } = await downloadToFile(srcUrl, {
    maxBytes: PROVIDER_CONFIG.storage.mirrorMaxBytes,
    provider: 'mirror',
  });
  try {
    return await putObject({
      key: k,
      body: createReadStream(filePath),
      contentType: contentType || undefined,
      contentLength: bytes,
    });
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
}

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
