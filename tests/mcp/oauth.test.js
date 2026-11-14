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

// ---- network stubs for Client ID Metadata Document fetches ----------------
// The real provider SSRF guard (lib/providers/http.js) runs; only DNS and
// the undici transport are stubbed.
const net = vi.hoisted(() => ({ dnsAnswers: new Map(), fetchMock: null }));
const dnsAnswers = net.dnsAnswers;
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal();
  const lookup = (host, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const list = net.dnsAnswers.get(host);
    if (!list) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const all = list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (options?.all) return cb(null, all);
    return cb(null, all[0].address, all[0].family);
  };
  return { ...real, default: { ...real, lookup }, lookup };
});
vi.mock('undici', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fetch: (...args) => net.fetchMock(...args) };
});

const { setStoryDb } = await import('../../lib/story/db.js');
const oauth = await import('../../lib/mcp/oauth.js');
const clients = await import('../../lib/mcp/oauthClients.js');
const providerHttp = await import('../../lib/providers/http.js');
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

const knownUsers = new Map();
beforeEach(() => {
  vi.stubEnv('APP_URL', ISSUER);
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('VERCEL_ENV', '');
  currentUser = ALICE;
  knownUsers.set(ALICE.id, { id: ALICE.id });
  knownUsers.set(BOB.id, { id: BOB.id });
  oauth.setOAuthUserLookup(async (id) => knownUsers.get(id) ?? null);
  net.fetchMock = vi.fn(async () => {
    throw new Error('unexpected network call');
  });
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
    // The client got the new pair (it used it), so the 60 s retry grace no longer applies.
    await oauth.verifyAccessToken(bearer(first.body.access_token));
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
    await raw.query(`update story_oauth_tokens set rotated_at = now() - interval '61 seconds' where refresh_token_hash = $1`, [hash(tokens.refresh_token)]);
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
  ])('shows %s errors on an error card with a link back to the registered redirect_uri, no auto-redirect', async (_label, extra, error) => {
    const { body: client } = await register();
    const query = authorizeQuery(client.client_id, pkce().challenge, extra);
    for (const k of Object.keys(query)) if (query[k] === undefined) delete query[k];
    for (const user of [null, ALICE]) {
      currentUser = user;
      const { result } = await consent(query);
      expect(result.redirect).toBeUndefined();
      expect(result.props.error.returnHost).toBe('claude.ai');
    }
    const { result } = await consent(query);
    const html = renderToStaticMarkup(createElement(consentPage.default, result.props));
    expect(html).toContain('Return to claude.ai');
    const loc = new URL(result.props.error.returnUrl);
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
    // Not no-referrer: under no-referrer browsers send the same-origin
    // approval POST with Origin: null, which the endpoint would reject.
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('accepts Origin null only with Sec-Fetch-Site same-origin', async () => {
    const { body: client } = await register();
    const first = await consent(authorizeQuery(client.client_id, pkce().challenge));
    expect((await decide(first.result.props.requestToken, 'allow', { ...FORM, origin: 'null' })).statusCode).toBe(403);
    const ok = await decide(first.result.props.requestToken, 'allow', { ...FORM, origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(ok.statusCode).toBe(303);
  });

  it('renders client name and URI as plain text, with the access, account and redirect host', async () => {
    const { body: client } = await register({
      client_name: '<img src=x onerror=alert(1)>',
      client_uri: 'https://app.example/"><script>alert(1)</script>',
      redirect_uris: ['https://app.example/cb'],
    });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'https://app.example/cb' }));
    const html = renderToStaticMarkup(createElement(consentPage.default, result.props));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<a /);
    expect(html).toContain('Create and manage your Ariya Lab story videos and spend your credits');
    expect(html).toContain('alice@example.test');
    expect(html).toContain('app.example');
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
  const docResponse = (doc = DOC, headers = {}) =>
    new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  let fetchMock;
  beforeEach(async () => {
    await raw.query(`delete from story_oauth_clients where kind = 'metadata_document'`);
    await raw.query('delete from story_oauth_cimd_failures');
    await raw.query('delete from story_oauth_rate_limits');
    dnsAnswers.clear();
    dnsAnswers.set('claude.ai', ['160.79.104.10']);
    fetchMock = vi.fn(async () => docResponse());
    net.fetchMock = fetchMock;
  });
  const cimdQuery = (extra = {}) => authorizeQuery(CIMD_URL, pkce().challenge, { redirect_uri: 'http://localhost:4000/callback', ...extra });

  it('fetches, caches and uses a metadata document client end to end', async () => {
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(CIMD_URL, challenge, { redirect_uri: 'http://127.0.0.1:53111/callback' });
    const { result } = await consent(query);
    expect(result.props.details).toMatchObject({ verified: true, headline: 'Claude Code', loopbackOnly: true });
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
    ['a client_id mismatch', () => fetchMock.mockResolvedValue(docResponse({ ...DOC, client_id: 'https://claude.ai/other' }))],
    ['a confidential client', () => fetchMock.mockResolvedValue(docResponse({ ...DOC, token_endpoint_auth_method: 'private_key_jwt' }))],
    ['no token_endpoint_auth_method', () => fetchMock.mockResolvedValue(docResponse({ ...DOC, token_endpoint_auth_method: undefined }))],
    ['an oversized document', () => fetchMock.mockResolvedValue(docResponse({ ...DOC, pad: 'x'.repeat(6000) }))],
    ['a redirect', () => fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://claude.ai/x' } }))],
    ['a private address', () => dnsAnswers.set('claude.ai', ['10.0.0.5'])],
    ['an IPv4-compatible loopback address', () => dnsAnswers.set('claude.ai', ['::127.0.0.1'])],
    ['an unresolvable host', () => dnsAnswers.delete('claude.ai')],
    ['an http redirect URI', () => fetchMock.mockResolvedValue(docResponse({ ...DOC, redirect_uris: ['http://claude.ai/cb'] }))],
    ['invalid JSON', () => fetchMock.mockResolvedValue(new Response('{nope', { status: 200 }))],
  ])('rejects %s with one generic error message', async (_label, arrange) => {
    arrange();
    const { result } = await consent(cimdQuery());
    expect(result.redirect).toBeUndefined();
    expect(result.props.error.message).toBe("We could not load this app's details. Try connecting again later.");
  });

  it.each([
    'https://10.0.0.1/meta.json', 'https://localhost/meta.json', 'https://claude.ai/', 'https://claude.ai:8443/meta',
    'https://intranet.internal/meta', 'https://[::ffff:7f00:1]/meta', 'http://claude.ai/meta',
  ])('never fetches %s', async (clientId) => {
    const { result } = await consent(authorizeQuery(clientId, pkce().challenge));
    expect(result.props.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies private addresses with the shared provider guard', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1',
      '::ffff:10.0.0.1', '0.0.0.0', '::127.0.0.1', '::ffff:7f00:1', '2002:7f00:1::', 'fec0::1', '100::1', '2001::1', '64:ff9b::a00:1',
    ]) {
      expect(providerHttp.isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['160.79.104.10', '8.8.8.8', '2606:4700::1111']) expect(providerHttp.isPrivateAddress(ip), ip).toBe(false);
    expect(clients.isPrivateAddress).toBeUndefined();
  });

  it('a signed-out visitor with an uncached client goes to sign-in before anything is fetched', async () => {
    currentUser = null;
    const { result } = await consent(cimdQuery());
    expect(new URL(result.redirect.destination, ISSUER).pathname).toBe('/sign-in');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await raw.query('select count(*)::int as n from story_oauth_clients where kind = $1', ['metadata_document'])).rows[0].n).toBe(0);
  });

  it('the token endpoint never fetches a metadata document', async () => {
    const res = await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: CIMD_URL });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the stale cached row when a refetch fails', async () => {
    await consent(cimdQuery());
    await raw.query(`update story_oauth_clients set metadata_expires_at = now() - interval '1 minute' where client_id = $1`, [CIMD_URL]);
    fetchMock.mockRejectedValue(new Error('down'));
    const { result } = await consent(cimdQuery());
    expect(result.props.requestToken).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a failure for a few minutes', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    await consent(cimdQuery());
    await consent(cimdQuery());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await raw.query(`update story_oauth_cimd_failures set retry_after = now() - interval '1 second'`);
    fetchMock.mockResolvedValue(docResponse());
    const { result } = await consent(cimdQuery());
    expect(result.props.requestToken).toBeTruthy();
  });

  it('respects Cache-Control max-age within 5 minutes and 24 hours', async () => {
    const ttl = async (cacheControl) => {
      await raw.query(`delete from story_oauth_clients where client_id = $1`, [CIMD_URL]);
      fetchMock.mockResolvedValue(docResponse(DOC, cacheControl ? { 'cache-control': cacheControl } : {}));
      await consent(cimdQuery());
      const row = (await raw.query('select extract(epoch from metadata_expires_at - metadata_fetched_at)::int as s from story_oauth_clients where client_id = $1', [CIMD_URL])).rows[0];
      return row.s;
    };
    expect(await ttl('max-age=60')).toBe(300);
    expect(await ttl('public, max-age=3600')).toBe(3600);
    expect(await ttl('max-age=9999999')).toBe(86400);
    expect(await ttl(null)).toBe(86400);
  });

  it('charges first-time fetches against the per-IP registration limit', async () => {
    await raw.query(
      `insert into story_oauth_rate_limits (bucket, day, count) values ($1, current_date, 20)`,
      [`register:${clients.ipKeyHash('203.0.113.9')}`]
    );
    const { result } = await consent(cimdQuery());
    expect(result.props.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
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
      'story_oauth_cimd_failures', 'story_oauth_clients', 'story_oauth_codes', 'story_oauth_rate_limits', 'story_oauth_requests', 'story_oauth_tokens',
    ]);
    for (const r of rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, policies: 0 });
    for (const role of ['anon', 'authenticated']) {
      await raw.exec(`set role ${role}`);
      try {
        await expect(raw.query('select * from story_oauth_tokens')).rejects.toThrow(/permission denied/);
        await expect(raw.query(`select story_oauth_rate_take('x', 5)`)).rejects.toThrow(/permission denied/);
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

// ============================================================ fix round 1

const revokeHandler = (await import('../../pages/api/oauth/revoke.js')).default;
const connectionsHandler = (await import('../../pages/api/oauth/connections.js')).default;
const cleanupHandler = (await import('../../pages/api/cron/oauth-cleanup.js')).default;
const renderConsent = (props) => renderToStaticMarkup(createElement(consentPage.default, props));
const tokenRow = async (access) => (await raw.query('select * from story_oauth_tokens where access_token_hash = $1', [hash(access)])).rows[0];
const refresh = (client, refreshToken, extra = {}) =>
  exchange({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id, ...extra });

describe('I1 consent identity', () => {
  it('names a client verified by Claude\'s documented callback "Claude", whatever it calls itself', async () => {
    const { body: client } = await register({ client_name: 'Totally Real Bank', redirect_uris: [CLAUDE_CALLBACK] });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    expect(result.props.details).toMatchObject({ verified: true, headline: 'Claude', redirectHost: 'claude.ai' });
    const html = renderConsent(result.props);
    expect(html).toContain('Claude');
    expect(html).not.toContain('Totally Real Bank');
    expect(html).not.toContain('Unverified app');
  });

  it('headlines an unverified client by its redirect host and labels it', async () => {
    const { body: client } = await register({
      client_name: 'Claude',
      client_uri: 'https://claude.ai',
      redirect_uris: ['https://claude.ai.evil.example/api/mcp/auth_callback'],
    });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'https://claude.ai.evil.example/api/mcp/auth_callback' }));
    expect(result.props.details).toMatchObject({ verified: false, headline: 'claude.ai.evil.example', clientUri: null });
    const html = renderConsent(result.props);
    expect(html).toContain('Unverified app');
    expect(html).toMatch(/<h1[^>]*>[^<]*<span[^>]*>claude\.ai\.evil\.example<\/span>/);
    expect(html).not.toContain('https://claude.ai<');
  });

  it('shows client_uri only when its host is the redirect host', async () => {
    const { body: client } = await register({ client_name: 'Notes', client_uri: 'https://notes.example/about', redirect_uris: ['https://notes.example/cb'] });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'https://notes.example/cb' }));
    expect(result.props.details.clientUri).toBe('https://notes.example/about');
  });

  it('never verifies a loopback client, even one calling itself Claude Code', async () => {
    const { body: client } = await register({ client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'] });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'http://localhost:5000/callback' }));
    expect(result.props.details).toMatchObject({ verified: false, headline: 'localhost:5000', loopbackOnly: true });
  });

  it('shows the client_id host of an unverified metadata document client', async () => {
    const url = 'https://tools.example/oauth/client.json';
    await raw.query('delete from story_oauth_rate_limits');
    dnsAnswers.set('tools.example', ['160.79.104.20']);
    net.fetchMock = vi.fn(async () => new Response(JSON.stringify({
      client_id: url, client_name: 'Tools', redirect_uris: ['https://tools.example/cb'], token_endpoint_auth_method: 'none',
    })));
    const { result } = await consent(authorizeQuery(url, pkce().challenge, { redirect_uri: 'https://tools.example/cb' }));
    expect(result.props.details).toMatchObject({ verified: false, headline: 'tools.example', clientIdHost: 'tools.example' });
  });

  it('strips bidi, zero-width and other format characters from names, stored and shown', async () => {
    const { body: client } = await register({ client_name: 'Cla​ude‮ edoC', redirect_uris: ['https://x.example/cb'] });
    expect(client.client_name).toBe('Claude edoC');
    await raw.query(`update story_oauth_clients set client_name = 'Ev⁦il' where client_id = $1`, [client.client_id]);
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'https://x.example/cb' }));
    expect(result.props.details.clientName).toBe('Evil');
    expect(clients.cleanDisplayText('a‍⁠﻿b')).toBe('ab');
  });

  it('keeps the verified list in one config constant', () => {
    expect(clients.VERIFIED_CLIENTS).toEqual([
      { name: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback' },
      { name: 'Claude Code', clientId: 'https://claude.ai/oauth/claude-code-client-metadata' },
    ]);
  });

  it('page copy uses no dashes as punctuation', async () => {
    const { body: client } = await register({ client_name: 'n', redirect_uris: ['https://x.example/cb'] });
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: 'https://x.example/cb' }));
    const text = renderConsent(result.props).replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/ [-–—] /);
  });
});

