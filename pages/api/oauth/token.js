import { OAuthError, errorBody, exchangeToken } from '../../../lib/mcp/oauth.js';
import { hasContentType, methodNotAllowed, noStore } from '../../../lib/mcp/oauthHttp.js';

/*
 * OAuth token endpoint. POST application/x-www-form-urlencoded:
 *   grant_type=authorization_code: code, code_verifier, redirect_uri, client_id, resource
 *   grant_type=refresh_token:      refresh_token, client_id, [resource], [scope]
 * 200 { access_token, token_type: 'Bearer', expires_in, refresh_token, scope }
 * 400/401 { error, error_description } with RFC 6749 error codes.
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
    return res.status(200).json(await exchangeToken(req.body, req));
  } catch (err) {
    if (err instanceof OAuthError) return res.status(err.status).json(errorBody(err));
    console.error('[oauth/token] unexpected error', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Something went wrong.' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
