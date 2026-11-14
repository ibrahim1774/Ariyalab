import { OAuthClientError, clientIp, registerClient, registrationResponse } from '../../../lib/mcp/oauthClients.js';
import { hasContentType, methodNotAllowed, noStore } from '../../../lib/mcp/oauthHttp.js';

/*
 * Dynamic client registration (RFC 7591). POST application/json:
 *   { client_name (<= 100 chars), redirect_uris (1 to 5, <= 300 chars,
 *     https or http loopback), [client_uri], [grant_types], [response_types] }
 * 201 with the registered public client. 400 { error, error_description }
 * (invalid_redirect_uri, invalid_client_metadata), 429 after 20
 * registrations from one IP in a day.
 */
export default async function handler(req, res) {
  noStore(res);
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  if (!hasContentType(req, 'application/json')) {
    return res.status(415).json({ error: 'invalid_request', error_description: 'Content-Type must be application/json.' });
  }
  try {
    const row = await registerClient(req.body, { ip: clientIp(req) });
    return res.status(201).json(registrationResponse(row));
  } catch (err) {
    if (err instanceof OAuthClientError) {
      return res.status(err.status).json({ error: err.error, error_description: err.message });
    }
    console.error('[oauth/register] unexpected error', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Something went wrong.' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
