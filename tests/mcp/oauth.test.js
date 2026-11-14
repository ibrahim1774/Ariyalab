import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestDb } from '../helpers/db.js';

// ---- session stub ---------------------------------------------------------
let currentUser = null;
vi.mock('../../lib/supabaseServer.js', () => ({
  getUserFromRequest: async () => (currentUser ? { user: currentUser, supabase: {} } : null),
  getSupabaseAdmin: () => {
    throw new Error('service-role client must not be used in tests');
  },
}));

// ---- DNS stub for Client ID Metadata Document fetches ---------------------
const dnsAnswers = new Map();
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host) => {
    if (!dnsAnswers.has(host)) throw new Error('ENOTFOUND');
    return dnsAnswers.get(host).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
}));

const { setStoryDb } = await import('../../lib/story/db.js');
const oauth = await import('../../lib/mcp/oauth.js');
const clients = await import('../../lib/mcp/oauthClients.js');
const registerHandler = (await import('../../pages/api/oauth/register.js')).default;
const authorizeHandler = (await import('../../pages/api/oauth/authorize.js')).default;
const tokenHandler = (await import('../../pages/api/oauth/token.js')).default;
const metadataHandler = (await import('../../pages/api/oauth/metadata.js')).default;
const resourceHandler = (await import('../../pages/api/oauth/protected-resource.js')).default;
const consentPage = await import('../../pages/oauth/consent.js');
const { safeReturnTo } = await import('../../lib/safeReturnTo.js');

const ISSUER = 'https://app.test';
const RESOURCE = `${ISSUER}/api/mcp`;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const ALICE = { id: randomUUID(), email: 'alice@example.test' };
const BOB = { id: randomUUID(), email: 'bob@example.test' };

let raw;
beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
}, 60_000);

afterAll(async () => {
  setStoryDb(null);
  await raw?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubEnv('APP_URL', ISSUER);
  vi.stubEnv('VERCEL', '');
  currentUser = ALICE;
});

// ---- request / response fakes ---------------------------------------------
let ipCounter = 0;
function makeReq({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers: { host: 'app.test', ...headers }, socket: { remoteAddress: '203.0.113.9' } };
}
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    location: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return res.headers[name.toLowerCase()];
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    send(payload) {
      res.body = payload;
      return res;
    },
    end(payload) {
      res.body = payload;
      return res;
    },
    redirect(code, url) {
      res.statusCode = code;
      res.location = url;
      return res;
    },
  };
  return res;
}
const call = async (handler, opts) => {
  const res = makeRes();
  await handler(makeReq(opts), res);
  return res;
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_CT = { 'content-type': 'application/json' };
const SAME_ORIGIN = { ...FORM, origin: ISSUER, 'sec-fetch-site': 'same-origin' };

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(body = { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] }, ip) {
  ipCounter += 1;
  const res = makeRes();
  const req = makeReq({ method: 'POST', body, headers: JSON_CT });
  req.socket.remoteAddress = ip || `198.51.100.${ipCounter}`;
  await registerHandler(req, res);
  return res;
}

function authorizeQuery(clientId, challenge, extra = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'story',
    state: 'st-123',
    resource: RESOURCE,
    ...extra,
  };
}

async function consent(query) {
  const req = makeReq({ method: 'GET', query });
  const res = makeRes();
  const result = await consentPage.getServerSideProps({ req, res, query, resolvedUrl: '/oauth/consent' });
  return { result, res };
}

async function decide(requestToken, decision = 'allow', headers = SAME_ORIGIN) {
  return call(authorizeHandler, { method: 'POST', body: { request_token: requestToken, decision }, headers });
}

/** Full browser leg: consent page -> Allow. Returns the redirect URL. */
async function authorize(clientId, challenge, extra = {}) {
  const { result } = await consent(authorizeQuery(clientId, challenge, extra));
  expect(result.props?.requestToken, JSON.stringify(result)).toBeTruthy();
  const res = await decide(result.props.requestToken);
  expect(res.statusCode).toBe(303);
  return new URL(res.location);
}

