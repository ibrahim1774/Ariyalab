import { handleAction } from '../../../../../lib/story/actionRoute.js';

/*
 * /api/story/projects/[id]/cast: the 'cast' action (GET, POST) from
 * lib/story/actions.js, registered by lib/story/cast.js. It has its own file
 * only for the longer maxDuration: starting the cast asks the model for the
 * characters before it queues their pictures. This static route wins over
 * [action].js, so the URL and the bodies are the same.
 */

export const config = { api: { bodyParser: { sizeLimit: '64kb' } }, maxDuration: 60 };

export default function handler(req, res) {
  return handleAction(req, res, 'cast');
}
