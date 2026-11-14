import { disconnectClient, listConnections, oauthIssuer } from '../../../lib/mcp/oauth.js';
import { hasContentType, methodNotAllowed } from '../../../lib/mcp/oauthHttp.js';
import { getUserFromRequest } from '../../../lib/supabaseServer.js';

/*
 * The signed-in user's connected apps (MCP connector grants).
 * GET  -> { connections: [{ clientId, headline, verified, clientName,
 *          clientIdHost, redirectHost, connectedAt, lastActiveAt }] }
 * POST application/json { client_id } -> { ok: true }: revokes every grant
 *          this user gave that client (same origin only).
 * Session auth (this path is outside the middleware matcher); a user only
 * ever sees and revokes their own grants.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const auth = await getUserFromRequest(req, res);
  if (!auth?.user) return res.status(401).json({ error: 'unauthorized', message: 'Sign in to see your connected apps.' });
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ connections: await listConnections(auth.user.id) });
    }
    if (!hasContentType(req, 'application/json')) {
      return res.status(415).json({ error: 'invalid_request', message: 'Send JSON.' });
    }
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if ((origin && origin !== new URL(oauthIssuer(req)).origin) || (fetchSite && fetchSite !== 'same-origin')) {
      return res.status(403).json({ error: 'forbidden', message: 'Cross-site request refused.' });
    }
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
    if (!clientId) return res.status(422).json({ error: 'validation_failed', message: 'client_id is required.' });
    await disconnectClient(auth.user.id, clientId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[oauth/connections] unexpected error', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
