import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { storyDb } from '../story/db.js';
import { OAuthClientError, isLoopbackHostname, loadClient, matchRedirectUri } from './oauthClients.js';

/*
 * OAuth 2.1 authorization server for the MCP connector (spec 7.7). Built
 * against the MCP authorization spec revision 2026-07-28, RFC 8414, RFC
 * 9728, RFC 7591, RFC 8707, RFC 7636 and RFC 9207; see the Task 25 report
 * for the endpoint reference.
 *
 * Flow: GET /api/oauth/authorize forwards to /oauth/consent, whose
 * getServerSideProps validates the request (validateAuthorizeRequest),
 * requires the Supabase session and stores a consent request bound to the
 * user (createConsentRequest). The page posts Allow/Deny back to
 * POST /api/oauth/authorize (decideConsent), which redirects to the
 * client with a code. POST /api/oauth/token exchanges it (exchangeToken).
 * The MCP endpoint calls verifyAccessToken.
 *
 * Every secret (consent request token, code, access token, refresh token)
 * is 32 random bytes, base64url, and only its SHA-256 is stored.
 */

export const SCOPE = 'story';
export const SCOPE_DESCRIPTION = 'Create and manage your Ariya Lab story videos and spend your credits';
export const CODE_TTL_SECONDS = 60;
export const CONSENT_TTL_SECONDS = 10 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_PATH = '/api/mcp';
const MAX_STATE_LENGTH = 1024;

// ---------------------------------------------------------------- errors

/**
 * An RFC 6749 error. `redirect` set: send the browser there (the client's
 * validated redirect_uri). Otherwise answer with `status` and
 * { error, error_description } (JSON endpoints) or an error page.
 */
export class OAuthError extends Error {
  constructor(error, description, { status = 400, redirect = null } = {}) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
    this.redirect = redirect;
  }
}

/**
 * Thrown by verifyAccessToken. status 401; wwwAuthenticate is the
 * WWW-Authenticate header value the MCP route must send.
 */
export class OAuthTokenError extends Error {
  constructor(message, wwwAuthenticate) {
    super(message);
    this.name = 'OAuthTokenError';
    this.status = 401;
    this.error = 'invalid_token';
    this.wwwAuthenticate = wwwAuthenticate;
    this.headers = { 'WWW-Authenticate': wwwAuthenticate };
  }
}

/** Body for a JSON error response. */
export const errorBody = (err) => ({ error: err.error, error_description: err.message });

// ---------------------------------------------------------------- urls

const first = (v) => (Array.isArray(v) ? v[0] : v);
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/**
 * The issuer (this app's base URL, no trailing slash). APP_URL when set;
 * otherwise the request host: X-Forwarded-Host on Vercel, else Host.
 * https, except http for a loopback host off Vercel (local dev).
 */
export function oauthIssuer(req) {
  const fromEnv = String(process.env.APP_URL || '').trim();
  if (fromEnv) {
    const u = new URL(fromEnv);
    return u.origin;
  }
  const headers = req?.headers || {};
  const onVercel = Boolean(process.env.VERCEL);
  const raw = (onVercel && first(headers['x-forwarded-host'])) || first(headers.host) || '';
  const host = String(raw).split(',')[0].trim().toLowerCase();
  if (!HOST.test(host)) throw new Error('oauth: cannot determine the issuer host');
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  const proto = !onVercel && isLoopbackHostname(hostname) ? 'http' : 'https';
  return `${proto}://${host}`;
}

/** The canonical resource identifier (RFC 8707) of this app's MCP endpoint. */
export const mcpResource = (req) => `${oauthIssuer(req)}${MCP_PATH}`;

