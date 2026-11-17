import { getUserFromRequest } from '../supabaseServer.js';
import { sendError } from './errors.js';
import { getAction, getActionMethods } from './actions.js';
import { getProject } from './projects.js';
// Each import below registers that module's actions (lib/story/actions.js).
// A new step adds one import line here; the route files do not change.
import './projects.js'; // duplicate
import './script.js'; // script, revise, scene
import './cast.js'; // cast, cast-regen, cast-pick
import './storyboard.js'; // shots, stills, shot
import './audio.js'; // audio, narration, music
import './shots.js'; // quote, generate, reroll
import './quotePlan.js'; // quote-plan (the simple maker's "design my video" price)
import './analyze.js'; // analyze (GET the reference, POST start an analysis)
import './render.js'; // render
import './assets.js'; // assets (the pictures a video draws on)

/*
 * Serves one /api/story/projects/[id]/<action> request. Used by the
 * dispatcher (pages/api/story/projects/[id]/[action].js) and by the
 * dedicated route files that need their own config (script.js, revise.js).
 *
 * Order: no session -> 401; unknown action -> 404; known action with another
 * method -> 405 (Allow header); project missing or not the caller's -> 404;
 * then the handler, whose result is sent as JSON. Every thrown error goes
 * through sendError. Handlers still enforce ownership in their service calls;
 * the check here is a second line of defence.
 */

export async function handleAction(req, res, name) {
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });

  const methods = getActionMethods(String(name ?? ''));
  if (!methods.length) return res.status(404).json({ error: 'not_found', message: 'Unknown action.' });
  const action = getAction(String(name), req.method);
  if (!action) {
    res.setHeader('Allow', methods.join(', '));
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const userId = session.user.id;
  const projectId = String(req.query?.id ?? '');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  try {
    const project = await getProject({ userId, id: projectId });
    const result = await action.handler({ userId, user: session.user, projectId, project, body, req });
    return res.status(action.status).json(result ?? {});
  } catch (err) {
    return sendError(res, err);
  }
}
