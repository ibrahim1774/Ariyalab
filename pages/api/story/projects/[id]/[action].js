import { getUserFromRequest } from '../../../../../lib/supabaseServer.js';
import { sendError } from '../../../../../lib/story/errors.js';
import { getAction, getActionMethods } from '../../../../../lib/story/actions.js';
// Each import below registers that module's actions (lib/story/actions.js).
// A new step adds one import line here; nothing else in this file changes.
import '../../../../../lib/story/projects.js'; // duplicate
import '../../../../../lib/story/script.js'; // script, revise, scene

/*
 * /api/story/projects/[id]/[action]: one route for every project step.
 * The action table lives in lib/story/actions.js. Unknown action -> 404,
 * known action with another method -> 405, no session -> 401, then the
 * handler's result is sent as JSON and every thrown error goes through
 * sendError.
 */

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
  // The script step calls the model synchronously, up to twice.
  maxDuration: 300,
};

export default async function handler(req, res) {
  const name = String(req.query?.action ?? '');
  const methods = getActionMethods(name);
  if (!methods.length) return res.status(404).json({ error: 'not_found', message: 'Unknown action.' });
  const action = getAction(name, req.method);
  if (!action) {
    res.setHeader('Allow', methods.join(', '));
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  try {
    const result = await action.handler({
      userId: session.user.id,
      user: session.user,
      projectId: String(req.query?.id ?? ''),
      body,
      req,
    });
    return res.status(action.status).json(result ?? {});
  } catch (err) {
    return sendError(res, err);
  }
}
