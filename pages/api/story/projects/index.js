import { getUserFromRequest } from '../../../../lib/supabaseServer.js';
import { createProject, listProjects } from '../../../../lib/story/projects.js';
import { sendError } from '../../../../lib/story/errors.js';
import { linkBrandAssets, withBrandDefaults } from '../../../../lib/story/assets.js';

/*
 * GET  /api/story/projects -> 200 { projects }
 * POST /api/story/projects -> 201 { project }   body: the brief fields; the offer and audience start as the brand kit's
 *                                                 when the body has none, and the kit's pictures are attached
 */
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
      return res.status(200).json({ projects: await listProjects({ userId }) });
    }
    const input = await withBrandDefaults({ userId, input: req.body ?? {} });
    const project = await createProject({ userId, input, user: session.user });
    // The kit's pictures are a convenience: a failure here never loses the project the customer just made.
    await linkBrandAssets({ userId, projectId: project.id }).catch((err) => console.error('[story] could not attach the brand kit', project.id, err?.message));
    return res.status(201).json({ project });
  } catch (err) {
    return sendError(res, err);
  }
}
