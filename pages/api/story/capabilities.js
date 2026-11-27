import { getUserFromRequest } from '../../../lib/supabaseServer.js';
import { storyCapabilities } from '../../../lib/providers/capabilities.js';

/*
 * GET /api/story/capabilities -> { linkDownload, transcription }
 * Which "Start from a video" options this deployment can serve. Booleans only; no keys or provider names.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.status(200).json(storyCapabilities());
}
