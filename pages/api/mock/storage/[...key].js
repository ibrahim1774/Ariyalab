import fs from 'node:fs';

import { mockStoragePath, storedTypeFor } from '../../../../lib/providers/storage.js';

/*
 * Dev-only: serves files that lib/providers/storage.js wrote to its temp
 * directory in mock mode (STORY_MOCK=1). 404 everywhere else. Types follow
 * the storage allowlist; non-media is served as an attachment.
 */

export default async function handler(req, res) {
  if (process.env.STORY_MOCK !== '1' || process.env.NODE_ENV === 'production') {
    res.statusCode = 404;
    return res.end();
  }
  const parts = Array.isArray(req.query.key) ? req.query.key : [req.query.key];
  let filePath;
  let type;
  try {
    const key = parts.join('/');
    filePath = mockStoragePath(key);
    type = storedTypeFor(key);
  } catch {
    res.statusCode = 400;
    return res.end();
  }
  const info = await fs.promises.stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', type.type);
  res.setHeader('Content-Length', String(info.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!type.media) res.setHeader('Content-Disposition', 'attachment');
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}
