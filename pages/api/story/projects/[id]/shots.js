import { handleAction } from '../../../../../lib/story/actionRoute.js';

/*
 * /api/story/projects/[id]/shots: the 'shots' action (GET, POST) from
 * lib/story/actions.js, registered by lib/story/storyboard.js. It has its own
 * file only for the longer maxDuration: building the shot list asks the smart
 * model. This static route wins over [action].js, so the URL and the bodies
 * are the same.
 */

export const config = { api: { bodyParser: { sizeLimit: '64kb' } }, maxDuration: 120 };

export default function handler(req, res) {
  return handleAction(req, res, 'shots');
}
