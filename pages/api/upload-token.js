import { handleUpload } from '@vercel/blob/client';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { storyDb } from '../../lib/story/db.js';
import { REFERENCE_LIMITS } from '../../lib/story/referenceRules.js';

/*
 * Issues short-lived client upload tokens for @vercel/blob/client.
 *
 * The browser hits this route to authenticate, then PUTs the file
 * directly to *.blob.vercel-storage.com — bypassing Vercel's 4.5 MB
 * serverless body limit. Requires BLOB_READ_WRITE_TOKEN to be set in
 * the project env vars (auto-added when you create a Blob store in
 * the Vercel dashboard).
 *
 * Token requests need a session, with one exception: the pre-paywall
 * pages (/, /ugc-2, /ugc-3, /local-business, /real-estate) let
 * signed-out visitors upload a photo before sign-up. They send
 * clientPayload {"surface":"anon-image"} and get a 5-minute, 25 MB
 * token for JPEG/PNG/WebP/HEIC only. Upload-completed callbacks come
 * from Vercel's servers (no cookie) and are verified by handleUpload's
 * own signature check.
 *
 * Story reference videos (Task 22) send clientPayload
 * {"surface":"story-reference","projectId":"<id>"}: they need a session,
 * the project must be the caller's, the pathname must be
 * story-uploads/<projectId>/<name>.mp4, and the token allows video/mp4 up to
 * 100 MB only. The analyze action then checks the size, the magic bytes and
 * the length again on the server, and only accepts uploads under that
 * project's prefix.
 */

const ANON_SURFACE = 'anon-image';
const ANON_LIMITS = {
  allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  maximumSizeInBytes: 25 * 1024 * 1024,
};
const ANON_TOKEN_TTL_MS = 5 * 60 * 1000;
const STORY_SURFACE = 'story-reference';
const STORY_LIMITS = {
  allowedContentTypes: ['video/mp4'],
  maximumSizeInBytes: REFERENCE_LIMITS.maxBytes,
};
const STORY_TOKEN_TTL_MS = 15 * 60 * 1000;
const SIGNED_IN_LIMITS = {
  allowedContentTypes: ['video/*', 'image/*'],
  maximumSizeInBytes: 1024 * 1024 * 1024,
};

function payloadFrom(clientPayload) {
  if (typeof clientPayload !== 'string' || !clientPayload) return {};
  try {
    const parsed = JSON.parse(clientPayload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function surfaceFrom(clientPayload) {
  const surface = payloadFrom(clientPayload).surface;
  return typeof surface === 'string' ? surface : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless the pathname is story-uploads/<projectId>/<name>.mp4 for a project the user owns. */
async function checkStoryUpload(userId, pathname, clientPayload) {
  const projectId = payloadFrom(clientPayload).projectId;
  if (typeof projectId !== 'string' || !UUID.test(projectId)) throw new Error('Upload not allowed.');
  const prefix = `story-uploads/${projectId}/`;
  const name = typeof pathname === 'string' && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  if (!name || name.includes('/') || name.includes('..') || !/\.mp4$/i.test(name)) throw new Error('Upload not allowed.');
  const rows = await storyDb().select('story_projects', { id: projectId, user_id: userId }, { columns: ['id'], limit: 1 });
  if (!rows.length) throw new Error('Upload not allowed.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let limits = null;
  let storyUser = null;
  if (req.body?.type === 'blob.generate-client-token') {
    const session = await getUserFromRequest(req, res);
    const surface = surfaceFrom(req.body?.payload?.clientPayload);
    if (surface === STORY_SURFACE) {
      if (!session) return res.status(401).json({ error: 'Authentication required.' });
      limits = STORY_LIMITS;
      storyUser = session.user.id;
    } else if (session) {
      limits = SIGNED_IN_LIMITS;
    } else if (surface === ANON_SURFACE) {
      limits = ANON_LIMITS;
    } else {
      return res.status(401).json({ error: 'Authentication required.' });
    }
  }

  try {
    const json = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (limits === STORY_LIMITS) {
          await checkStoryUpload(storyUser, pathname, clientPayload);
          return { ...STORY_LIMITS, validUntil: Date.now() + STORY_TOKEN_TTL_MS, addRandomSuffix: true };
        }
        return {
          ...(limits || ANON_LIMITS),
          ...(limits === SIGNED_IN_LIMITS ? {} : { validUntil: Date.now() + ANON_TOKEN_TTL_MS }),
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // No-op for now. Could log the URL or schedule cleanup here.
      },
    });
    return res.status(200).json(json);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Upload token failed' });
  }
}
