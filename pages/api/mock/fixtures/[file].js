import fs from 'node:fs';
import path from 'node:path';

import { FIXTURE_FILES, fixturePath } from '../../../../lib/providers/mock.js';

/*
 * Dev-only: serves the committed media fixtures (tests/fixtures) behind the
 * relative mock URLs /api/mock/fixtures/<file>. 404 unless STORY_MOCK=1 and
 * not in production, so fixtures never ship as public static files.
 */

const TYPES = { '.mp4': 'video/mp4', '.png': 'image/png', '.mp3': 'audio/mpeg' };

export default async function handler(req, res) {
  const file = String(req.query.file || '');
  if (process.env.STORY_MOCK !== '1' || process.env.NODE_ENV === 'production' || !FIXTURE_FILES.includes(file)) {
    res.statusCode = 404;
    return res.end();
  }
  const filePath = fixturePath(file);
  const info = await fs.promises.stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)]);
  res.setHeader('Content-Length', String(info.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
