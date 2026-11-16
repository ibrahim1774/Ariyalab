import { getUserFromRequest } from '../../../lib/supabaseServer.js';
import { sendError } from '../../../lib/story/errors.js';
import { listChat, sendChat } from '../../../lib/story/chat.js';

/*
 * /api/story/chat: the chat helper (lib/story/chat.js).
 *
 *   GET  ?projectId=<id>              -> { messages, usage: { used, limit } }
 *   POST { projectId, message }       -> { reply, confirms, tools, changed, usage, messages }
 *
 * 401 without a session; 405 (Allow) for other methods; 422 for a missing or
 * too long message; 404 for a project that is not the caller's; 400/503 when
 * moderation blocks the message; 429 chat_limit once the project's messages
 * are used up (the model is not called). Errors go through sendError.
 * maxDuration fits a tool loop of a few model turns (capped in chat.js).
 */

export const config = { api: { bodyParser: { sizeLimit: '16kb' } }, maxDuration: 120 };

export default async function handler(req, res) {
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const userId = session.user.id;
  try {
    if (req.method === 'GET') {
      const projectId = String(req.query?.projectId ?? '');
      return res.status(200).json(await listChat({ userId, user: session.user, projectId }));
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    return res.status(200).json(await sendChat({ userId, user: session.user, projectId, message: body.message }));
  } catch (err) {
    return sendError(res, err);
  }
}
