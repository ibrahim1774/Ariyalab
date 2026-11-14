import { authorizationServerMetadata } from '../../../lib/mcp/oauth.js';
import { methodNotAllowed } from '../../../lib/mcp/oauthHttp.js';

/*
 * RFC 8414 authorization server metadata. Served at
 * /.well-known/oauth-authorization-server (next.config.js rewrites).
 */
export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json(authorizationServerMetadata(req));
}