const exchange = (body) => call(tokenHandler, { method: 'POST', body, headers: FORM });

async function newGrant() {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const redirect = await authorize(client.client_id, challenge);
  const code = redirect.searchParams.get('code');
  const res = await exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
    client_id: client.client_id,
    resource: RESOURCE,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return { client, code, verifier, tokens: res.body };
}

const bearer = (token) => makeReq({ headers: { authorization: `Bearer ${token}` } });
const hash = (s) => createHash('sha256').update(s).digest('base64url');

// ===========================================================================

describe('brief tests', () => {
  it('rejects a wrong code_verifier', async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const res = await exchange({
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code'),
      code_verifier: pkce().verifier,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: client.client_id,
      resource: RESOURCE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a code is single-use', async () => {
    const { client, code, verifier } = await newGrant();
    const again = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: client.client_id,
      resource: RESOURCE,
    });
    expect(again.statusCode).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('rejects an unregistered redirect URI with an error page, never a redirect', async () => {
    const { body: client } = await register();
    const { result, res } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'https://evil.test/cb' }));
    expect(result.redirect).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(result.props.error.message).toMatch(/redirect_uri/);
  });

  it('an expired access token returns 401 with WWW-Authenticate pointing at the resource metadata', async () => {
    const { tokens } = await newGrant();
    await raw.query(
      `update story_oauth_tokens set access_expires_at = now() - interval '1 second' where access_token_hash = $1`,
      [hash(tokens.access_token)]
    );
    const err = await oauth.verifyAccessToken(bearer(tokens.access_token)).catch((e) => e);
    expect(err).toBeInstanceOf(oauth.OAuthTokenError);
    expect(err.status).toBe(401);
    expect(err.wwwAuthenticate).toMatch(
      /^Bearer resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/api\/mcp"/
    );
    expect(err.wwwAuthenticate).toContain('error="invalid_token"');
    expect(err.headers['WWW-Authenticate']).toBe(err.wwwAuthenticate);
  });

  it('refresh rotation invalidates the old refresh token', async () => {
    const { client, tokens } = await newGrant();
    const first = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(first.statusCode).toBe(200);
    expect(first.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(first.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'story' });
    const old = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(old.statusCode).toBe(400);
    expect(old.body.error).toBe('invalid_grant');
  });
});

