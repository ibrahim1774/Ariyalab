import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { mockStoragePath } from '../../../../lib/providers/storage.js';

/*
 * Dev-only: serves files that lib/providers/storage.js wrote to its temp
 * directory in mock mode (STORY_MOCK=1). 404 everywhere else.
 */

const TYPES = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

export default async function handler(req, res) {
  if (process.env.STORY_MOCK !== '1' || process.env.NODE_ENV === 'production') {
    return res.status(404).end();
  }
  const parts = Array.isArray(req.query.key) ? req.query.key : [req.query.key];
  let filePath;
  try {
    filePath = mockStoragePath(parts.join('/'));
  } catch {
    return res.status(400).end();
  }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return res.status(404).end();
  res.setHeader('Content-Type', TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', String(info.size));
  createReadStream(filePath).pipe(res);
}
