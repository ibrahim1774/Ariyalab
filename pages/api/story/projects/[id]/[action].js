import { handleAction } from '../../../../../lib/story/actionRoute.js';

/*
 * /api/story/projects/[id]/[action]: every project step that has no route
 * file of its own. The action table is lib/story/actions.js; the request
 * handling (auth, 404/405, ownership, sendError) is lib/story/actionRoute.js.
 * Default maxDuration: steps served here must return quickly.
 */

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

export default function handler(req, res) {
  return handleAction(req, res, req.query?.action);
}