describe('happy path', () => {
  it('issues tokens that verifyAccessToken accepts for the user', async () => {
    const { client, tokens } = await newGrant();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'story' });
    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).resolves.toEqual({
      userId: ALICE.id,
      clientId: client.client_id,
      scope: 'story',
    });
  });

  it('stores only hashes of codes, request tokens and tokens', async () => {
    const { code, tokens } = await newGrant();
    const dump = JSON.stringify([
      (await raw.query('select * from story_oauth_codes')).rows,
      (await raw.query('select * from story_oauth_tokens')).rows,
      (await raw.query('select * from story_oauth_requests')).rows,
    ]);
    for (const secret of [code, tokens.access_token, tokens.refresh_token]) expect(dump).not.toContain(secret);
    const row = (await raw.query('select * from story_oauth_codes where code_hash = $1', [hash(code)])).rows[0];
    expect(row).toBeTruthy();
    expect(new Date(row.expires_at) - new Date(row.created_at)).toBeLessThanOrEqual(60_000);
  });

  it('echoes state untouched and adds iss', async () => {
    const { body: client } = await register();
    const state = 'a b+c/=%&é';
    const redirect = await authorize(client.client_id, pkce().challenge, { state });
    expect(redirect.origin + redirect.pathname).toBe(CLAUDE_CALLBACK);
    expect(redirect.searchParams.get('state')).toBe(state);
    expect(redirect.searchParams.get('iss')).toBe(ISSUER);
  });

  it('Deny redirects with access_denied and no code', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    const res = await decide(result.props.requestToken, 'deny');
    const loc = new URL(res.location);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
    expect(loc.searchParams.get('state')).toBe('st-123');
  });

  it('GET /api/oauth/authorize forwards only the known parameters to the consent page', async () => {
    const res = await call(authorizeHandler, { method: 'GET', query: { ...authorizeQuery('c1', 'x'), extra: 'drop' } });
    expect(res.statusCode).toBe(302);
    expect(res.location).toMatch(/^\/oauth\/consent\?/);
    expect(res.location).not.toContain('extra');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('codes', () => {
  it('redeeming a code twice revokes the tokens issued from it', async () => {
    const { client, code, verifier, tokens } = await newGrant();
    await exchange({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, resource: RESOURCE,
    });
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toBeInstanceOf(oauth.OAuthTokenError);
    const refresh = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refresh.body.error).toBe('invalid_grant');
  });

  it('a code issued for one client cannot be redeemed by another', async () => {
    const { body: a } = await register();
    const { body: b } = await register();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(a.client_id, challenge);
    const res = await exchange({
      grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK, client_id: b.client_id, resource: RESOURCE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a wrong redirect_uri at token time', async () => {
    const { body: client } = await register({ client_name: 'Two', redirect_uris: [CLAUDE_CALLBACK, 'https://claude.com/api/mcp/auth_callback'] });
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const res = await exchange({
      grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier,
      redirect_uri: 'https://claude.com/api/mcp/auth_callback', client_id: client.client_id, resource: RESOURCE,
    });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a missing or wrong resource at token time', async () => {
    const { body: client } = await register();
    for (const resource of [undefined, 'https://other.test/api/mcp']) {
      const { verifier, challenge } = pkce();
      const redirect = await authorize(client.client_id, challenge);
      const body = {
        grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id,
      };
      if (resource) body.resource = resource;
      const res = await exchange(body);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('invalid_target');
    }
  });

  it('rejects an expired code', async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const code = redirect.searchParams.get('code');
    await raw.query(`update story_oauth_codes set expires_at = now() - interval '1 second' where code_hash = $1`, [hash(code)]);
    const res = await exchange({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, resource: RESOURCE,
    });
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('refresh tokens', () => {
  it('reusing a rotated refresh token revokes the whole family', async () => {
    const { client, tokens } = await newGrant();
    const next = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(next.statusCode).toBe(200);
    const replay = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(replay.body.error).toBe('invalid_grant');
    const afterReplay = await exchange({ grant_type: 'refresh_token', refresh_token: next.body.refresh_token, client_id: client.client_id });
    expect(afterReplay.body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(next.body.access_token))).rejects.toBeInstanceOf(oauth.OAuthTokenError);
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toBeInstanceOf(oauth.OAuthTokenError);
  });

  it('rejects a refresh by another client or for another resource', async () => {
    const { client, tokens } = await newGrant();
    const { body: other } = await register();
    const wrongClient = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.client_id });
    expect(wrongClient.body.error).toBe('invalid_grant');
    const wrongResource = await exchange({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: 'https://other.test/api/mcp',
    });
    expect(wrongResource.body.error).toBe('invalid_target');
    const ok = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: RESOURCE });
    expect(ok.statusCode).toBe(200);
  });
});

describe('verifyAccessToken', () => {
  it('rejects a token issued for another resource', async () => {
    const { tokens } = await newGrant();
    await raw.query(`update story_oauth_tokens set resource = 'https://other.test/api/mcp' where access_token_hash = $1`, [
      hash(tokens.access_token),
    ]);
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
  });

  it('answers a missing token with a challenge that has no error code', async () => {
    const err = await oauth.verifyAccessToken(makeReq({ query: { access_token: 'x' } })).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.wwwAuthenticate).toBe(
      'Bearer resource_metadata="https://app.test/.well-known/oauth-protected-resource/api/mcp", scope="story"'
    );
  });

  it('rejects an unknown token and a revoked one', async () => {
    await expect(oauth.verifyAccessToken(bearer('nope'))).rejects.toMatchObject({ status: 401 });
    const { tokens } = await newGrant();
    expect(await oauth.revokeTokensForUser(ALICE.id)).toBeGreaterThan(0);
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
  });
});

