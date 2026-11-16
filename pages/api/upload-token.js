import { handleUpload } from '@vercel/blob/client';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { storyDb } from '../../lib/story/db.js';
import { REFERENCE_LIMITS, VIDEO_EXTENSION, VIDEO_TYPES } from '../../lib/story/referenceRules.js';
import { AUDIO_LIMITS, audioExtension } from '../../lib/story/voiceRules.js';
import { ASSET_LIMITS, IMAGE_MIME, VIDEO_MIME, brandPrefix, imageExtension, videoExtension } from '../../lib/story/assetRules.js';

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
 * story-uploads/<projectId>/<name>.mp4 (or .mov), and the token allows video/mp4
 * and video/quicktime up to 100 MB only. No other surface may write under
 * story-uploads/. The analyze action then checks the size, the magic bytes and
 * the length again on the server, and only accepts uploads under that
 * project's prefix.
 *
 * Story audio (Task 24: a voice sample, the customer's own narration or music) sends clientPayload
 * {"surface":"story-audio"}: it needs a session, the pathname must be story-audio/<userId>/<name>.<mp3|wav|m4a>
 * (the caller's own folder), and the token allows those audio types up to 20 MB. POST /api/story/assets then checks
 * the stored file again (size, first bytes, length and codec) before it is used.
 *
 * Story pictures and clips (Task 23: a logo, product picture, mascot, screen recording or clip) send clientPayload
 * {"surface":"story-brand"}: it needs a session, the pathname must be story-brand/<userId>/<name>.<png|jpg|jpeg|webp|mp4|mov>
 * (the caller's own folder), and the token allows only the type of that extension: a picture up to 5 MB, a clip up to
 * 200 MB. POST /api/story/assets then checks the stored file again (size, first bytes, what it decodes as) before it is used.
 */

const ANON_SURFACE = 'anon-image';
const ANON_LIMITS = {
  allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  maximumSizeInBytes: 25 * 1024 * 1024,
};
const ANON_TOKEN_TTL_MS = 5 * 60 * 1000;
const STORY_SURFACE = 'story-reference';
const STORY_LIMITS = {
  allowedContentTypes: [...VIDEO_TYPES],
  maximumSizeInBytes: REFERENCE_LIMITS.maxBytes,
};
const STORY_TOKEN_TTL_MS = 15 * 60 * 1000;
const AUDIO_SURFACE = 'story-audio';
const AUDIO_UPLOAD_LIMITS = {
  allowedContentTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac'],
  maximumSizeInBytes: AUDIO_LIMITS.maxBytes,
};
const AUDIO_TOKEN_TTL_MS = 15 * 60 * 1000;
const BRAND_SURFACE = 'story-brand';
// The token allows exactly the type the extension promises (a .png may only be uploaded as image/png).
const BRAND_TYPES = { png: IMAGE_MIME.png, jpg: IMAGE_MIME.jpg, jpeg: IMAGE_MIME.jpeg, webp: IMAGE_MIME.webp, mp4: VIDEO_MIME.mp4, mov: VIDEO_MIME.mov };
const BRAND_TOKEN_TTL_MS = 15 * 60 * 1000;
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
  if (!name || name.includes('/') || name.includes('..') || !VIDEO_EXTENSION.test(name)) throw new Error('Upload not allowed.');
  const rows = await storyDb().select('story_projects', { id: projectId, user_id: userId }, { columns: ['id'], limit: 1 });
  if (!rows.length) throw new Error('Upload not allowed.');
}

/** Throws unless the pathname is story-audio/<userId>/<name>.<mp3|wav|m4a> for the signed-in user. */
function checkAudioUpload(userId, pathname) {
  const prefix = `story-audio/${userId}/`;
  const name = typeof pathname === 'string' && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  if (!name || name.includes('/') || name.includes('..') || !audioExtension(name)) throw new Error('Upload not allowed.');
}

/** -> the limits for story-brand/<userId>/<name>.<ext> of the signed-in user; throws for any other pathname. */
function checkBrandUpload(userId, pathname) {
  const prefix = brandPrefix(userId);
  const name = typeof pathname === 'string' && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  if (!name || name.includes('/') || name.includes('..')) throw new Error('Upload not allowed.');
  const image = imageExtension(name);
  if (image) return { allowedContentTypes: [BRAND_TYPES[image]], maximumSizeInBytes: ASSET_LIMITS.imageMaxBytes };
  const video = videoExtension(name);
  if (video) return { allowedContentTypes: [BRAND_TYPES[video]], maximumSizeInBytes: ASSET_LIMITS.videoMaxBytes };
  throw new Error('Upload not allowed.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let limits = null;
  let storyUser = null;
  let brandSurface = false;
  if (req.body?.type === 'blob.generate-client-token') {
    const session = await getUserFromRequest(req, res);
    const surface = surfaceFrom(req.body?.payload?.clientPayload);
    if (surface === STORY_SURFACE) {
      if (!session) return res.status(401).json({ error: 'Authentication required.' });
      limits = STORY_LIMITS;
      storyUser = session.user.id;
    } else if (surface === BRAND_SURFACE) {
      if (!session) return res.status(401).json({ error: 'Authentication required.' });
      limits = {}; // the limits come from the pathname's extension (checkBrandUpload), decided where the token is made
      brandSurface = true;
      storyUser = session.user.id;
    } else if (surface === AUDIO_SURFACE) {
      if (!session) return res.status(401).json({ error: 'Authentication required.' });
      limits = AUDIO_UPLOAD_LIMITS;
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
        if (brandSurface) {
          return { ...checkBrandUpload(storyUser, pathname), validUntil: Date.now() + BRAND_TOKEN_TTL_MS, addRandomSuffix: true };
        }
        if (limits === AUDIO_UPLOAD_LIMITS) {
          checkAudioUpload(storyUser, pathname);
          return { ...AUDIO_UPLOAD_LIMITS, validUntil: Date.now() + AUDIO_TOKEN_TTL_MS, addRandomSuffix: true };
        }
        // story-uploads/ belongs to story reference uploads (the analyze action trusts that prefix), story-audio/ to audio uploads,
        // story-brand/ to picture and clip uploads, story/ to files the runner stores (retention lists and deletes by it).
        // The pathname is also checked decoded once, so "story-uploads%2F..." cannot slip past. A name that is not
        // valid percent-encoding (a stray "%", as in "50% off.jpg") is an ordinary name: only its raw form is checked.
        if (typeof pathname !== 'string') throw new Error('Upload not allowed.');
        const forms = [pathname];
        try {
          forms.push(decodeURIComponent(pathname));
        } catch {
          // not encoded: the raw form is the name
        }
        if (forms.some((p) => /^(story|story-uploads|story-audio|story-brand)\//i.test(p.replace(/^\/+/, '')))) throw new Error('Upload not allowed.');
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
