import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { storyDb } from '../story/db.js';
import { oauthIssuer, OAuthTokenError, OAuthUnavailableError, verifyAccessToken } from './oauth.js';
import { MCP_TOOLS, runMcpTool } from './tools.js';

/*
 * The Sonallo MCP server behind /api/mcp (pages/api/mcp.js).
 *
 *   handleMcpRequest(req, res)   req.body is the JSON body Next already parsed
 *
 * Order: the bearer token first (lib/mcp/oauth.js verifyAccessToken, bound to
 * this resource): 401 with its WWW-Authenticate challenge (resource_metadata,
 * so Claude's connector can start OAuth), 503 when the account check is down
 * (never 401 then, so the client keeps its tokens). Then only POST is served
 * (405 Allow: POST for GET and DELETE: stateless, no SSE stream, no session).
 * Each request gets a fresh Server and Streamable HTTP transport with no
 * session id and plain JSON answers; nothing is kept between requests. The
 * user id comes only from the token.
 *
 * Before the transport: at most MCP_REQUESTS_PER_MINUTE requests per user per
 * minute (429 with Retry-After), a JSON-RPC batch is 400 (batching left the
 * protocol in 2025-06-18; one message per request), and a tools/call whose
 * params are not { name: string, arguments?: object } is answered as a tool
 * error (validation_failed) instead of the SDK's schema dump.
 */

const DEFAULT_REQUESTS_PER_MINUTE = 60;
let requestsPerMinute = null;

/** Tests set the per-user limit; null goes back to MCP_REQUESTS_PER_MINUTE (env) or 60. */
export function _setMcpRateLimit(n) {
  requestsPerMinute = n;
}

function rateLimit() {
  if (Number.isInteger(requestsPerMinute) && requestsPerMinute > 0) return requestsPerMinute;
  const env = Number.parseInt(process.env.MCP_REQUESTS_PER_MINUTE || '', 10);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_REQUESTS_PER_MINUTE;
}

/** Counts one request for this user in the current minute (story_oauth_rate_take). -> true when allowed. */
async function takeRequest(userId) {
  const minute = new Date().toISOString().slice(0, 16);
  return storyDb().rpc('story_oauth_rate_take', { p_bucket: `mcp:${userId}:${minute}`, p_limit: rateLimit() });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A tools/call whose params the SDK would refuse with a schema error: answered as a readable tool error. */
function malformedToolCall(body) {
  if (!isPlainObject(body) || body.method !== 'tools/call') return null;
  const params = body.params;
  const ok = isPlainObject(params) && typeof params.name === 'string' && (params.arguments === undefined || isPlainObject(params.arguments));
  if (ok) return null;
  return {
    jsonrpc: '2.0',
    id: body.id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ error: 'validation_failed', message: 'A tool call needs a tool name and its arguments as an object.' }) }],
      isError: true,
    },
  };
}

export const SERVER_INFO = Object.freeze({ name: 'ariya-lab', title: 'Sonallo story videos', version: '1.0.0' });

export const SERVER_INSTRUCTIONS = [
  'Sonallo makes short animated story videos. The usual order is: create_project, (analyze_reference), write_script,',
  'set_script as needed, generate_cast (twice: draft the characters, then price and start; each character gets one picture, picked by itself),',
  'generate_storyboard (twice: plan, then pictures), make_audio, get_quote, generate_video, render, get_result.',
  'Script writing, character writing and shot planning are drafted in the background: poll get_status and watch drafts.',
  'Work that takes time runs in the background: the tool answers at once with a status_text, then poll get_status every 10 to 20 seconds.',
  'Money: never pass confirm_total until the customer has seen that exact price and agreed to it. A call without it returns the quote and spends nothing.',
].join(' ');

/** A Server for one request, answering for one user. */
export function createMcpServer({ userId, baseUrl }) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const { isError, data } = await runMcpTool({ userId, baseUrl, name, args: args ?? {} });
    return { content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
  });
  return server;
}

function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function handleMcpRequest(req, res) {
  let auth;
  try {
    auth = await verifyAccessToken(req);
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      return sendJson(res, 401, { error: err.error, error_description: err.message }, { 'WWW-Authenticate': err.wwwAuthenticate });
    }
    if (err instanceof OAuthUnavailableError) {
      return sendJson(res, 503, { error: err.error, error_description: err.message }, { 'Retry-After': '5' });
    }
    console.error('[mcp] token check failed', err?.message || err);
    return sendJson(res, 500, { error: 'server_error', error_description: 'Something went wrong. Please try again.' });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
  }

  let allowed;
  try {
    allowed = await takeRequest(auth.userId);
  } catch (err) {
    console.error('[mcp] rate check failed', err?.message || err);
    return sendJson(res, 503, { error: 'temporarily_unavailable', error_description: 'Try again shortly.' }, { 'Retry-After': '5' });
  }
  if (!allowed) {
    const retry = 60 - new Date().getUTCSeconds();
    return sendJson(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: `Too many requests. Try again in ${retry} seconds.` }, id: null }, { 'Retry-After': String(retry) });
  }
  if (Array.isArray(req.body)) {
    return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Send one JSON-RPC message per request; batches are not supported.' }, id: null });
  }
  const malformed = malformedToolCall(req.body);
  if (malformed) return sendJson(res, 200, malformed);

  const server = createMcpServer({ userId: auth.userId, baseUrl: oauthIssuer(req) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed', err?.message || err);
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
}