describe('authorization request validation', () => {
  it.each([
    ['response_type', { response_type: 'token' }, 'unsupported_response_type'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['missing PKCE', { code_challenge: undefined, code_challenge_method: undefined }, 'invalid_request'],
    ['unknown scope', { scope: 'story admin' }, 'invalid_scope'],
    ['missing resource', { resource: undefined }, 'invalid_target'],
    ['wrong resource', { resource: 'https://evil.test/api/mcp' }, 'invalid_target'],
  ])('redirects %s errors to the registered redirect_uri', async (_label, extra, error) => {
    const { body: client } = await register();
    const query = authorizeQuery(client.client_id, pkce().challenge, extra);
    for (const k of Object.keys(query)) if (query[k] === undefined) delete query[k];
    const { result } = await consent(query);
    const loc = new URL(result.redirect.destination);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CALLBACK);
    expect(loc.searchParams.get('error')).toBe(error);
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
  });

  it('accepts story offline_access and the resource with a trailing slash', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { scope: 'story offline_access', resource: `${RESOURCE}/` }));
    expect(result.props.requestToken).toBeTruthy();
  });

  it('shows an error page for an unknown client', async () => {
    const { result } = await consent(authorizeQuery('mcp_unknown', pkce().challenge));
    expect(result.redirect).toBeUndefined();
    expect(result.props.error).toBeTruthy();
  });

  it.each([
    'https://claude.ai/api/mcp/auth_callback/extra',
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai/api/mcp/auth_callback#frag',
    'https://claude.ai.evil.test/api/mcp/auth_callback',
    'https://claude.ai:8443/api/mcp/auth_callback',
    'http://claude.ai/api/mcp/auth_callback',
    '//evil.test/cb',
    'javascript:alert(1)',
  ])('never redirects to the near-miss redirect_uri %s', async (redirectUri) => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: redirectUri, response_type: 'token' }));
    expect(result.redirect).toBeUndefined();
    expect(result.props.error).toBeTruthy();
  });

  it('matches a registered loopback redirect on any port, but only that host and path', async () => {
    const { body: client } = await register({ client_name: 'CLI', redirect_uris: ['http://localhost/callback'] });
    const ok = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'http://localhost:3118/callback' }));
    expect(ok.result.props.details).toMatchObject({ redirectHost: 'localhost:3118', loopbackOnly: true });
    for (const bad of ['http://127.0.0.1:3118/callback', 'http://localhost:3118/other', 'http://localhost.evil.test:3118/callback']) {
      const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: bad }));
      expect(result.props?.error, bad).toBeTruthy();
    }
  });
});

