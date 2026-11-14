import { OAuthError, errorBody, revokeToken } from '../../../lib/mcp/oauth.js';
import { hasContentType, methodNotAllowed, noStore } from '../../../lib/mcp/oauthHttp.js';

/*
 * OAuth token revocation (RFC 7009). POST application/x-www-form-urlencoded:
 *   token, client_id, [token_type_hint=access_token|refresh_token]
 * Revokes the whole grant (token family) the token belongs to, when it was
 * issued to client_id. 200 {} also for unknown tokens (RFC 7009 2.2).
 * 400 invalid_request, 401 invalid_client, 429, 415, 405.
 */
export default async function handler(req, res) {
  noStore(res);
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  if (!hasContentType(req, 'application/x-www-form-urlencoded')) {
    return res.status(415).json({
      error: 'invalid_request',
      error_description: 'Content-Type must be application/x-www-form-urlencoded.',
    });
  }
  try {
    await revokeToken(req.body, req);
    return res.status(200).json({});
  } catch (err) {
    if (err instanceof OAuthError) return res.status(err.status).json(errorBody(err));
    console.error('[oauth/revoke] unexpected error', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Something went wrong.' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