/** The RFC 9728 metadata URL for the MCP endpoint (path-suffixed form). */
export const resourceMetadataUrl = (req) => `${oauthIssuer(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(req) {
  const issuer = oauthIssuer(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/`,
  };
}

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(req) {
  return {
    resource: mcpResource(req),
    authorization_servers: [oauthIssuer(req)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Ariya Lab',
  };
}

/**
 * The resource parameter in canonical form, or null when it is not a valid
 * absolute URI without a fragment. Lowercases scheme and host (URL does)
 * and drops a trailing slash.
 */
function canonicalResource(value) {
  if (typeof value !== 'string' || value === '' || value.includes('#')) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

// ---------------------------------------------------------------- secrets

export const newSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = (value) => createHash('sha256').update(String(value)).digest('base64url');

/** Constant-time string equality (false for different lengths). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const s256 = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url');
const isoIn = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const isPast = (iso) => new Date(iso).getTime() <= Date.now();

// ---------------------------------------------------------------- authorize

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  return u.toString();
}

/** The client's redirect URI carrying an RFC 6749 error, state and iss. */
function errorRedirect(req, redirectUri, state, error, description) {
  return withParams(redirectUri, {
    error,
    error_description: description,
    state,
    iss: oauthIssuer(req),
  });
}

/** Parameters the consent page forwards to sign-in and back. */
export const AUTHORIZE_PARAMS = Object.freeze([
  'response_type', 'client_id', 'redirect_uri', 'scope', 'state',
  'code_challenge', 'code_challenge_method', 'resource',
]);

/** The consent page path for an authorization request (only known params). */
export function consentPath(query) {
  const qs = new URLSearchParams();
  for (const k of AUTHORIZE_PARAMS) {
    const v = first(query?.[k]);
    if (typeof v === 'string') qs.set(k, v);
  }
  return `/oauth/consent?${qs.toString()}`;
}

/**
 * Validates an authorization request (query of GET /api/oauth/authorize).
 * Throws OAuthError: without `redirect` when client_id or redirect_uri is
 * not valid (show an error page, never redirect), with `redirect` for every
 * later problem. Returns { client, params } with params ready for
 * createConsentRequest.
 */
export async function validateAuthorizeRequest(query, req) {
  const q = query || {};
  for (const k of AUTHORIZE_PARAMS) {
    if (Array.isArray(q[k])) {
      if (k === 'client_id' || k === 'redirect_uri') {
        throw new OAuthError('invalid_request', `The ${k} parameter is repeated.`);
      }
    }
  }
  let client;
  try {
    client = await loadClient(first(q.client_id));
  } catch (err) {
    if (err instanceof OAuthClientError) throw new OAuthError('invalid_client', err.message);
    throw err;
  }
  const redirectUri = first(q.redirect_uri);
  if (!matchRedirectUri(client.redirect_uris, redirectUri)) {
    throw new OAuthError('invalid_request', 'The redirect_uri is not registered for this client.');
  }

  const state = typeof q.state === 'string' ? q.state : undefined;
  const fail = (error, description) => {
    throw new OAuthError(error, description, { redirect: errorRedirect(req, redirectUri, state, error, description) });
  };
  for (const k of AUTHORIZE_PARAMS) {
    if (Array.isArray(q[k])) fail('invalid_request', `The ${k} parameter is repeated.`);
  }
  if (state !== undefined && state.length > MAX_STATE_LENGTH) fail('invalid_request', 'The state parameter is too long.');
  if (q.response_type !== 'code') fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (q.code_challenge_method !== 'S256') fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
    fail('invalid_request', 'A valid S256 code_challenge is required.');
  }
  const scope = grantedScope(q.scope);
  if (!scope) fail('invalid_scope', `The only scope is ${SCOPE}.`);
  const resource = canonicalResource(q.resource);
  if (!resource) fail('invalid_target', `The resource parameter is required: ${mcpResource(req)}.`);
  if (resource !== mcpResource(req)) fail('invalid_target', `Tokens are only issued for ${mcpResource(req)}.`);

  return {
    client,
    params: {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge,
      scope,
      resource,
      state: state ?? null,
    },
  };
}

/**
 * The scope to grant for a requested scope string, or null if it names an
 * unknown scope. Absent means `story`; offline_access is accepted and
 * ignored (a refresh token is always issued).
 */
function grantedScope(raw) {
  if (raw === undefined || raw === null || raw === '') return SCOPE;
  if (typeof raw !== 'string') return null;
  const parts = raw.split(' ').filter(Boolean);
  if (parts.length === 0) return SCOPE;
  return parts.every((s) => s === SCOPE || s === 'offline_access') ? SCOPE : null;
}

/** What the consent page shows about the request. Plain values only. */
export function consentDetails(client, params) {
  const host = new URL(params.redirect_uri).host;
  const loopbackOnly = client.redirect_uris.every((u) => {
    try {
      return isLoopbackHostname(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  return {
    clientName: client.client_name,
    clientUri: client.client_uri || null,
    redirectHost: host,
    loopbackOnly,
    access: SCOPE_DESCRIPTION,
  };
}

/**
 * Stores a validated request for the signed-in user. Returns the
 * single-use request token the consent form posts back (CSRF guard: only
 * this user's page has it, and it works only with this user's session).
 */
export async function createConsentRequest(params, userId) {
  const token = newSecret();
  await storyDb().insert('story_oauth_requests', {
    token_hash: hashSecret(token),
    user_id: userId,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    resource: params.resource,
    state: params.state ?? null,
    expires_at: isoIn(CONSENT_TTL_SECONDS),
  });
  return token;
}

const STALE_REQUEST = 'This sign-in request has expired or was already used. Start the connection again from Claude.';

/**
 * Applies the user's Allow or Deny. Consumes the request (single use) and
 * returns the redirect URL: with a code on allow, error=access_denied on
 * deny. Throws OAuthError (no redirect) for a missing, expired, used or
 * foreign request token.
 */
export async function decideConsent({ token, userId, decision }, req) {
  if (typeof token !== 'string' || token === '' || !userId) throw new OAuthError('invalid_request', STALE_REQUEST);
  const hash = hashSecret(token);
  const [row] = await storyDb().select('story_oauth_requests', { token_hash: hash }, { limit: 1 });
  if (!row || !safeEqual(row.token_hash, hash) || row.user_id !== userId || row.used_at || isPast(row.expires_at)) {
    throw new OAuthError('invalid_request', STALE_REQUEST);
  }
  const used = await storyDb().update(
    'story_oauth_requests',
    { id: row.id, used_at: null },
    { used_at: new Date().toISOString() }
  );
  if (used.length !== 1) throw new OAuthError('invalid_request', STALE_REQUEST);

  const iss = oauthIssuer(req);
  if (decision !== 'allow') {
    return withParams(row.redirect_uri, {
      error: 'access_denied',
      error_description: 'The user denied access.',
      state: row.state,
      iss,
    });
  }
  const code = newSecret();
  await storyDb().insert('story_oauth_codes', {
    code_hash: hashSecret(code),
    client_id: row.client_id,
    user_id: row.user_id,
    redirect_uri: row.redirect_uri,
    code_challenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
    expires_at: isoIn(CODE_TTL_SECONDS),
  });
  return withParams(row.redirect_uri, { code, state: row.state, iss });
}

// ---------------------------------------------------------------- token

const grantError = (description) => new OAuthError('invalid_grant', description);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

function tokenResponse(accessToken, refreshToken, scope) {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

async function requireClient(clientId) {
  if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
  try {
    return await loadClient(clientId);
  } catch (err) {
    if (err instanceof OAuthClientError) throw new OAuthError('invalid_client', 'Unknown client.', { status: 401 });
    throw err;
  }
}

function checkTokenScope(raw) {
  if (raw !== undefined && raw !== null && raw !== '' && !grantedScope(raw)) {
    throw new OAuthError('invalid_scope', `The only scope is ${SCOPE}.`);
  }
}

async function redeemCode(body, req) {
  const code = str(body.code);
  const verifier = str(body.code_verifier);
  const redirectUri = str(body.redirect_uri);
  const clientId = str(body.client_id);
  if (!code || !verifier || !redirectUri || !clientId) {
    throw new OAuthError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required.');
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_request', 'Malformed code_verifier.');
  const resource = canonicalResource(body.resource);
  if (!resource) throw new OAuthError('invalid_target', `The resource parameter is required: ${mcpResource(req)}.`);
  checkTokenScope(body.scope);
  await requireClient(clientId);

  // Burns the code; a replay revokes what the first redemption issued.
  const [row] = await storyDb().rpc('story_oauth_take_code', { p_code_hash: hashSecret(code) });
  if (!row) throw grantError('Unknown authorization code.');
  if (row.reused) throw grantError('The authorization code was already used.');
  if (isPast(row.expires_at)) throw grantError('The authorization code has expired.');
  if (!safeEqual(row.client_id, clientId)) throw grantError('The authorization code was issued to another client.');
  if (!safeEqual(row.redirect_uri, redirectUri)) throw grantError('redirect_uri does not match the authorization request.');
  if (resource !== row.resource || resource !== mcpResource(req)) {
    throw new OAuthError('invalid_target', 'resource does not match the authorization request.');
  }
  if (!safeEqual(s256(verifier), row.code_challenge)) throw grantError('code_verifier does not match the code_challenge.');

  const accessToken = newSecret();
  const refreshToken = newSecret();
  try {
    await storyDb().rpc('story_oauth_issue_code_tokens', {
      p_code_id: row.id,
      p_access_hash: hashSecret(accessToken),
      p_access_expires: isoIn(ACCESS_TOKEN_TTL_SECONDS),
      p_refresh_hash: hashSecret(refreshToken),
      p_refresh_expires: isoIn(REFRESH_TOKEN_TTL_SECONDS),
    });
  } catch (err) {
    if (/code_revoked/.test(err.message)) throw grantError('The authorization code was already used.');
    throw err;
  }
  return tokenResponse(accessToken, refreshToken, row.scope);
}

async function rotateRefresh(body, req) {
  const refresh = str(body.refresh_token);
  const clientId = str(body.client_id);
  if (!refresh || !clientId) throw new OAuthError('invalid_request', 'refresh_token and client_id are required.');
  let resource = null;
  if (body.resource !== undefined && body.resource !== '') {
    resource = canonicalResource(body.resource);
    if (resource !== mcpResource(req)) throw new OAuthError('invalid_target', `Tokens are only issued for ${mcpResource(req)}.`);
  }
  checkTokenScope(body.scope);
  await requireClient(clientId);

  const accessToken = newSecret();
  const refreshToken = newSecret();
  const [result] = await storyDb().rpc('story_oauth_rotate_refresh', {
    p_refresh_hash: hashSecret(refresh),
    p_client_id: clientId,
    p_resource: resource,
    p_access_hash: hashSecret(accessToken),
    p_access_expires: isoIn(ACCESS_TOKEN_TTL_SECONDS),
    p_new_refresh_hash: hashSecret(refreshToken),
    p_refresh_expires: isoIn(REFRESH_TOKEN_TTL_SECONDS),
  });
  switch (result?.status) {
    case 'ok':
      return tokenResponse(accessToken, refreshToken, result.scope);
    case 'wrong_resource':
      throw new OAuthError('invalid_target', 'resource does not match the original grant.');
    case 'reused':
      throw grantError('The refresh token was already used; the grant is revoked.');
    default:
      throw grantError('The refresh token is invalid or expired.');
  }
}

/** Handles a token request body (form fields). Returns the JSON response body or throws OAuthError. */
export async function exchangeToken(body, req) {
  const b = body && typeof body === 'object' ? body : {};
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) throw new OAuthError('invalid_request', `The ${k} parameter is repeated.`);
  }
  if (b.grant_type === 'authorization_code') return redeemCode(b, req);
  if (b.grant_type === 'refresh_token') return rotateRefresh(b, req);
  throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
}

// ---------------------------------------------------------------- resource server

function challenge(req, error, description) {
  const parts = [`resource_metadata="${resourceMetadataUrl(req)}"`, `scope="${SCOPE}"`];
  if (error) parts.push(`error="${error}"`, `error_description="${description}"`);
  return `Bearer ${parts.join(', ')}`;
}

/**
 * Checks the Bearer access token of a request to the MCP endpoint.
 * Returns { userId, clientId, scope }. Throws OAuthTokenError (status 401,
 * .wwwAuthenticate) when the token is missing, unknown, expired, revoked,
 * or was issued for another resource. Tokens are read from the
 * Authorization header only, never the query string.
 */
export async function verifyAccessToken(req) {
  const header = first(req?.headers?.authorization);
  const match = typeof header === 'string' ? /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i.exec(header) : null;
  if (!match) throw new OAuthTokenError('Missing access token.', challenge(req));
  const invalid = () =>
    new OAuthTokenError('Invalid access token.', challenge(req, 'invalid_token', 'The access token is invalid or expired'));
  const hash = hashSecret(match[1]);
  const [row] = await storyDb().select('story_oauth_tokens', { access_token_hash: hash }, { limit: 1 });
  if (!row || !safeEqual(row.access_token_hash, hash)) throw invalid();
  if (row.revoked_at || isPast(row.access_expires_at)) throw invalid();
  if (!safeEqual(row.resource, mcpResource(req))) throw invalid();
  return { userId: row.user_id, clientId: row.client_id, scope: row.scope };
}

/** Revokes every live token of a user and any unredeemed codes. Returns the number of token pairs revoked. */
export async function revokeTokensForUser(userId) {
  if (!userId) throw new TypeError('revokeTokensForUser: userId is required');
  const now = new Date().toISOString();
  const revoked = await storyDb().update('story_oauth_tokens', { user_id: userId, revoked_at: null }, { revoked_at: now });
  await storyDb().update('story_oauth_codes', { user_id: userId, used_at: null }, { used_at: now, revoked_at: now });
  return revoked.length;
}
