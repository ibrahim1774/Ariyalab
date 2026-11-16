import { getUserFromRequest } from '../../../lib/supabaseServer.js';
import { sendError } from '../../../lib/story/errors.js';
import { ASSET_API_KINDS, ASSET_LIMITS, brandPrefix } from '../../../lib/story/assetRules.js';
import { deleteAsset, listAssets, registerAsset } from '../../../lib/story/assets.js';
import { AUDIO_LIMITS, uploadPrefix } from '../../../lib/story/voices.js';

/*
 * The customer's own files: audio (an mp3, wav or m4a of at most 20 MB), pictures (PNG, JPG or WebP, at most 5 MB) and
 * clips (MP4 or MOV, at most 200 MB and 5 minutes).
 *
 *   GET    /api/story/assets                          -> { uploadPrefix, limits, brandPrefix, mediaLimits }
 *            where the browser uploads to (Vercel Blob, through /api/upload-token): audio under uploadPrefix, pictures and clips under brandPrefix
 *   GET    /api/story/assets?list=1[&kinds=logo,product][&brand=1]  -> { assets }   the caller's files, newest first
 *   POST   /api/story/assets   { kind, url, name?, inBrandKit? } -> 201 { asset }
 *            kind: logo | product | mascot | recording | clip | audio | voice_sample | voice_track | music
 *   DELETE /api/story/assets?id=<assetId>             -> { id }   (or { id } in the body)
 *            404 for a file that is not the caller's, 409 asset_in_use { projects, voices } when a video still uses it
 *
 * POST looks at the file the browser uploaded (size, type, first bytes, length and codec) and keeps it as an asset only
 * when it is what it says. A refused file is deleted and answered with a specific 422.
 */
export const config = { api: { bodyParser: { sizeLimit: '16kb' } }, maxDuration: 300 };

const first = (value) => (Array.isArray(value) ? value[0] : value);

export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  const userId = session.user.id;
  try {
    const query = req.query || {};
    if (req.method === 'GET') {
      if (first(query.list) !== undefined || first(query.kinds) !== undefined || first(query.brand) !== undefined) {
        const kinds = String(first(query.kinds) || '').split(',').map((k) => k.trim()).filter((k) => ASSET_API_KINDS.includes(k));
        const brandOnly = ['1', 'true'].includes(String(first(query.brand) || ''));
        return res.status(200).json({ assets: await listAssets({ userId, kinds, brandOnly }) });
      }
      return res.status(200).json({
        uploadPrefix: uploadPrefix(userId),
        limits: { maxBytes: AUDIO_LIMITS.maxBytes, sampleMinSeconds: AUDIO_LIMITS.sampleMinSeconds, sampleMaxSeconds: AUDIO_LIMITS.sampleMaxSeconds },
        brandPrefix: brandPrefix(userId),
        mediaLimits: { imageMaxBytes: ASSET_LIMITS.imageMaxBytes, videoMaxBytes: ASSET_LIMITS.videoMaxBytes, videoMaxSeconds: ASSET_LIMITS.videoMaxSeconds },
      });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (req.method === 'DELETE') {
      return res.status(200).json(await deleteAsset({ userId, assetId: String(first(query.id) ?? body.id ?? '') }));
    }
    return res.status(201).json({ asset: await registerAsset({ userId, kind: body.kind, url: body.url, name: body.name, inBrandKit: body.inBrandKit }) });
  } catch (err) {
    return sendError(res, err);
  }
}