describe('consent page', () => {
  it('sends a signed-out visitor to sign-in with a safe returnTo back to the same request', async () => {
    currentUser = null;
    const { body: client } = await register();
    const query = authorizeQuery(client.client_id, pkce().challenge);
    const { result } = await consent(query);
    const dest = new URL(result.redirect.destination, ISSUER);
    expect(dest.pathname).toBe('/sign-in');
    const returnTo = dest.searchParams.get('returnTo');
    expect(safeReturnTo(returnTo)).toBe(returnTo);
    const back = new URL(returnTo, ISSUER);
    expect(back.pathname).toBe('/oauth/consent');
    expect(Object.fromEntries(back.searchParams)).toEqual(query);
  });

  it('the sign-in returnTo stays on this site whatever the query holds', async () => {
    const path = oauth.consentPath({ client_id: '//evil.test', redirect_uri: 'https://evil.test', state: 'https://evil.test' });
    expect(path.startsWith('/oauth/consent?')).toBe(true);
    expect(safeReturnTo(path)).toBe(path);
    // A backslash anywhere makes safeReturnTo fall back to /app: safe, never off-site.
    const slashy = oauth.consentPath({ client_id: 'c', state: '/\\evil.test' });
    expect(['/app', slashy]).toContain(safeReturnTo(slashy));
    expect(new URL(safeReturnTo(slashy), ISSUER).origin).toBe(ISSUER);
  });

  it('forbids framing and caching', async () => {
    const { body: client } = await register();
    const { res } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('renders client name and URI as plain text, with the access, account and redirect host', async () => {
    const { body: client } = await register({
      client_name: '<img src=x onerror=alert(1)>',
      client_uri: 'https://example.test/"><script>alert(1)</script>',
      redirect_uris: [CLAUDE_CALLBACK],
    });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    const html = renderToStaticMarkup(createElement(consentPage.default, result.props));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<a /);
    expect(html).toContain('Create and manage your Ariya Lab story videos and spend your credits');
    expect(html).toContain('alice@example.test');
    expect(html).toContain('claude.ai');
    expect(html).toContain('action="/api/oauth/authorize"');
    expect(html).toContain(`value="${result.props.requestToken}"`);
  });

  it('rejects a consent POST without a valid request token', async () => {
    for (const token of [undefined, '', 'forged-token']) {
      const res = await decide(token);
      expect(res.statusCode).toBe(400);
      expect(res.location).toBeNull();
    }
  });

  it('a request token is single-use and bound to the user who saw it', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    currentUser = BOB;
    const asBob = await decide(result.props.requestToken);
    expect(asBob.statusCode).toBe(400);
    currentUser = ALICE;
    expect((await decide(result.props.requestToken)).statusCode).toBe(303);
    const again = await decide(result.props.requestToken);
    expect(again.statusCode).toBe(400);
    expect(again.location).toBeNull();
  });

  it('rejects a cross-site consent POST and a signed-out one', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    const cross = await decide(result.props.requestToken, 'allow', { ...FORM, origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(403);
    currentUser = null;
    expect((await decide(result.props.requestToken)).statusCode).toBe(401);
    currentUser = ALICE;
    expect((await decide(result.props.requestToken)).statusCode).toBe(303);
  });

  it('an expired request token is rejected', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    await raw.query(`update story_oauth_requests set expires_at = now() - interval '1 second' where token_hash = $1`, [
      hash(result.props.requestToken),
    ]);
    expect((await decide(result.props.requestToken)).statusCode).toBe(400);
  });
});

