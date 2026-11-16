import { handleAction } from '../../../../../lib/story/actionRoute.js';

/*
 * /api/story/projects/[id]/analyze: the 'analyze' action (lib/story/analyze.js).
 * It has its own file only for the longer maxDuration: starting an upload
 * analysis copies the file and probes its size, type and length before
 * anything is counted or queued. This static route wins over [action].js.
 */

export const config = { api: { bodyParser: { sizeLimit: '64kb' } }, maxDuration: 60 };

export default function handler(req, res) {
  return handleAction(req, res, 'analyze');
}
