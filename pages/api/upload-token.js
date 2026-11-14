import { handleUpload } from '@vercel/blob/client';
import { getUserFromRequest } from '../../lib/supabaseServer';

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
 * clientPayload {"surface":"anon-image"} and get a small image-only
 * token. Upload-completed callbacks come from Vercel's servers (no
 * cookie) and are verified by handleUpload's own signature check.
 */

const ANON_SURFACE = 'anon-image';
const ANON_LIMITS = {
  allowedContentTypes: ['image/*'],
  maximumSizeInBytes: 25 * 1024 * 1024,
};
const SIGNED_IN_LIMITS = {
  allowedContentTypes: ['video/*', 'image/*'],
  maximumSizeInBytes: 1024 * 1024 * 1024,
};

function surfaceFrom(clientPayload) {
  if (typeof clientPayload !== 'string' || !clientPayload) return null;
  try {
    const parsed = JSON.parse(clientPayload);
    return typeof parsed?.surface === 'string' ? parsed.surface : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let limits = null;
  if (req.body?.type === 'blob.generate-client-token') {
    const session = await getUserFromRequest(req, res);
    if (session) {
      limits = SIGNED_IN_LIMITS;
    } else if (surfaceFrom(req.body?.payload?.clientPayload) === ANON_SURFACE) {
      limits = ANON_LIMITS;
    } else {
      return res.status(401).json({ error: 'Authentication required.' });
    }
  }

  try {
    const json = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async () => ({
        ...(limits || ANON_LIMITS),
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        // No-op for now. Could log the URL or schedule cleanup here.
      },
    });
    return res.status(200).json(json);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Upload token failed' });
  }
}
