import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { fetchPublic } from '../providers/http.js';
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
 * Verified clients: VERIFIED_CLIENTS below is the only source of a trusted
 * name on the consent page. Everything a client says about itself
 * (client_name, client_uri) is shown as an unverified claim.
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
export const CIMD_CACHE_MIN_SECONDS = 5 * 60;
export const CIMD_CACHE_MAX_SECONDS = 24 * 60 * 60;
export const CIMD_FAILURE_RETRY_SECONDS = 5 * 60;
/** A cached document whose refetch fails is served at most this long after the last good fetch. */
export const CIMD_MAX_STALE_SECONDS = 30 * 24 * 60 * 60;
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5000;

/**
 * Clients the consent page names by a trusted name. Values from Anthropic's
 * connector documentation, https://claude.com/docs/connectors/building/authentication.md
 * (verified 2026-11-14): the hosted Claude apps' callback URL, and the
 * Client ID Metadata Document Claude Code identifies itself with. A
 * redirectUri entry verifies any client whose authorization request uses
 * exactly that redirect URI (the code can only reach Anthropic). Loopback
 * redirects never verify a client, since any local program can claim one.
 */
export const VERIFIED_CLIENTS = Object.freeze([
  Object.freeze({ name: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback' }),
  Object.freeze({ name: 'Claude Code', clientId: 'https://claude.ai/oauth/claude-code-client-metadata' }),
]);

const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const CONTROL = /[\u0000-\u001f\u007f]/;
// Unicode format characters (bidi controls, zero-width joiners, BOM, ...),
// line/paragraph separators, and characters that render as nothing
// (Hangul fillers, Braille blank, combining grapheme joiner, Khmer and
// Mongolian invisible marks).
const FORMAT = /[\p{Cf}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180D\u2800\u3164\uFFA0]/gu;

/** Text with Unicode format characters removed (bidi overrides, zero-width characters). */
export const cleanDisplayText = (value) => String(value ?? '').replace(FORMAT, '');

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
  const name = cleanDisplayText(value).trim();
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

/** The first four hextets of an IPv6 address (its /64), or null. */
function ipv6Prefix64(ip) {
  const v6 = ip.toLowerCase().split('%')[0];
  if (isIP(v6) !== 6 || /\d+\.\d+\.\d+\.\d+$/.test(v6)) return null;
  const [head, tail] = v6.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const full = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return full.slice(0, 4).map((h) => parseInt(h, 16).toString(16)).join(':');
}

/**
 * The rate-limit key for an address: IPv4 as is (IPv4-mapped IPv6
 * unwrapped), IPv6 by its /64 (one customer's whole allocation).
 */
export function ipKey(ip) {
  const raw = String(ip || 'unknown').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  if (mapped) return mapped[1];
  const prefix = ipv6Prefix64(raw);
  return prefix ? `${prefix}::/64` : raw;
}

/** Hashed ipKey, as stored in rate-limit buckets. */
export const ipKeyHash = (ip) => createHash('sha256').update(`story_oauth_ip:${ipKey(ip)}`).digest('base64url');

/** Counts one use of `kind` for this address today; false at `limit`. */
export function takeRate(kind, ip, limit) {
  return storyDb().rpc('story_oauth_rate_take', { p_bucket: `${kind}:${ipKeyHash(ip)}`, p_limit: limit });
}

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
  // Validate first: a rejected request does not spend the quota.
  const { clientName, clientUri, redirectUris } = checkMetadata(meta);
  if (!(await takeRate('register', ip, REGISTRATIONS_PER_IP_PER_DAY))) {
    throw new OAuthClientError('rate_limited', 'Too many client registrations from this address today.', 429);
  }
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

/** One message for every metadata document failure (details only in server logs). */
export const CIMD_FAILURE_MESSAGE = "We could not load this app's details. Try connecting again later.";

function cimdFailure(detail, clientId, { withdrawn = false } = {}) {
  if (process.env.NODE_ENV !== 'test') console.warn('[oauth] client metadata document rejected', { clientId, detail });
  const err = new OAuthClientError('invalid_client', CIMD_FAILURE_MESSAGE);
  err.withdrawn = withdrawn;
  return err;
}

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

/** Cache lifetime from Cache-Control max-age, clamped to 5 minutes .. 24 hours. */
function cacheSeconds(cacheControl) {
  const m = /(?:^|[,\s])max-age\s*=\s*(\d+)/i.exec(String(cacheControl || ''));
  const asked = m ? Number(m[1]) : CIMD_CACHE_MAX_SECONDS;
  return Math.min(CIMD_CACHE_MAX_SECONDS, Math.max(CIMD_CACHE_MIN_SECONDS, asked));
}

/**
 * The one network seam: a GET of a public https URL through the shared
 * provider SSRF guard (lib/providers/http.js fetchPublic: every resolved
 * address must be public and the connection is pinned to the checked
 * address). Redirects are not followed (stopAt), so a 3xx is a failure.
 */
async function fetchDocument(url) {
  const { res } = await fetchPublic(url, {
    headers: { accept: 'application/json' },
    timeoutMs: CIMD_TIMEOUT_MS,
    stopAt: () => true,
  });
  if (!res || res.status !== 200) {
    await res?.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error(`status ${res?.status ?? 'redirect'}`), { status: res?.status ?? null });
  }
  return { text: await readCapped(res, CIMD_MAX_BYTES), cacheControl: res.headers.get('cache-control') };
}

/**
 * Fetches and validates a Client ID Metadata Document. Every failure throws
 * OAuthClientError('invalid_client', CIMD_FAILURE_MESSAGE).
 * -> { clientName, clientUri, redirectUris, maxAgeSeconds }
 */
export async function fetchClientMetadataDocument(clientId) {
  const problem = metadataUrlProblem(clientId);
  if (problem) throw cimdFailure(`client_id URL ${problem}`, clientId);
  let fetched;
  try {
    fetched = await fetchDocument(clientId);
  } catch (err) {
    throw cimdFailure(`fetch failed: ${err.message}`, clientId, { withdrawn: err.status === 404 || err.status === 410 });
  }
  let doc;
  try {
    doc = JSON.parse(fetched.text);
  } catch {
    throw cimdFailure('not JSON', clientId);
  }
  if (!doc || doc.client_id !== clientId) throw cimdFailure('client_id mismatch', clientId);
  if (doc.token_endpoint_auth_method !== 'none') throw cimdFailure('not a public client', clientId);
  let checked;
  try {
    checked = checkMetadata(doc);
  } catch (err) {
    throw cimdFailure(err.message, clientId);
  }
  return { ...checked, maxAgeSeconds: cacheSeconds(fetched.cacheControl) };
}

async function cacheMetadataClient(clientId, doc, existing) {
  const now = Date.now();
  const patch = {
    client_name: doc.clientName,
    client_uri: doc.clientUri,
    redirect_uris: doc.redirectUris,
    metadata_fetched_at: new Date(now).toISOString(),
    metadata_expires_at: new Date(now + doc.maxAgeSeconds * 1000).toISOString(),
    metadata_withdrawn_at: null,
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

async function recentFailure(clientId) {
  const [row] = await storyDb().select('story_oauth_cimd_failures', { client_id: clientId }, { limit: 1 });
  return Boolean(row && new Date(row.retry_after).getTime() > Date.now());
}

async function rememberFailure(clientId) {
  const retryAfter = new Date(Date.now() + CIMD_FAILURE_RETRY_SECONDS * 1000).toISOString();
  const updated = await storyDb().update('story_oauth_cimd_failures', { client_id: clientId }, { retry_after: retryAfter });
  if (updated.length === 0) {
    await storyDb().insert('story_oauth_cimd_failures', { client_id: clientId, retry_after: retryAfter }).catch(() => {});
  }
}

// Single-flight: concurrent loads of one client_id share one fetch (per process).
const inFlight = new Map();
function refetchOnce(clientId, row) {
  if (!inFlight.has(clientId)) {
    const p = (async () => cacheMetadataClient(clientId, await fetchClientMetadataDocument(clientId), row))();
    inFlight.set(clientId, p);
    p.finally(() => inFlight.delete(clientId)).catch(() => {});
  }
  return inFlight.get(clientId);
}

/**
 * The client row for client_id, or throws OAuthClientError.
 *
 * Metadata document clients:
 *   - cached, fresh and not withdrawn: the cached row;
 *   - stale: refetched when allowed, and the stale row is served if the
 *     refetch fails, for at most CIMD_MAX_STALE_SECONDS after the last good
 *     fetch; a 404 or 410 marks the client withdrawn (refused everywhere
 *     until a later fetch succeeds);
 *   - not cached: 'client_not_cached' unless allowFetch. A first-time fetch
 *     counts against the per-IP registration limit.
 * A failed fetch is remembered for CIMD_FAILURE_RETRY_SECONDS.
 * allowFetch: may fetch any client (signed-in consent page).
 * refetchKnown: may refetch an already-cached client only (token and
 * revocation endpoints): they never fetch an unknown URL.
 */
export async function loadClient(clientId, { allowFetch = false, refetchKnown = false, ip } = {}) {
  if (typeof clientId !== 'string' || clientId === '' || clientId.length > 300) {
    throw new OAuthClientError('invalid_client', 'Unknown client.');
  }
  const [row] = await storyDb().select('story_oauth_clients', { client_id: clientId }, { limit: 1 });
  if (!isMetadataDocumentClientId(clientId)) {
    if (!row || row.kind !== 'dynamic') throw new OAuthClientError('invalid_client', 'Unknown client.');
    return row;
  }
  if (row && row.kind !== 'metadata_document') throw new OAuthClientError('invalid_client', 'Unknown client.');
  const now = Date.now();
  const withdrawn = Boolean(row?.metadata_withdrawn_at);
  const fresh = row && !withdrawn && row.metadata_expires_at && new Date(row.metadata_expires_at).getTime() > now;
  if (fresh) return row;
  const staleOk = Boolean(row) && !withdrawn && row.metadata_fetched_at
    && now - new Date(row.metadata_fetched_at).getTime() < CIMD_MAX_STALE_SECONDS * 1000;
  const fallback = (err) => {
    if (staleOk) return row;
    throw err;
  };
  const canFetch = allowFetch || (refetchKnown && Boolean(row));
  if (!canFetch) {
    if (row) return fallback(cimdFailure(withdrawn ? 'withdrawn' : 'stale beyond limit', clientId));
    throw new OAuthClientError('client_not_cached', 'Sign in to connect this app.');
  }
  if (!row) {
    const problem = metadataUrlProblem(clientId);
    if (problem) throw cimdFailure(`client_id URL ${problem}`, clientId);
  }
  if (await recentFailure(clientId)) return fallback(cimdFailure('recent failure cached', clientId));
  if (!row && !(await takeRate('register', ip, REGISTRATIONS_PER_IP_PER_DAY))) {
    throw new OAuthClientError('invalid_client', 'Too many new apps were connected from this address today.');
  }
  try {
    return await refetchOnce(clientId, row);
  } catch (err) {
    if (!(err instanceof OAuthClientError)) throw err;
    await rememberFailure(clientId);
    if (err.withdrawn && row) {
      await storyDb().update('story_oauth_clients', { client_id: clientId }, { metadata_withdrawn_at: new Date().toISOString() });
      throw err;
    }
    return fallback(err);
  }
}

// ---------------------------------------------------------------- identity

const hostOf = (uri) => {
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
};

/**
 * What the consent page and the Connected apps list say about a client.
 * Hosts come from URL parsing (punycode for international names).
 *   verified    true only for VERIFIED_CLIENTS (never for loopback)
 *   headline    the verified name, else the redirect host
 *   clientName  the client's own name (format characters stripped), an
 *               unverified claim
 *   clientIdHost  the host of a metadata document client_id, else null
 *   clientUri   client_uri only when its host is the redirect host
 *   redirectHost, loopbackOnly
 * redirectUri: the one used in this request (consent page), or null to
 * judge the client by its registered redirect URIs (Connected apps).
 */
export function clientIdentity(client, redirectUri = null) {
  const uris = redirectUri ? [redirectUri] : client.redirect_uris || [];
  const verifiedEntry = VERIFIED_CLIENTS.find(
    (v) => (v.clientId && v.clientId === client.client_id) || (v.redirectUri && uris.length > 0 && uris.every((u) => u === v.redirectUri))
  );
  const redirectHost = hostOf(uris[0]) || '';
  const loopbackOnly = (client.redirect_uris || []).every((u) => {
    const parsed = parseUrl(u);
    return parsed ? isLoopbackHostname(parsed.hostname) : false;
  });
  const isLoopbackRedirect = (() => {
    const parsed = parseUrl(uris[0]);
    return parsed ? isLoopbackHostname(parsed.hostname) : false;
  })();
  const verified = Boolean(verifiedEntry) && (!isLoopbackRedirect || Boolean(verifiedEntry?.clientId));
  const clientIdHost = isMetadataDocumentClientId(client.client_id) ? hostOf(client.client_id) : null;
  const uriHost = client.client_uri ? hostOf(client.client_uri) : null;
  return {
    verified,
    headline: verified ? verifiedEntry.name : redirectHost || clientIdHost || '',
    clientName: cleanDisplayText(client.client_name).trim(),
    clientIdHost,
    clientUri: uriHost && uriHost === redirectHost ? client.client_uri : null,
    redirectHost,
    loopbackOnly,
  };
}
