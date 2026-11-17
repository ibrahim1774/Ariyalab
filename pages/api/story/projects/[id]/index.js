import { getUserFromRequest } from '../../../../../lib/supabaseServer.js';
import { deleteProject, getProject, updateProject } from '../../../../../lib/story/projects.js';
import { sendError } from '../../../../../lib/story/errors.js';

/*
 * GET    /api/story/projects/[id] -> 200 { project }
 * PATCH  /api/story/projects/[id] -> 200 { project }   body: any of title, purpose, offer,
 *                                                      audience, style, style_custom, seconds,
 *                                                      aspect, quality, mode
 * DELETE /api/story/projects/[id] -> 200 { deleted: true }
 */
export default async function handler(req, res) {
  if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PATCH, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  const userId = session.user.id;
  const id = String(req.query?.id ?? '');

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ project: await getProject({ userId, id }) });
    }
    if (req.method === 'PATCH') {
      // expected_credits: the redo total shown for a style change that remakes things already made (409 quote_changed without it).
      const { expected_credits: expectedCredits, ...patch } = req.body ?? {};
      return res.status(200).json({ project: await updateProject({ userId, id, patch, expectedCredits }) });
    }
    await deleteProject({ userId, id });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, err);
  }
}
