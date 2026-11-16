import { getUserFromRequest } from '../../../lib/supabaseServer.js';
import { sendError } from '../../../lib/story/errors.js';
import { AUDIO_LIMITS, registerAudio, uploadPrefix } from '../../../lib/story/voices.js';

/*
 * The customer's own audio: an mp3, wav or m4a of at most 20 MB.
 *
 *   GET  /api/story/assets   -> { uploadPrefix, limits }   where the browser uploads to (Vercel Blob, through /api/upload-token)
 *   POST /api/story/assets   { kind: 'voice_sample' | 'voice_track' | 'music', url, name? } -> 201 { asset }
 *
 * POST looks at the file the browser uploaded (size, type, first bytes, length and codec) and keeps it as an asset only
 * when it is what it says. A refused file is deleted and answered with a specific 422.
 */
export const config = { api: { bodyParser: { sizeLimit: '16kb' } }, maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  const userId = session.user.id;
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ uploadPrefix: uploadPrefix(userId), limits: { maxBytes: AUDIO_LIMITS.maxBytes, sampleMinSeconds: AUDIO_LIMITS.sampleMinSeconds, sampleMaxSeconds: AUDIO_LIMITS.sampleMaxSeconds } });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    return res.status(201).json({ asset: await registerAudio({ userId, kind: body.kind, url: body.url, name: body.name }) });
  } catch (err) {
    return sendError(res, err);
  }
}
