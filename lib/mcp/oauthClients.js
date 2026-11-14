import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { storyDb } from '../story/db.js';

/*
 * OAuth clients of the MCP connector's authorization server (lib/mcp/oauth.js).
 *
 * Two kinds, both public clients (no secret, PKCE required):
 *   - dynamic: registered through POST /api/oauth/register (RFC 7591).
 *     Capped at REGISTRATIONS_PER_IP_PER_DAY per client IP.
 *   - metadata_document: a Client ID Metadata Document client
 *     (draft-ietf-oauth-client-id-metadata-document-00, the MCP 2026-07-28
 *     preferred mechanism). client_id is an https URL; the document is
 *     fetched on first use, validated, and cached in story_oauth_clients
 *     for CIMD_CACHE_SECONDS. Claude and Claude Code use this when the
 *     server metadata advertises it.
 *
 * Redirect URI rules: https, or http on a loopback host (localhost,
 * 127.0.0.1, [::1]); no fragment, no userinfo, no wildcard, at most
 * MAX_REDIRECT_URI_LENGTH characters, at most MAX_REDIRECT_URIS per client.
 * Matching at authorize time is exact string match, except that a
 * registered loopback URI matches any port (RFC 8252 section 7.3; Claude
 * Code registers http://localhost/callback and uses an ephemeral port).
 */

export const MAX_CLIENT_NAME = 100;
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 300;
export const MAX_CLIENT_URI_LENGTH = 300;
export const REGISTRATIONS_PER_IP_PER_DAY = 20;
export const CIMD_CACHE_SECONDS = 24 * 60 * 60;
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5000;

const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const CONTROL = /[\u0000-\u001f\u007f]/;