describe('I3 / O1 client loading', () => {
  it('validation without a session never fetches; loadClient refuses an uncached document', async () => {
    await expect(clients.loadClient('https://new.example/c.json', { allowFetch: false })).rejects.toMatchObject({ error: 'client_not_cached' });
  });
});

describe('I4 revocation', () => {
  it('advertises the revocation endpoint', async () => {
    const res = await call(metadataHandler, { method: 'GET' });
    expect(res.body).toMatchObject({
      revocation_endpoint: `${ISSUER}/api/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ['none'],
    });
  });

  it.each(['access_token', 'refresh_token'])('POST /api/oauth/revoke with the %s revokes the whole grant', async (kind) => {
    const { client, tokens } = await newGrant();
    const res = await call(revokeHandler, { method: 'POST', body: { token: tokens[kind], client_id: client.client_id }, headers: FORM });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
    expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('revoke answers 200 for unknown tokens and ignores tokens of another client', async () => {
    const { tokens } = await newGrant();
    const { body: other } = await register();
    expect((await call(revokeHandler, { method: 'POST', body: { token: 'nope', client_id: other.client_id }, headers: FORM })).statusCode).toBe(200);
    expect((await call(revokeHandler, { method: 'POST', body: { token: tokens.access_token, client_id: other.client_id }, headers: FORM })).statusCode).toBe(200);
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).resolves.toBeTruthy();
    expect((await call(revokeHandler, { method: 'GET' })).statusCode).toBe(405);
    expect((await call(revokeHandler, { method: 'POST', body: {}, headers: JSON_CT })).statusCode).toBe(415);
    expect((await call(revokeHandler, { method: 'POST', body: { client_id: other.client_id }, headers: FORM })).body.error).toBe('invalid_request');
  });

  it('lists only my active grants by client and lets me disconnect one', async () => {
    await oauth.revokeTokensForUser(ALICE.id);
    const mine = await newGrant();
    currentUser = BOB;
    const bobs = await newGrant();
    currentUser = ALICE;
    const list = await call(connectionsHandler, { method: 'GET' });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.connections).toEqual([
      expect.objectContaining({ clientId: mine.client.client_id, headline: 'Claude', verified: true }),
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/hash/);
    // I cannot disconnect Bob's grant.
    await call(connectionsHandler, { method: 'POST', body: { client_id: bobs.client.client_id }, headers: { ...JSON_CT, origin: ISSUER } });
    await expect(oauth.verifyAccessToken(bearer(bobs.tokens.access_token))).resolves.toBeTruthy();
    const off = await call(connectionsHandler, { method: 'POST', body: { client_id: mine.client.client_id }, headers: { ...JSON_CT, origin: ISSUER } });
    expect(off.statusCode).toBe(200);
    await expect(oauth.verifyAccessToken(bearer(mine.tokens.access_token))).rejects.toMatchObject({ status: 401 });
    expect((await call(connectionsHandler, { method: 'GET' })).body.connections).toEqual([]);
  });

  it('the connections API needs a session, JSON and same origin', async () => {
    currentUser = null;
    expect((await call(connectionsHandler, { method: 'GET' })).statusCode).toBe(401);
    currentUser = ALICE;
    expect((await call(connectionsHandler, { method: 'POST', body: { client_id: 'x' }, headers: { ...JSON_CT, origin: 'https://evil.test' } })).statusCode).toBe(403);
    expect((await call(connectionsHandler, { method: 'POST', body: { client_id: 'x' }, headers: { ...FORM, origin: ISSUER } })).statusCode).toBe(415);
    expect((await call(connectionsHandler, { method: 'DELETE' })).statusCode).toBe(405);
  });

  it('a grant ends 90 days after authorization, however often it is refreshed', async () => {
    const { client, tokens } = await newGrant();
    const row = await tokenRow(tokens.access_token);
    expect(Math.round((new Date(row.family_expires_at) - new Date(row.created_at)) / 86_400_000)).toBe(90);
    await raw.query(`update story_oauth_tokens set family_expires_at = now() + interval '1 hour' where family_id = $1`, [row.family_id]);
    const next = await refresh(client, tokens.refresh_token);
    const nextRow = await tokenRow(next.body.access_token);
    expect(new Date(nextRow.refresh_expires_at).getTime()).toBeLessThanOrEqual(new Date(nextRow.family_expires_at).getTime());
    expect(new Date(nextRow.access_expires_at).getTime()).toBeLessThanOrEqual(new Date(nextRow.family_expires_at).getTime());
    await raw.query(`update story_oauth_tokens set family_expires_at = now() - interval '1 second' where family_id = $1`, [row.family_id]);
    expect((await refresh(client, next.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('verifyAccessToken rejects a deleted or banned user and caches live users briefly', async () => {
    const { tokens } = await newGrant();
    const lookup = vi.fn(async () => ({ id: ALICE.id }));
    oauth.setOAuthUserLookup(lookup);
    await oauth.verifyAccessToken(bearer(tokens.access_token));
    await oauth.verifyAccessToken(bearer(tokens.access_token));
    expect(lookup).toHaveBeenCalledTimes(1);
    oauth.setOAuthUserLookup(async () => null);
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401, error: 'invalid_token' });
    oauth.setOAuthUserLookup(async (id) => ({ id, banned_until: new Date(Date.now() + 3_600_000).toISOString() }));
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed with 503 (not 401) when the user lookup is unavailable', async () => {
    const { tokens } = await newGrant();
    oauth.setOAuthUserLookup(null); // default lookup: the admin client, which throws in tests
    const err = await oauth.verifyAccessToken(bearer(tokens.access_token)).catch((e) => e);
    expect(err).toBeInstanceOf(oauth.OAuthUnavailableError);
    expect(err.status).toBe(503);
  });

  it('revokeTokensForUser also kills taken codes and pending consent requests (M6, Opus)', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const code = redirect.searchParams.get('code');
    const [taken] = await storyDbRpc('story_oauth_take_code', { p_code_hash: hash(code) });
    await oauth.revokeTokensForUser(ALICE.id);
    await expect(storyDbRpc('story_oauth_issue_code_tokens', {
      p_code_id: taken.id, p_access_hash: 'a'.repeat(43), p_access_expires: new Date(Date.now() + 1e6).toISOString(),
      p_refresh_hash: 'r'.repeat(43), p_refresh_expires: new Date(Date.now() + 1e6).toISOString(),
    })).rejects.toThrow(/code_revoked/);
    expect((await decide(result.props.requestToken)).statusCode).toBe(400);
    expect(verifier).toBeTruthy();
  });
});

const storyDbRpc = async (fn, params) => (await import('../../lib/story/db.js')).storyDb().rpc(fn, params);

describe('O2 refresh grace window', () => {
  it('a retry within 60 s gets a fresh pair and the lost successor stops working', async () => {
    const { client, tokens } = await newGrant();
    const lost = await refresh(client, tokens.refresh_token);
    const retry = await refresh(client, tokens.refresh_token);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.refresh_token).not.toBe(lost.body.refresh_token);
    await expect(oauth.verifyAccessToken(bearer(lost.body.access_token))).rejects.toMatchObject({ status: 401 });
    expect((await refresh(client, lost.body.refresh_token)).body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(retry.body.access_token))).resolves.toBeTruthy();
  });

  it('reuse after 60 s revokes the family', async () => {
    const { client, tokens } = await newGrant();
    const next = await refresh(client, tokens.refresh_token);
    await raw.query(`update story_oauth_tokens set rotated_at = now() - interval '61 seconds' where refresh_token_hash = $1`, [hash(tokens.refresh_token)]);
    expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(next.body.access_token))).rejects.toMatchObject({ status: 401 });
  });

  it('reuse within 60 s after the successor was used revokes the family', async () => {
    const { client, tokens } = await newGrant();
    const next = await refresh(client, tokens.refresh_token);
    await oauth.verifyAccessToken(bearer(next.body.access_token));
    expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(next.body.access_token))).rejects.toMatchObject({ status: 401 });
  });

  it('reuse within 60 s after the successor was itself rotated revokes the family', async () => {
    const { client, tokens } = await newGrant();
    const next = await refresh(client, tokens.refresh_token);
    const third = await refresh(client, next.body.refresh_token);
    expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(third.body.access_token))).rejects.toMatchObject({ status: 401 });
  });
});

describe('M7 code replay window', () => {
  it('a code replayed more than 10 minutes later is refused without revoking the grant', async () => {
    const { client, code, verifier, tokens } = await newGrant();
    await raw.query(`update story_oauth_codes set used_at = now() - interval '11 minutes' where code_hash = $1`, [hash(code)]);
    const again = await exchange({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, resource: RESOURCE,
    });
    expect(again.body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(tokens.access_token))).resolves.toBeTruthy();
  });
});

describe('I5 limits and cleanup', () => {
  it('limits refreshes per grant per day with 429, never invalid_grant', async () => {
    const { client, tokens } = await newGrant();
    const row = await tokenRow(tokens.access_token);
    await raw.query(
      `insert into story_oauth_tokens (family_id, client_id, user_id, scope, resource, redirect_uri, family_created_at,
         access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, family_expires_at, rotated_at)
       select $1, client_id, user_id, scope, resource, redirect_uri, family_created_at,
              'fa' || g, now(), 'fr' || g, now(), family_expires_at, now() - interval '1 hour'
         from story_oauth_tokens, generate_series(1, $2::int) g where id = $3`,
      [row.family_id, oauth.REFRESHES_PER_GRANT_PER_DAY, row.id]
    );
    const res = await refresh(client, tokens.refresh_token);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).not.toBe('invalid_grant');
  });

  it('limits token requests per IP per day with 429', async () => {
    await raw.query(`insert into story_oauth_rate_limits (bucket, day, count) values ($1, current_date, $2)
                     on conflict (bucket, day) do update set count = excluded.count`,
      [`token:${clients.ipKeyHash('203.0.113.9')}`, oauth.TOKEN_REQUESTS_PER_IP_PER_DAY]);
    const res = await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'y' });
    expect(res.statusCode).toBe(429);
    await raw.query(`delete from story_oauth_rate_limits where bucket like 'token:%'`);
  });

  it('keys the registration cap on the IPv6 /64', async () => {
    expect(clients.ipKey('2001:db8:1:2:aaaa::1')).toBe(clients.ipKey('2001:db8:1:2:bbbb::9'));
    expect(clients.ipKey('2001:db8:1:3::1')).not.toBe(clients.ipKey('2001:db8:1:2::1'));
    expect(clients.ipKey('198.51.100.7')).toBe('198.51.100.7');
    for (let i = 0; i < 20; i += 1) expect((await register(undefined, `2001:db8:9:9:${i.toString(16)}::1`)).statusCode).toBe(201);
    expect((await register(undefined, '2001:db8:9:9:ffff::2')).statusCode).toBe(429);
  });

  it('M9: an invalid registration does not spend the quota', async () => {
    const ip = '192.0.2.200';
    await raw.query(`insert into story_oauth_rate_limits (bucket, day, count) values ($1, current_date, 19)`, [`register:${clients.ipKeyHash(ip)}`]);
    expect((await register({ client_name: '', redirect_uris: [] }, ip)).statusCode).toBe(400);
    expect((await register(undefined, ip)).statusCode).toBe(201);
    expect((await register(undefined, ip)).statusCode).toBe(429);
  });

  it('the cleanup cron needs CRON_SECRET', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    expect((await call(cleanupHandler, { method: 'GET' })).statusCode).toBe(401);
    expect((await call(cleanupHandler, { method: 'GET', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await call(cleanupHandler, { method: 'GET', headers: { authorization: 'Bearer ' } })).statusCode).toBe(401);
  });

  it('the cleanup cron deletes dead rows and keeps live ones', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    const live = await newGrant();
    const dead = await newGrant();
    const unused = (await register()).body;
    await raw.query(`update story_oauth_clients set created_at = now() - interval '8 days' where client_id = $1`, [unused.client_id]);
    await raw.query(`update story_oauth_tokens set revoked_at = now() - interval '2 days' where access_token_hash = $1`, [hash(dead.tokens.access_token)]);
    await raw.query(`update story_oauth_codes set expires_at = now() - interval '2 days'`);
    await raw.query(`update story_oauth_requests set expires_at = now() - interval '2 days'`);
    await raw.query(`insert into story_oauth_rate_limits (bucket, day, count) values ('register:old', current_date - 3, 1)`);
    const res = await call(cleanupHandler, { method: 'GET', headers: { authorization: 'Bearer s3cret' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.deleted).toMatchObject({ tokens: expect.any(Number), codes: expect.any(Number), requests: expect.any(Number) });
    expect(await tokenRow(dead.tokens.access_token)).toBeUndefined();
    expect(await tokenRow(live.tokens.access_token)).toBeTruthy();
    await expect(oauth.verifyAccessToken(bearer(live.tokens.access_token))).resolves.toBeTruthy();
    const n = async (sql, p) => (await raw.query(sql, p)).rows[0].n;
    expect(await n(`select count(*)::int as n from story_oauth_codes`)).toBe(0);
    expect(await n(`select count(*)::int as n from story_oauth_requests`)).toBe(0);
    expect(await n(`select count(*)::int as n from story_oauth_rate_limits where bucket = 'register:old'`)).toBe(0);
    expect(await n(`select count(*)::int as n from story_oauth_clients where client_id = $1`, [unused.client_id])).toBe(0);
    expect(await n(`select count(*)::int as n from story_oauth_clients where client_id = $1`, [live.client.client_id])).toBe(1);
  });

  it('is scheduled daily in vercel.json next to the existing crons', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
    const paths = config.crons.map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/cron/cleanup-history', '/api/cron/story-tick', '/api/cron/oauth-cleanup']));
    expect(config.crons.find((c) => c.path === '/api/cron/oauth-cleanup').schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('I2 / Opus repeated parameters', () => {
  it('GET /api/oauth/authorize rejects a repeated parameter with an error page', async () => {
    const res = await call(authorizeHandler, { method: 'GET', query: { ...authorizeQuery('c', 'x'), state: ['a', 'b'] } });
    expect(res.statusCode).toBe(400);
    expect(res.location).toBeNull();
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('M1 issuer in production', () => {
  it('refuses to derive the issuer from the request in production', () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(() => oauth.oauthIssuer(makeReq())).toThrow(/APP_URL/);
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => oauth.oauthIssuer(makeReq())).toThrow(/APP_URL/);
    vi.stubEnv('NODE_ENV', 'test');
  });
});

describe('M5 framing', () => {
  it('next.config.js forbids framing sign-in, sign-up and /oauth', async () => {
    const { createRequire } = await import('node:module');
    const config = createRequire(import.meta.url)('../../next.config.js');
    const headers = await config.headers();
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp');
    for (const path of ['/sign-in', '/sign-up', '/oauth/consent']) {
      const rule = headers.find((h) => pathToRegexp(h.source).test(path));
      expect(rule?.headers, path).toEqual(expect.arrayContaining([{ key: 'X-Frame-Options', value: 'DENY' }]));
    }
  });

  it('the consent form is not rendered at all when the page is framed', async () => {
    const { body: client } = await register();
    const { result } = await consent(authorizeQuery(client.client_id, pkce().challenge));
    const saved = globalThis.window;
    globalThis.window = { top: {}, self: {} };
    try {
      const html = renderConsent(result.props);
      expect(html).not.toContain('<form');
      expect(html).toContain('Open this page in its own window');
    } finally {
      if (saved === undefined) delete globalThis.window;
      else globalThis.window = saved;
    }
  });
});

describe('Opus discovery minors', () => {
  it('the protected resource rewrite answers only the bare path and the MCP path', async () => {
    const { createRequire } = await import('node:module');
    const config = createRequire(import.meta.url)('../../next.config.js');
    const rewrites = await config.rewrites();
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp');
    const target = (path) => rewrites.find((r) => pathToRegexp(r.source).test(path))?.destination;
    expect(target('/.well-known/oauth-protected-resource/other')).toBeUndefined();
    expect(target('/.well-known/oauth-protected-resource/api/mcp')).toBe('/api/oauth/protected-resource');
  });

  it('story_oauth_codes is indexed by user_id', async () => {
    const { rows } = await raw.query(`select indexdef from pg_indexes where tablename = 'story_oauth_codes'`);
    expect(rows.some((r) => /\(user_id\)/.test(r.indexdef))).toBe(true);
  });
});

// ============================================================ fix round 2

describe('round 2', () => {
  const sweep = async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    const res = await call(cleanupHandler, { method: 'GET', headers: { authorization: 'Bearer s3cret' } });
    expect(res.statusCode).toBe(200);
    return res;
  };

  it('1: the sweep keeps rotated rows of a live grant, so an old token still revokes the family', async () => {
    const { client, tokens } = await newGrant();
    const next = await refresh(client, tokens.refresh_token);
    await oauth.verifyAccessToken(bearer(next.body.access_token));
    await raw.query(
      `update story_oauth_tokens set rotated_at = now() - interval '8 days', access_expires_at = now() - interval '8 days',
              created_at = now() - interval '8 days' where refresh_token_hash = $1`,
      [hash(tokens.refresh_token)]
    );
    await sweep();
    expect(await tokenRow(tokens.access_token)).toBeTruthy();
    expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(bearer(next.body.access_token))).rejects.toMatchObject({ status: 401 });
  });

  it('2: first use of an access token is marked once, atomically, in the database', async () => {
    const { tokens } = await newGrant();
    await oauth.verifyAccessToken(bearer(tokens.access_token));
    const first = (await tokenRow(tokens.access_token)).access_used_at;
    expect(first).toBeTruthy();
    await oauth.verifyAccessToken(bearer(tokens.access_token));
    expect((await tokenRow(tokens.access_token)).access_used_at).toEqual(first);
    const { rows } = await raw.query(`select 1 from pg_proc where proname = 'story_oauth_use_access_token'`);
    expect(rows).toHaveLength(1);
  });

  it('3: Connected apps headlines a grant by the redirect URI it actually used', async () => {
    await oauth.revokeTokensForUser(ALICE.id);
    const { body: client } = await register({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK, 'https://evil.example/cb'] });
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge, { redirect_uri: 'https://evil.example/cb' });
    const tok = await exchange({
      grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier,
      redirect_uri: 'https://evil.example/cb', client_id: client.client_id, resource: RESOURCE,
    });
    expect(tok.statusCode).toBe(200);
    expect((await tokenRow(tok.body.access_token)).redirect_uri).toBe('https://evil.example/cb');
    const list = await call(connectionsHandler, { method: 'GET' });
    expect(list.body.connections).toEqual([expect.objectContaining({ headline: 'evil.example', verified: false })]);
  });

  it('4: the sweep keeps a client for 90 days after its last grant ended', async () => {
    const { client, tokens } = await newGrant();
    expect((await raw.query('select last_grant_ends_at from story_oauth_clients where client_id = $1', [client.client_id])).rows[0].last_grant_ends_at).toBeTruthy();
    await raw.query(`update story_oauth_tokens set revoked_at = now() - interval '2 days' where access_token_hash = $1`, [hash(tokens.access_token)]);
    await raw.query(`delete from story_oauth_codes where client_id = $1`, [client.client_id]);
    await raw.query(`delete from story_oauth_requests where client_id = $1`, [client.client_id]);
    await raw.query(`update story_oauth_clients set created_at = now() - interval '200 days' where client_id = $1`, [client.client_id]);
    const exists = async () => (await raw.query('select count(*)::int as n from story_oauth_clients where client_id = $1', [client.client_id])).rows[0].n;
    await sweep();
    expect(await exists()).toBe(1);
    await raw.query(`update story_oauth_clients set last_grant_ends_at = now() - interval '91 days' where client_id = $1`, [client.client_id]);
    await sweep();
    expect(await exists()).toBe(0);
  });

  describe('5: stale metadata documents', () => {
    const CIMD_URL = 'https://claude.ai/oauth/claude-code-client-metadata';
    const DOC = {
      client_id: CIMD_URL, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
    };
    const q = () => authorizeQuery(CIMD_URL, pkce().challenge, { redirect_uri: 'http://localhost:4000/callback' });
    beforeEach(async () => {
      await raw.query(`delete from story_oauth_clients where kind = 'metadata_document'`);
      await raw.query('delete from story_oauth_cimd_failures');
      await raw.query('delete from story_oauth_rate_limits');
      dnsAnswers.set('claude.ai', ['160.79.104.10']);
      net.fetchMock = vi.fn(async () => new Response(JSON.stringify(DOC), { status: 200 }));
      await consent(q());
    });
    const age = (fetchedDaysAgo) =>
      raw.query(
        `update story_oauth_clients set metadata_fetched_at = now() - make_interval(days => $1::int),
                metadata_expires_at = now() - interval '1 minute' where client_id = $2`,
        [fetchedDaysAgo, CIMD_URL]
      );

    it('serves a stale row at most 30 days', async () => {
      await age(31);
      net.fetchMock.mockRejectedValue(new Error('down'));
      const { result } = await consent(q());
      expect(result.props.error).toBeTruthy();
    });

    it('treats 404 or 410 as withdrawal, also at the token endpoint', async () => {
      for (const status of [404, 410]) {
        await raw.query('delete from story_oauth_cimd_failures');
        await raw.query(`update story_oauth_clients set metadata_withdrawn_at = null where client_id = $1`, [CIMD_URL]);
        await age(1);
        net.fetchMock.mockResolvedValue(new Response('gone', { status }));
        const { result } = await consent(q());
        expect(result.props.error, String(status)).toBeTruthy();
        const tok = await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: CIMD_URL });
        expect(tok.body.error).toBe('invalid_client');
      }
    });

    it('the token endpoint refetches a known client whose cache expired, never an unknown one', async () => {
      await age(1);
      net.fetchMock.mockClear();
      const tok = await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: CIMD_URL });
      expect(tok.body.error).toBe('invalid_grant');
      expect(net.fetchMock).toHaveBeenCalledTimes(1);
      const unknown = await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'https://other.example/c.json' });
      expect(unknown.body.error).toBe('invalid_client');
      expect(net.fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('7: Connected shows the original authorization time, even after old rows are pruned', async () => {
    await oauth.revokeTokensForUser(ALICE.id);
    const { client, tokens } = await newGrant();
    const original = await tokenRow(tokens.access_token);
    await raw.query(`update story_oauth_tokens set family_created_at = '2026-01-02T03:04:05Z' where family_id = $1`, [original.family_id]);
    const next = await refresh(client, tokens.refresh_token);
    await raw.query('delete from story_oauth_tokens where id = $1', [original.id]);
    expect((await tokenRow(next.body.access_token)).family_created_at).toEqual(new Date('2026-01-02T03:04:05Z'));
    const list = await call(connectionsHandler, { method: 'GET' });
    expect(list.body.connections[0].connectedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('8: the per-IP token limit comes from OAUTH_TOKEN_IP_DAILY_LIMIT and logs a warning line on 429', async () => {
    await raw.query(`delete from story_oauth_rate_limits where bucket like 'token:%'`);
    vi.stubEnv('OAUTH_TOKEN_IP_DAILY_LIMIT', '2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i += 1) expect((await exchange({ grant_type: 'password' })).statusCode).toBe(400);
      expect((await exchange({ grant_type: 'password' })).statusCode).toBe(429);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[oauth] token_ip_limit'), expect.anything());
    } finally {
      warn.mockRestore();
      vi.stubEnv('OAUTH_TOKEN_IP_DAILY_LIMIT', '');
      await raw.query(`delete from story_oauth_rate_limits where bucket like 'token:%'`);
    }
    expect(oauth.tokenIpDailyLimit()).toBe(20000);
  });

  it('9: strips invisible filler characters from names', () => {
    expect(clients.cleanDisplayText('AㅤB⠀CᅟᅠﾠD͏')).toBe('ABCD');
  });

  it('10: the allow-lists carry only the new table names', async () => {
    const { STORY_TABLES, STORY_RPCS } = await import('../../lib/story/db.js');
    expect(STORY_TABLES).not.toContain('story_oauth_registrations');
    expect(Object.keys(STORY_RPCS)).not.toContain('story_oauth_registration_take');
    expect(STORY_RPCS.story_oauth_use_access_token).toBe('set');
  });
});