describe('registration', () => {
  it('registers a public client', async () => {
    const res = await register({
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.body.client_id).toMatch(/^mcp_/);
    expect(res.body.client_secret).toBeUndefined();
  });

  it.each([
    ['client_name over 100', { client_name: 'x'.repeat(101), redirect_uris: [CLAUDE_CALLBACK] }, 'invalid_client_metadata'],
    ['missing client_name', { redirect_uris: [CLAUDE_CALLBACK] }, 'invalid_client_metadata'],
    ['six redirect URIs', { client_name: 'n', redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.test/${i}`) }, 'invalid_redirect_uri'],
    ['a 301-char redirect URI', { client_name: 'n', redirect_uris: [`https://a.test/${'p'.repeat(286)}`] }, 'invalid_redirect_uri'],
    ['http on a public host', { client_name: 'n', redirect_uris: ['http://a.test/cb'] }, 'invalid_redirect_uri'],
    ['a fragment', { client_name: 'n', redirect_uris: ['https://a.test/cb#x'] }, 'invalid_redirect_uri'],
    ['a wildcard', { client_name: 'n', redirect_uris: ['https://*.a.test/cb'] }, 'invalid_redirect_uri'],
    ['a custom scheme', { client_name: 'n', redirect_uris: ['myapp://cb'] }, 'invalid_redirect_uri'],
    ['credentials', { client_name: 'n', redirect_uris: ['https://u:p@a.test/cb'] }, 'invalid_redirect_uri'],
    ['no redirect URIs', { client_name: 'n', redirect_uris: [] }, 'invalid_redirect_uri'],
    ['an implicit grant', { client_name: 'n', redirect_uris: [CLAUDE_CALLBACK], grant_types: ['implicit'] }, 'invalid_client_metadata'],
    ['a javascript client_uri', { client_name: 'n', client_uri: 'javascript:alert(1)', redirect_uris: [CLAUDE_CALLBACK] }, 'invalid_client_metadata'],
  ])('rejects %s', async (_label, body, error) => {
    const res = await register(body);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it('allows http only on loopback hosts', async () => {
    const res = await register({ client_name: 'CLI', redirect_uris: ['http://localhost:8080/cb', 'http://127.0.0.1/cb'] });
    expect(res.statusCode).toBe(201);
  });

  it('caps registrations at 20 per IP per day', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < 20; i += 1) expect((await register(undefined, ip)).statusCode).toBe(201);
    const res = await register(undefined, ip);
    expect(res.statusCode).toBe(429);
    expect((await register(undefined, '192.0.2.78')).statusCode).toBe(201);
  });

  it('accepts only POST with application/json', async () => {
    expect((await call(registerHandler, { method: 'GET' })).statusCode).toBe(405);
    const res = await call(registerHandler, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(415);
  });
});

describe('token endpoint', () => {
  it('accepts only POST with form encoding and never caches', async () => {
    const get = await call(tokenHandler, { method: 'GET' });
    expect(get.statusCode).toBe(405);
    expect(get.headers['cache-control']).toBe('no-store');
    const json = await call(tokenHandler, { method: 'POST', body: {}, headers: JSON_CT });
    expect(json.statusCode).toBe(415);
  });

  it('rejects an unknown grant type and an unknown client', async () => {
    expect((await exchange({ grant_type: 'password' })).body.error).toBe('unsupported_grant_type');
    const res = await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'mcp_nobody' });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });
});

describe('Client ID Metadata Documents', () => {
  const CIMD_URL = 'https://claude.ai/oauth/claude-code-client-metadata';
  const DOC = {
    client_id: CIMD_URL,
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  let fetchMock;
  beforeEach(async () => {
    await raw.query(`delete from story_oauth_clients where kind = 'metadata_document'`);
    dnsAnswers.clear();
    dnsAnswers.set('claude.ai', ['160.79.104.10']);
    fetchMock = vi.fn(async () => new Response(JSON.stringify(DOC), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('fetches, caches and uses a metadata document client end to end', async () => {
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(CIMD_URL, challenge, { redirect_uri: 'http://127.0.0.1:53111/callback' });
    const { result } = await consent(query);
    expect(result.props.details).toMatchObject({ clientName: 'Claude Code', clientUri: 'https://claude.ai', loopbackOnly: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    const res = await decide(result.props.requestToken);
    const code = new URL(res.location).searchParams.get('code');
    const tok = await exchange({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:53111/callback', client_id: CIMD_URL, resource: RESOURCE,
    });
    expect(tok.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });

  it.each([
    ['a client_id mismatch', () => fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DOC, client_id: 'https://claude.ai/other' })))],
    ['a confidential client', () => fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DOC, token_endpoint_auth_method: 'private_key_jwt' })))],
    ['an oversized document', () => fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DOC, pad: 'x'.repeat(6000) })))],
    ['a redirect', () => fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }))],
    ['a private address', () => dnsAnswers.set('claude.ai', ['10.0.0.5'])],
    ['an http redirect URI', () => fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DOC, redirect_uris: ['http://claude.ai/cb'] })))],
  ])('rejects %s with an error page', async (_label, arrange) => {
    arrange();
    const { result } = await consent(authorizeQuery(CIMD_URL, pkce().challenge, { redirect_uri: 'http://localhost:4000/callback' }));
    expect(result.redirect).toBeUndefined();
    expect(result.props.error).toBeTruthy();
  });

  it.each(['https://10.0.0.1/meta.json', 'https://localhost/meta.json', 'https://claude.ai/', 'https://claude.ai:8443/meta', 'https://intranet.internal/meta'])(
    'never fetches %s',
    async (clientId) => {
      const { result } = await consent(authorizeQuery(clientId, pkce().challenge));
      expect(result.props.error).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) {
      expect(clients.isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['160.79.104.10', '8.8.8.8', '2606:4700::1111']) expect(clients.isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('discovery', () => {
  it('serves authorization server metadata with the fields MCP clients and Claude require', async () => {
    const res = await call(metadataHandler, { method: 'GET' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/api/oauth/authorize`,
      token_endpoint: `${ISSUER}/api/oauth/token`,
      registration_endpoint: `${ISSUER}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['story'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('serves protected resource metadata whose issuer matches the server metadata exactly', async () => {
    const prm = (await call(resourceHandler, { method: 'GET' })).body;
    const as = (await call(metadataHandler, { method: 'GET' })).body;
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(prm.scopes_supported).toEqual(['story']);
  });
});

describe('oauthIssuer', () => {
  it('uses APP_URL when set', () => {
    vi.stubEnv('APP_URL', 'https://ariyalab.example/');
    expect(oauth.oauthIssuer(makeReq({ headers: { host: 'evil.test' } }))).toBe('https://ariyalab.example');
  });

  it('falls back to Host, ignoring X-Forwarded-Host off Vercel', () => {
    vi.stubEnv('APP_URL', '');
    expect(oauth.oauthIssuer(makeReq({ headers: { host: 'app.example', 'x-forwarded-host': 'evil.test' } }))).toBe('https://app.example');
    expect(oauth.oauthIssuer(makeReq({ headers: { host: 'localhost:3000' } }))).toBe('http://localhost:3000');
  });

  it('uses X-Forwarded-Host on Vercel, always https', () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('VERCEL', '1');
    expect(oauth.oauthIssuer(makeReq({ headers: { host: 'internal', 'x-forwarded-host': 'ariyalab.example' } }))).toBe('https://ariyalab.example');
  });

  it('refuses a malformed host', () => {
    vi.stubEnv('APP_URL', '');
    expect(() => oauth.oauthIssuer(makeReq({ headers: { host: 'evil.test/"' } }))).toThrow();
  });
});

describe('schema', () => {
  it('RLS is on with no policies, and anon/authenticated have no access', async () => {
    const { rows } = await raw.query(
      `select c.relname, c.relrowsecurity,
              (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'story\\_oauth\\_%' order by 1`
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'story_oauth_clients', 'story_oauth_codes', 'story_oauth_registrations', 'story_oauth_requests', 'story_oauth_tokens',
    ]);
    for (const r of rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, policies: 0 });
    for (const role of ['anon', 'authenticated']) {
      await raw.exec(`set role ${role}`);
      try {
        await expect(raw.query('select * from story_oauth_tokens')).rejects.toThrow(/permission denied/);
        await expect(raw.query(`select story_oauth_registration_take('x', 5)`)).rejects.toThrow(/permission denied/);
      } finally {
        await raw.exec('reset role');
      }
    }
  });
});

describe('next.config.js', () => {
  it('rewrites the well-known documents, bare and path-suffixed, to the API routes', async () => {
    const { createRequire } = await import('node:module');
    const config = createRequire(import.meta.url)('../../next.config.js');
    const rewrites = await config.rewrites();
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp');
    const target = (path) => rewrites.find((r) => pathToRegexp(r.source).test(path))?.destination;
    expect(target('/.well-known/oauth-authorization-server')).toBe('/api/oauth/metadata');
    expect(target('/.well-known/oauth-authorization-server/api/mcp')).toBe('/api/oauth/metadata');
    expect(target('/.well-known/oauth-protected-resource')).toBe('/api/oauth/protected-resource');
    expect(target('/.well-known/oauth-protected-resource/api/mcp')).toBe('/api/oauth/protected-resource');
    const headers = await config.headers();
    const consent = headers.find((h) => pathToRegexp(h.source).test('/oauth/consent'));
    expect(consent.headers).toEqual(
      expect.arrayContaining([
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      ])
    );
  });
});
