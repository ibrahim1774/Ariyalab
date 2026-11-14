import { protectedResourceMetadata } from '../../../lib/mcp/oauth.js';
import { methodNotAllowed } from '../../../lib/mcp/oauthHttp.js';

/*
 * RFC 9728 protected resource metadata for the MCP endpoint. Served at
 * /.well-known/oauth-protected-resource and
 * /.well-known/oauth-protected-resource/api/mcp (next.config.js rewrites).
 */
export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json(protectedResourceMetadata(req));
}
