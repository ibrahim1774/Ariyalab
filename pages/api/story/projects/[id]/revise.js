import { handleAction } from '../../../../../lib/story/actionRoute.js';

/*
 * /api/story/projects/[id]/revise: the 'revise' action from lib/story/actions.js
 * (registered by lib/story/script.js). It has its own file only for the
 * longer maxDuration: it calls the model, up to twice. This static route wins
 * over [action].js, so the URL and the bodies are the same as before.
 */

export const config = { api: { bodyParser: { sizeLimit: '64kb' } }, maxDuration: 120 };

export default function handler(req, res) {
  return handleAction(req, res, 'revise');
}
