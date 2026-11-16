import { handleAction } from '../../../../../lib/story/actionRoute.js';

/*
 * /api/story/projects/[id]/[action]: every project step that has no route
 * file of its own. The action table is lib/story/actions.js; the request
 * handling (auth, 404/405, ownership, sendError) is lib/story/actionRoute.js.
 * maxDuration 25: steps served here must return quickly.
 */

// maxDuration stays below lib/story/shots.js STALE_CLAIM_MS (30 s): a request is gone before its clip claim can be
// taken for a dead one.
export const config = { api: { bodyParser: { sizeLimit: '64kb' } }, maxDuration: 25 };

export default function handler(req, res) {
  return handleAction(req, res, req.query?.action);
}
