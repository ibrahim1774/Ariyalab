import { handleMcpRequest } from '../../lib/mcp/server.js';

/*
 * /api/mcp: the Ariya Lab MCP connector (Streamable HTTP, stateless), signed in
 * through the OAuth server in lib/mcp/oauth.js. Customers paste APP_URL + /api/mcp
 * into Claude (docs/connector.md). Not in the middleware matcher.
 *
 * maxDuration 25: tools that start provider work (generate_cast,
 * generate_storyboard, generate_video, render, analyze_reference) take claims
 * and holds, so the request must be gone before the 30 s claim recovery
 * (lib/story/shots.js STALE_CLAIM_MS) can take a claim for a dead one.
 */

export const config = { api: { bodyParser: { sizeLimit: '64kb' }, externalResolver: true }, maxDuration: 25 };

export default function handler(req, res) {
  return handleMcpRequest(req, res);
}
