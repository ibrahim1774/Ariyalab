import { getUserFromRequest } from '../../../../lib/supabaseServer.js';
import { sendError } from '../../../../lib/story/errors.js';
import { confirmChat } from '../../../../lib/story/chat.js';

/*
 * POST /api/story/chat/confirm { projectId, confirmId }: presses a chat
 * confirm card (lib/story/chat.js confirmChat). The server runs the card it
 * stored, once, at the stored price -> the action's result + { confirmId }.
 * 409 confirm_used / confirm_outdated / quote_changed, 404 for an unknown
 * card, 402 for credits or plan.
 *
 * maxDuration 25: a confirm may start clips, and a clip claim older than
 * lib/story/shots.js STALE_CLAIM_MS (30 s) is taken over by recovery, so this
 * request must be gone before then. Model turns stay on /api/story/chat (120 s).
 */

export const config = { api: { bodyParser: { sizeLimit: '16kb' } }, maxDuration: 25 };

export default async function handler(req, res) {
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  try {
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    return res.status(200).json(await confirmChat({ userId: session.user.id, user: session.user, projectId, confirmId: body.confirmId }));
  } catch (err) {
    return sendError(res, err);
  }
}