/** RFC 7591 / RFC 6749 style error: { status, error, error_description }. */
export class OAuthClientError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.name = 'OAuthClientError';
    this.error = error;
    this.status = status;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopbackHostname = (hostname) => LOOPBACK_HOSTS.has(String(hostname).toLowerCase());

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Null when `uri` is an acceptable redirect URI, else the reason. */
export function redirectUriProblem(uri) {
  if (typeof uri !== 'string' || uri === '') return 'must be a non-empty string';
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return `must be at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  if (CONTROL.test(uri) || /[\s\\*]/.test(uri)) return 'contains a forbidden character';
  if (uri.includes('#')) return 'must not contain a fragment';
  const u = parseUrl(uri);
  if (!u) return 'is not an absolute URL';
  if (u.username || u.password) return 'must not contain credentials';
  if (u.protocol === 'https:' && u.hostname) return null;
  if (u.protocol === 'http:' && isLoopbackHostname(u.hostname)) return null;
  return 'must use https (http is allowed only on localhost or 127.0.0.1)';
}

/**
 * True when `presented` may be used with a client registered with `registered`.
 * Exact string match, or for a registered http loopback URI the same host,
 * path and query on any port.
 */
export function matchRedirectUri(registered, presented) {
  if (typeof presented !== 'string' || presented === '' || !Array.isArray(registered)) return false;
  if (redirectUriProblem(presented)) return false;
  if (registered.includes(presented)) return true;
  const p = parseUrl(presented);
  if (!p || p.protocol !== 'http:' || !isLoopbackHostname(p.hostname)) return false;
  return registered.some((r) => {
    const u = parseUrl(r);
    return (
      u &&
      u.protocol === 'http:' &&
      isLoopbackHostname(u.hostname) &&
      u.hostname === p.hostname &&
      u.pathname === p.pathname &&
      u.search === p.search
    );
  });
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name === '' || name.length > MAX_CLIENT_NAME || CONTROL.test(name)) return null;
  return name;
}

function cleanClientUri(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_CLIENT_URI_LENGTH || CONTROL.test(value)) return undefined;
  const u = parseUrl(value);
  if (!u || u.protocol !== 'https:' || u.username || u.password) return undefined;
  return value;
}

/** Validates client metadata shared by registration and metadata documents. */
function checkMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new OAuthClientError('invalid_client_metadata', 'Client metadata must be a JSON object.');
  }
  const clientName = cleanName(meta.client_name);
  if (!clientName) {
    throw new OAuthClientError(
      'invalid_client_metadata',
      `client_name is required and must be at most ${MAX_CLIENT_NAME} characters.`
    );
  }
  const clientUri = cleanClientUri(meta.client_uri);
  if (clientUri === undefined) {
    throw new OAuthClientError('invalid_client_metadata', 'client_uri must be an https URL of at most 300 characters.');
  }
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthClientError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthClientError('invalid_redirect_uri', `Redirect URI ${problem}.`);
  }
  if (meta.grant_types !== undefined) {
    const ok = Array.isArray(meta.grant_types)
      && meta.grant_types.includes('authorization_code')
      && meta.grant_types.every((g) => GRANT_TYPES.includes(g));
    if (!ok) throw new OAuthClientError('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token.');
  }
  if (meta.response_types !== undefined) {
    const ok = Array.isArray(meta.response_types) && meta.response_types.length > 0
      && meta.response_types.every((r) => r === 'code');
    if (!ok) throw new OAuthClientError('invalid_client_metadata', 'response_types may only be code.');
  }
  return { clientName, clientUri, redirectUris: [...new Set(uris)] };
}

// ---------------------------------------------------------------- registration

/** Client IP for rate limiting. Proxy headers are trusted only on Vercel. */
export function clientIp(req) {
  const headers = req?.headers || {};
  if (process.env.VERCEL) {
    const fwd = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
    const real = String(headers['x-real-ip'] || '').trim();
    if (fwd || real) return fwd || real;
  }
  return req?.socket?.remoteAddress || 'unknown';
}

const ipHash = (ip) => createHash('sha256').update(`story_oauth_ip:${ip}`).digest('base64url');

/** RFC 7591 response body for a stored client row. */
export function registrationResponse(row) {
  return {
    client_id: row.client_id,
    client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
    client_name: row.client_name,
    ...(row.client_uri ? { client_uri: row.client_uri } : {}),
    redirect_uris: row.redirect_uris,
    grant_types: GRANT_TYPES,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * Dynamic client registration. Always registers a public client
 * (token_endpoint_auth_method 'none'), whatever the request asked for
 * (RFC 7591 section 3.2.1 lets the server replace requested values).
 */
export async function registerClient(meta, { ip }) {
  const allowed = await storyDb().rpc('story_oauth_registration_take', {
    p_ip_hash: ipHash(ip || 'unknown'),
    p_limit: REGISTRATIONS_PER_IP_PER_DAY,
  });
  if (!allowed) {
    throw new OAuthClientError('rate_limited', 'Too many client registrations from this address today.', 429);
  }
  const { clientName, clientUri, redirectUris } = checkMetadata(meta);
  const [row] = await storyDb().insert('story_oauth_clients', {
    client_id: `mcp_${randomBytes(18).toString('base64url')}`,
    kind: 'dynamic',
    client_name: clientName,
    client_uri: clientUri,
    redirect_uris: redirectUris,
  });
  return row;
}

// ---------------------------------------------------------------- metadata documents

/** True when client_id has the Client ID Metadata Document form (https URL). */
export const isMetadataDocumentClientId = (clientId) =>
  typeof clientId === 'string' && clientId.startsWith('https://');

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

function metadataUrlProblem(clientId) {
  if (clientId.length > MAX_REDIRECT_URI_LENGTH) return 'is too long';
  if (CONTROL.test(clientId) || /[\s\\]/.test(clientId) || clientId.includes('#')) return 'is malformed';
  const u = parseUrl(clientId);
  if (!u || u.protocol !== 'https:') return 'must be an https URL';
  if (u.username || u.password || u.port) return 'must not carry credentials or a port';
  if (u.pathname === '/' || u.pathname === '') return 'must have a path';
  if (u.href !== clientId) return 'must be in normalized form';
  const host = u.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, ''))) return 'must use a host name, not an IP address';
  if (host === 'localhost' || !host.includes('.') || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'must use a public host name';
  }
  return null;
}

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(ip) {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind !== 6) return true;
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Private(mapped[1]);
  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('64:ff9b:')) return true;
  return false;
}

async function readCapped(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) throw new Error('no body');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetches and validates a Client ID Metadata Document. SSRF guards: https
 * only, default port, public host names that resolve only to public
 * addresses, no redirects, CIMD_TIMEOUT_MS timeout, CIMD_MAX_BYTES cap.
 * Residual risk: DNS rebinding between the lookup and fetch's own lookup.
 */
export async function fetchClientMetadataDocument(clientId) {
  const problem = metadataUrlProblem(clientId);
  if (problem) throw new OAuthClientError('invalid_client', `The client_id URL ${problem}.`);
  const { hostname } = new URL(clientId);
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new OAuthClientError('invalid_client', 'The client metadata host could not be resolved.');
  }
  if (!addresses?.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new OAuthClientError('invalid_client', 'The client metadata host is not a public address.');
  }
  let text;
  try {
    const res = await fetch(clientId, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    text = await readCapped(res, CIMD_MAX_BYTES);
  } catch {
    throw new OAuthClientError('invalid_client', 'The client metadata document could not be fetched.');
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new OAuthClientError('invalid_client', 'The client metadata document is not valid JSON.');
  }
  if (!doc || doc.client_id !== clientId) {
    throw new OAuthClientError('invalid_client', 'The client metadata document does not name this client_id.');
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    throw new OAuthClientError('invalid_client', 'Only public clients (token_endpoint_auth_method none) are supported.');
  }
  let checked;
  try {
    checked = checkMetadata(doc);
  } catch (err) {
    throw new OAuthClientError('invalid_client', err.message);
  }
  return checked;
}

async function cacheMetadataClient(clientId, { clientName, clientUri, redirectUris }, existing) {
  const patch = {
    client_name: clientName,
    client_uri: clientUri,
    redirect_uris: redirectUris,
    metadata_fetched_at: new Date().toISOString(),
  };
  if (existing) {
    const [row] = await storyDb().update('story_oauth_clients', { client_id: clientId }, patch);
    return row;
  }
  try {
    const [row] = await storyDb().insert('story_oauth_clients', { client_id: clientId, kind: 'metadata_document', ...patch });
    return row;
  } catch {
    // A concurrent first use inserted it; refresh that row instead.
    const [row] = await storyDb().update('story_oauth_clients', { client_id: clientId, kind: 'metadata_document' }, patch);
    if (!row) throw new OAuthClientError('invalid_client', 'Unknown client.');
    return row;
  }
}

/**
 * The client row for client_id, or throws OAuthClientError('invalid_client').
 * Metadata document clients are fetched when not cached or older than
 * CIMD_CACHE_SECONDS.
 */
export async function loadClient(clientId) {
  if (typeof clientId !== 'string' || clientId === '' || clientId.length > 300) {
    throw new OAuthClientError('invalid_client', 'Unknown client.');
  }
  const [row] = await storyDb().select('story_oauth_clients', { client_id: clientId }, { limit: 1 });
  if (!isMetadataDocumentClientId(clientId)) {
    if (!row || row.kind !== 'dynamic') throw new OAuthClientError('invalid_client', 'Unknown client.');
    return row;
  }
  if (row && row.kind !== 'metadata_document') throw new OAuthClientError('invalid_client', 'Unknown client.');
  const fresh = row?.metadata_fetched_at
    && Date.now() - new Date(row.metadata_fetched_at).getTime() < CIMD_CACHE_SECONDS * 1000;
  if (fresh) return row;
  const doc = await fetchClientMetadataDocument(clientId);
  return cacheMetadataClient(clientId, doc, row);
}
