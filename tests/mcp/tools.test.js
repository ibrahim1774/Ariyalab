// Task 26: the MCP server (lib/mcp/server.js, lib/mcp/tools.js, pages/api/mcp.js).
// Every test talks to the real route over HTTP with the SDK's own client, with tokens from the real OAuth flow (Task 25).
// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';

let currentUser = null;
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => (currentUser ? { user: currentUser, supabase: {} } : null)),
}));

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { setStoryDb, storyDb } = await import('../../lib/story/db.js');
const { setCreditsDb, grantCredits, getBalance } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache, getPricing } = await import('../../lib/pricing.js');
const oauth = await import('../../lib/mcp/oauth.js');
const { tick, runWorkerJob, sweep, WORKER_KINDS } = await import('../../lib/story/runner.js');
const { registerMock } = await import('../../lib/providers/mock.js');
const mockFn = (name) => globalThis.__storyProviderMock.registry.get(name);
const { generateCast } = await import('../../lib/story/cast.js');
const { _setMcpRateLimit } = await import('../../lib/mcp/server.js');
const draftRoute = await import('../../pages/api/story/worker/draft.js');
const { draftHandler } = await import('../../lib/story/draftJobs.js');
const { ProviderError } = await import('../../lib/providers/errors.js');
const { sceneSig } = await import('../../lib/story/storyboard.js');
const { quoteGeneration } = await import('../../lib/story/shots.js');
const { RIGHTS_STATEMENT } = await import('../../lib/story/referenceRules.js');
const mcpRoute = await import('../../pages/api/mcp.js');
const { MCP_TOOL_NAMES } = await import('../../lib/mcp/tools.js');
const registerHandler = (await import('../../pages/api/oauth/register.js')).default;
const authorizeHandler = (await import('../../pages/api/oauth/authorize.js')).default;
const tokenHandler = (await import('../../pages/api/oauth/token.js')).default;
const consentPage = await import('../../pages/oauth/consent.js');

useRegexOnlyModeration();
const accounts = useTestAccounts();

const ISSUER = 'https://app.test';
const RESOURCE = `${ISSUER}/api/mcp`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const TOOL_NAMES = [
  'create_project', 'analyze_reference', 'get_project', 'write_script', 'set_script', 'generate_cast', 'pick_cast',
  'generate_storyboard', 'get_quote', 'generate_video', 'make_audio', 'get_status', 'render', 'get_result',
];

// Every model call the story services make, by mock responder name (the drafting tools must make none in the route).
const modelCalls = { story_script: 0, story_cast: 0, story_shots: 0 };
const modelTotal = () => Object.values(modelCalls).reduce((a, b) => a + b, 0);

let raw;
let server;
let url;
const knownUsers = new Map();

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  // The route as Next serves it: the JSON body already parsed into req.body.
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    req.body = text && /json/.test(req.headers['content-type'] || '') ? JSON.parse(text) : text || undefined;
    req.query = {};
    await mcpRoute.default(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/mcp`;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  _resetPricingCache();
  oauth.setOAuthUserLookup(null);
  await raw?.close();
});

beforeEach(async () => {
  _resetPricingCache();
  _setMcpRateLimit(null);
  for (const name of Object.keys(modelCalls)) {
    modelCalls[name] = 0;
    const real = mockFn(name);
    if (!real.__counted) {
      const counted = (input) => {
        modelCalls[name] += 1;
        return real(input);
      };
      counted.__counted = true;
      registerMock(name, counted);
    }
  }
  // runWorkerJob claims from any project: drafts left by an earlier test must not run in this one.
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where kind in ('script', 'narration', 'music', 'render') and status in ('queued', 'running')`);
  vi.stubEnv('APP_URL', ISSUER);
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('VERCEL_ENV', '');
  oauth.setOAuthUserLookup(async (id) => knownUsers.get(id) ?? null);
});
afterEach(() => {
  currentUser = null;
});

// ---------------------------------------------------------------- OAuth: a real grant per user

function fakeReq({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers: { host: 'app.test', ...headers }, socket: { remoteAddress: `198.51.100.${Math.floor(Math.random() * 200) + 1}` } };
}
function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, location: null,
    status(code) { res.statusCode = code; return res; },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    getHeader(name) { return res.headers[name.toLowerCase()]; },
    json(payload) { res.body = payload; return res; },
    send(payload) { res.body = payload; return res; },
    end(payload) { res.body = payload; return res; },
    redirect(code, to) { res.statusCode = code; res.location = to; return res; },
  };
  return res;
}
async function call(handler, opts) {
  const res = fakeRes();
  await handler(fakeReq(opts), res);
  return res;
}

/** Registers a client, consents as `user` and exchanges the code: the access token Claude would hold. */
async function tokenFor(user) {
  knownUsers.set(user.id, { id: user.id });
  const { body: client } = await call(registerHandler, {
    method: 'POST', body: { client_name: 'Claude', redirect_uris: [CALLBACK] }, headers: { 'content-type': 'application/json' },
  });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = {
    response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'story', state: 's', resource: RESOURCE,
  };
  currentUser = user;
  const { props } = await consentPage.getServerSideProps({ req: fakeReq({ query }), res: fakeRes(), query, resolvedUrl: '/oauth/consent' });
  const decided = await call(authorizeHandler, {
    method: 'POST', body: { request_token: props.requestToken, decision: 'allow' },
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ISSUER, 'sec-fetch-site': 'same-origin' },
  });
  currentUser = null;
  const code = new URL(decided.location).searchParams.get('code');
  const exchanged = await call(tokenHandler, {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: client.client_id, resource: RESOURCE },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(exchanged.statusCode, JSON.stringify(exchanged.body)).toBe(200);
  return exchanged.body.access_token;
}

// ---------------------------------------------------------------- MCP client

const clients = [];
afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
});

async function connect(token) {
  const client = new Client({ name: 'tools-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** -> { isError, data } with the tool's JSON answer. */
async function use(client, name, args = {}) {
  const out = await client.callTool({ name, arguments: args });
  const text = out.content?.find((c) => c.type === 'text')?.text;
  return { isError: Boolean(out.isError), data: JSON.parse(text), text };
}

const rpc = (body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});
const TOOLS_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: {} } };

// ---------------------------------------------------------------- fixtures

const newUser = () => ({ id: randomUUID(), email: `u${randomUUID().slice(0, 8)}@example.test` });
const fund = (userId, amount) => grantCredits({ userId, currency: 'video', amount, bucket: 'topup', reason: 'test', ref: randomUUID() });
const SCENE = { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }] };

/** A project on the Generate step: n shots with their pictures, fee unpaid. */
async function generateReady(userId, { n = 3 } = {}) {
  const [project] = await storyDb().insert('story_projects', {
    user_id: userId, title: 'Ready', style: '3d_family', step: 'generate', seconds: 15, quality: 'standard', mode: 'narrated', fee_charged: false,
  });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: [SCENE], source: 'brief' });
  await storyDb().insert('story_shots', Array.from({ length: n }, (_, i) => ({
    project_id: project.id, ord: i, scene_id: 's1', scene_sig: sceneSig(SCENE), description: `Shot ${i + 1} of the shop.`,
    line: null, seconds: 5, quality: 'standard', status: 'still_ready', still_url: `/still/${i}.png`, still_key: `still-${i}`, still_delivered: true,
  })));
  return project;
}

async function ledger(userId) {
  const { rows } = await raw.query('select op, amount, reason from credit_ledger where user_id = $1 order by id', [userId]);
  return rows;
}
const charged = (rows) => rows.filter((r) => r.op === 'settle' || r.op === 'spend').reduce((n, r) => n + r.amount, 0);
const jobsOf = (projectId) => storyDb().select('story_jobs', { project_id: projectId });
const holdsOf = async (userId) => (await raw.query('select id from credit_holds where user_id = $1', [userId])).rows;

/** What the draft worker route does when it is kicked: runs every queued drafting job. -> how many ran */
async function runDrafts() {
  let n = 0;
  while ((await runWorkerJob('script', {})).claimed) n += 1;
  return n;
}
const setFee = async (fee) => {
  await raw.query(`insert into pricing_config (key, value) values ('projectFee', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify(fee)]);
  _resetPricingCache();
};
const clearFee = async () => {
  await raw.query(`delete from pricing_config where key = 'projectFee'`);
  _resetPricingCache();
};

/** A new project with a written script, through the tools. -> projectId */
async function projectWithScript(client, fields = {}) {
  const { data } = await use(client, 'create_project', { title: 'Barber app', purpose: 'app', offer: 'A booking app for barbers', seconds: 15, ...fields });
  const queued = await use(client, 'write_script', { project_id: data.project.id });
  expect(queued.isError, queued.text).toBe(false);
  expect(await runDrafts()).toBe(1);
  return data.project.id;
}

/** Drafts the cast and returns generate_cast's quote answer. */
async function draftCast(client, projectId) {
  const queued = await use(client, 'generate_cast', { project_id: projectId });
  expect(queued.data.drafting, queued.text).toMatchObject({ task: 'cast', status: 'queued' });
  expect(await runDrafts()).toBe(1);
  return use(client, 'generate_cast', { project_id: projectId });
}

let clock = Date.parse('2026-11-16T12:00:00.000Z');
/** What the cron does between polls: runs this project's queued and running jobs with the mock providers. */
async function runJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 8; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
}

// ================================================================ the brief's tests

describe('auth', () => {
  it('a tool call without a valid token is 401 with the resource metadata challenge, and calls nothing', async () => {
    const none = await rpc(TOOLS_CALL);
    expect(none.status).toBe(401);
    const challenge = none.headers.get('www-authenticate');
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
    expect(challenge).toContain('scope="story"');

    const bad = await rpc(TOOLS_CALL, { authorization: 'Bearer not-a-real-token' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');

    // The SDK client cannot even initialize without a token.
    const client = new Client({ name: 'no-token', version: '1.0.0' });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(url)))).rejects.toThrow();
  });

  it('a token for another resource is 401, and a failed user lookup is 503 (the client keeps its tokens)', async () => {
    const user = newUser();
    const token = await tokenFor(user);
    const hash = createHash('sha256').update(token).digest('base64url');
    await raw.query(`update story_oauth_tokens set resource = 'https://other.test/api/mcp' where access_token_hash = $1`, [hash]);
    expect((await rpc(TOOLS_CALL, { authorization: `Bearer ${token}` })).status).toBe(401);

    const fresh = await tokenFor(newUser());
    oauth.setOAuthUserLookup(async () => {
      throw new Error('auth admin down');
    });
    const down = await rpc(TOOLS_CALL, { authorization: `Bearer ${fresh}` });
    expect(down.status).toBe(503);
    expect(down.headers.get('www-authenticate')).toBeNull();
  });

  it('the route stays under the 30 s claim recovery, answers GET and DELETE with 405 after the token, and lists the 13 tools', async () => {
    expect(mcpRoute.config.maxDuration).toBeLessThan(30);
    expect(mcpRoute.config.maxDuration).toBe(25);
    const token = await tokenFor(newUser());
    expect((await fetch(url, { method: 'GET' })).status).toBe(401);
    const get = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(405);

    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect([...MCP_TOOL_NAMES].sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      // The user comes only from the token: no tool takes a user id.
      expect(Object.keys(t.inputSchema.properties || {})).not.toContain('user_id');
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.generate_video.inputSchema.required).toContain('confirm_total');
    expect(byName.get_status.annotations?.readOnlyHint).toBe(true);
    expect(byName.analyze_reference.description).toContain(RIGHTS_STATEMENT);
  });
});

describe('money', () => {
  it('generate_video without confirm_total returns the quote and spends nothing', async () => {
    const user = newUser();
    await fund(user.id, 1000);
    const project = await generateReady(user.id);
    const expected = await quoteGeneration({ userId: user.id, projectId: project.id });
    const client = await connect(await tokenFor(user));
    const before = { ledger: await ledger(user.id), balance: await getBalance(user.id) };

    const out = await use(client, 'generate_video', { project_id: project.id });
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ needs_confirmation: true, quote: { total: expected.total } });
    expect(out.data.quote.lines).toEqual(expected.lines);
    expect(out.data.quote.lines[0]).toEqual({ label: 'Project fee', credits: (await getPricing()).projectFee });
    expect(out.data.next).toContain(`confirm_total: ${expected.total}`);

    expect(await ledger(user.id)).toEqual(before.ledger);
    expect(await getBalance(user.id)).toEqual(before.balance);
    expect(await jobsOf(project.id)).toHaveLength(0);
    expect(await holdsOf(user.id)).toHaveLength(0);
    expect((await storyDb().select('story_projects', { id: project.id }))[0]).toMatchObject({ fee_charged: false, gen_claim_id: null });
  });

  it('a confirm_total that is not the price is quote_changed with the fresh quote, and spends nothing', async () => {
    const user = newUser();
    await fund(user.id, 1000);
    const project = await generateReady(user.id);
    const { total } = await quoteGeneration({ userId: user.id, projectId: project.id });
    const client = await connect(await tokenFor(user));

    const out = await use(client, 'generate_video', { project_id: project.id, confirm_total: total - 1 });
    expect(out.isError).toBe(true);
    expect(out.data).toMatchObject({ error: 'quote_changed', quote: { total } });
    expect(await ledger(user.id)).toHaveLength(1);
    expect(await jobsOf(project.id)).toHaveLength(0);
    expect(await holdsOf(user.id)).toHaveLength(0);

    // The confirmed amount starts the clips at exactly that price.
    const started = await use(client, 'generate_video', { project_id: project.id, confirm_total: total });
    expect(started.isError, started.text).toBe(false);
    expect(started.data).toMatchObject({ project_id: project.id, started: true, credits: total });
    expect(started.data.status_text).toMatch(/get_status/);
    expect((await jobsOf(project.id)).filter((j) => j.kind === 'clip')).toHaveLength(3);
  });

  it('generate_cast with an unpaid project fee returns the quote first and spends nothing; a wrong amount is refused', async () => {
    const user = newUser();
    await fund(user.id, 500);
    const client = await connect(await tokenFor(user));
    const { data: created } = await use(client, 'create_project', { title: 'Fee test', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    const projectId = created.project.id;
    expect((await use(client, 'write_script', { project_id: projectId })).isError).toBe(false);
    await runDrafts();
    const fee = (await getPricing()).projectFee;

    const quote = await draftCast(client, projectId);
    expect(quote.data).toMatchObject({ needs_confirmation: true, quote: { total: fee } });
    expect(quote.data.characters.length).toBeGreaterThan(0);
    const wrong = await use(client, 'generate_cast', { project_id: projectId, confirm_total: fee + 5 });
    expect(wrong).toMatchObject({ isError: true, data: { error: 'quote_changed', quote: { total: fee } } });
    expect(await ledger(user.id)).toHaveLength(1);
    expect(await storyDb().select('story_cast', { project_id: projectId })).toHaveLength(0);
  });

  it('create_project can set consistent_cast false; generate_cast then queues nothing, quotes nothing and spends nothing', async () => {
    const user = newUser();
    await fund(user.id, 500);
    const client = await connect(await tokenFor(user));
    const { data: plain } = await use(client, 'create_project', { title: 'Same people', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    expect(plain.project.consistent_cast).toBe(true);
    const { data: created } = await use(client, 'create_project', { title: 'Different people', purpose: 'app', offer: 'A booking app for barbers', seconds: 15, consistent_cast: false });
    const projectId = created.project.id;
    expect(created.project.consistent_cast).toBe(false);
    const before = (await ledger(user.id)).length;
    const out = await use(client, 'generate_cast', { project_id: projectId });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toMatchObject({ project_id: projectId, credits: 0, cast: [] });
    expect(out.data.drafting).toBeUndefined();
    expect(out.data.status_text).toMatch(/generate_storyboard/);
    expect((await ledger(user.id)).length).toBe(before);
    expect(await storyDb().select('story_cast', { project_id: projectId })).toHaveLength(0);
  });

  it('create_project starts with the brand kit: offer and audience unless given, and the kit pictures attached', async () => {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    await storyDb().insert('story_brand', { user_id: user.id, offer: 'Haircuts that last', audience: 'busy dads' });
    const [pic] = await storyDb().insert('story_assets', { user_id: user.id, kind: 'product_photo', in_brand_kit: true, name: 'bottle', url: '/p/bottle.png' });
    const [other] = await storyDb().insert('story_assets', { user_id: user.id, kind: 'image', in_brand_kit: false, name: 'inset', url: '/p/inset.png' });
    const { data } = await use(client, 'create_project', { title: 'Branded', purpose: 'service' });
    const row = (await storyDb().select('story_projects', { id: data.project.id }))[0];
    expect(row).toMatchObject({ offer: 'Haircuts that last', audience: 'busy dads' });
    expect((await storyDb().select('story_project_assets', { project_id: data.project.id })).map((l) => [l.asset_id, l.role])).toEqual([[pic.id, 'product']]);
    expect(other.id).toBeTruthy();
    const own = await use(client, 'create_project', { title: 'Own words', purpose: 'service', offer: 'Beard trims' });
    expect((await storyDb().select('story_projects', { id: own.data.project.id }))[0]).toMatchObject({ offer: 'Beard trims', audience: 'busy dads' });
  });

  it('analyze_reference needs the rights statement confirmed and refuses anything but a supported link', async () => {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Remake', purpose: 'app', offer: 'A booking app' });
    const projectId = data.project.id;
    const noRights = await use(client, 'analyze_reference', { project_id: projectId, url: 'https://www.tiktok.com/@a/video/1' });
    expect(noRights).toMatchObject({ isError: true, data: { error: 'validation_failed' } });
    const badHost = await use(client, 'analyze_reference', { project_id: projectId, url: 'https://example.com/v.mp4', rights_confirmed: true });
    expect(badHost).toMatchObject({ isError: true, data: { error: 'validation_failed' } });
    expect(await storyDb().select('story_references', { project_id: projectId })).toHaveLength(0);

    const started = await use(client, 'analyze_reference', { project_id: projectId, url: 'https://www.tiktok.com/@a/video/1', rights_confirmed: true });
    expect(started.isError, started.text).toBe(false);
    expect(started.data).toMatchObject({ project_id: projectId, reference: { status: 'pending' } });
    expect(started.data.status_text).toMatch(/get_status/);
  });
});

describe('ownership', () => {
  it('tools cannot reach another user\'s project: every one is not_found and nothing changes there', async () => {
    const alice = newUser();
    const bob = newUser();
    await fund(alice.id, 1000);
    await fund(bob.id, 1000);
    const project = await generateReady(alice.id);
    const { total } = await quoteGeneration({ userId: alice.id, projectId: project.id });
    const bobClient = await connect(await tokenFor(bob));
    const shots = await storyDb().select('story_shots', { project_id: project.id });

    const attempts = [
      ['get_project', {}],
      ['analyze_reference', { url: 'https://www.tiktok.com/@a/video/1', rights_confirmed: true }],
      ['write_script', {}],
      ['set_script', { scene_id: 's1', patch: { title: 'Taken over' } }],
      ['generate_cast', { confirm_total: 90 }],
      ['pick_cast', { cast_id: randomUUID(), candidate_index: 0 }],
      ['generate_storyboard', { confirm_total: 0 }],
      ['get_quote', {}],
      ['generate_video', { confirm_total: total }],
      ['make_audio', { confirm_total: 0 }],
      ['get_status', {}],
      ['render', {}],
      ['get_result', {}],
    ];
    for (const [name, args] of attempts) {
      const out = await use(bobClient, name, { project_id: project.id, ...args });
      expect(out, name).toMatchObject({ isError: true, data: { error: 'not_found' } });
      expect(out.text, name).not.toContain('Shot 1 of the shop');
    }
    // The user id is never taken from the arguments.
    const spoofed = await use(bobClient, 'get_project', { project_id: project.id, user_id: alice.id });
    expect(spoofed.isError).toBe(true);

    expect(await ledger(alice.id)).toHaveLength(1);
    expect(await ledger(bob.id)).toHaveLength(1);
    expect(await jobsOf(project.id)).toHaveLength(0);
    expect(await storyDb().select('story_shots', { project_id: project.id })).toEqual(shots);
    expect((await storyDb().select('story_scripts', { project_id: project.id }))).toHaveLength(1);
    expect(await storyDb().select('story_references', { project_id: project.id })).toHaveLength(0);
    expect(await storyDb().select('story_renders', { project_id: project.id })).toHaveLength(0);

    // Bob's own list does not show Alice's project.
    const list = await use(bobClient, 'get_project', {});
    expect(list.data.projects.map((p) => p.id)).not.toContain(project.id);
  });
});

describe('a full mock sequence through the tools', () => {
  it('goes from a brief to a finished narrated video and ends in a render URL', async () => {
    const user = newUser();
    await fund(user.id, 3000);
    const client = await connect(await tokenFor(user));
    const pricing = await getPricing();

    const created = await use(client, 'create_project', {
      title: 'Barber app', purpose: 'app', offer: 'A booking app for barbers', audience: 'Busy barbers', style: '3d_family', seconds: 15, quality: 'standard',
    });
    expect(created.isError, created.text).toBe(false);
    const projectId = created.data.project.id;

    // The script is written by the draft worker, not inside the request.
    const writing = await use(client, 'write_script', { project_id: projectId });
    expect(writing.data).toMatchObject({ project_id: projectId, drafting: { task: 'write', status: 'queued' } });
    expect(writing.data.status_text).toMatch(/get_status/);
    expect(modelTotal()).toBe(0);
    expect(await runDrafts()).toBe(1);
    let status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.script).toMatchObject({ task: 'write', status: 'ready' });
    const project = await use(client, 'get_project', { project_id: projectId });
    const scene = project.data.summary.script.scenes[0];
    const edited = await use(client, 'set_script', { project_id: projectId, scene_id: scene.id, patch: { title: 'Opening' } });
    expect(edited.isError, edited.text).toBe(false);
    expect(edited.data.script.scenes[0].title).toBe('Opening');

    // The cast: drafted in the background, then quoted, then the confirmed fee.
    const castQuote = await draftCast(client, projectId);
    expect(castQuote.data).toMatchObject({ needs_confirmation: true, quote: { total: pricing.projectFee } });
    const cast = await use(client, 'generate_cast', { project_id: projectId, confirm_total: pricing.projectFee });
    expect(cast.isError, cast.text).toBe(false);
    expect(cast.data.status_text).toMatch(/get_status/);
    expect(cast.data.credits).toBe(pricing.projectFee);

    await runJobs(projectId);
    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.isError, status.text).toBe(false);
    expect(status.data.cast.every((c) => c.status === 'ready' && c.pictures.length > 0)).toBe(true);
    for (const c of status.data.cast) {
      const picked = await use(client, 'pick_cast', { project_id: projectId, cast_id: c.id, candidate_index: 0 });
      expect(picked.isError, picked.text).toBe(false);
    }
    await runJobs(projectId);

    // The storyboard: the plan is drafted in the background; the next call starts the (included) pictures.
    const planning = await use(client, 'generate_storyboard', { project_id: projectId });
    expect(planning.data).toMatchObject({ drafting: { task: 'shots', status: 'queued' } });
    expect(modelCalls.story_shots).toBe(0);
    expect(await runDrafts()).toBe(1);
    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.shot_plan).toMatchObject({ status: 'ready' });
    const stills = await use(client, 'generate_storyboard', { project_id: projectId });
    expect(stills.isError, stills.text).toBe(false);
    expect(stills.data).toMatchObject({ credits: 0 });
    expect(stills.data.started).toBeGreaterThan(0);
    await runJobs(projectId);


    const quote = await use(client, 'get_quote', { project_id: projectId });
    expect(quote.isError, quote.text).toBe(false);
    expect(quote.data.quote.total).toBeGreaterThan(0);
    const video = await use(client, 'generate_video', { project_id: projectId, confirm_total: quote.data.quote.total });
    expect(video.isError, video.text).toBe(false);
    await runJobs(projectId);

    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.shots).toMatchObject({ total: quote.data.quote.shot_ids.length, with_clip: quote.data.quote.shot_ids.length });

    // A render before the narration exists is refused (Task 20 round 1, F1); make_audio is the way through.
    const early = await use(client, 'render', { project_id: projectId });
    expect(early).toMatchObject({ isError: true, data: { error: 'audio_not_ready' } });

    // Narration and music: included, so they start at once.
    const audio = await use(client, 'make_audio', { project_id: projectId, music_prompt: 'Warm acoustic guitar' });
    expect(audio.isError, audio.text).toBe(false);
    expect(audio.data).toMatchObject({ started: ['narration', 'music'], credits: 0 });
    // What the audio worker route does when it is kicked.
    expect(await runWorkerJob('narration', {})).toMatchObject({ claimed: true, outcome: 'done' });
    expect(await runWorkerJob('music', {})).toMatchObject({ claimed: true, outcome: 'done' });
    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.audio).toEqual({ narration: 'ready', music: 'ready' });

    const render = await use(client, 'render', { project_id: projectId });
    expect(render.isError, render.text).toBe(false);
    expect(render.data.status_text).toMatch(/get_status|get_result/);
    // What the render worker route does when it is kicked.
    expect(await runWorkerJob('render', {})).toMatchObject({ claimed: true, outcome: 'done' });

    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.render).toMatchObject({ status: 'done' });
    const result = await use(client, 'get_result', { project_id: projectId });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.render.url).toMatch(new RegExp(`^${ISSUER}/api/mock/storage/story/${projectId}/render/[0-9a-f-]{36}/[a-z0-9-]+-v1\\.mp4$`));
    // The video was made with the narration make_audio made.
    const [row] = await storyDb().select('story_renders', { project_id: projectId });
    expect(row.settings).toMatchObject({ mode: 'narrated', music: true });
    expect(row.settings.narrationUrl).toBeTruthy();

    // Money: the fee once and the clips at the confirmed quote; nothing left held.
    const b = await getBalance(user.id);
    expect(b.held).toBe(0);
    expect(charged(await ledger(user.id))).toBe(pricing.projectFee + quote.data.quote.total);

    // get_status never shows holds, prompts, the drafting payload or internal ids.
    for (const word of ['hold_id', 'gen_claim', 'gen_hold', 'prompt', 'cost_credits', 'payload', 'storage_key', 'job_id', 'pending_shots', 'receipt', 'counters']) {
      expect(status.text, word).not.toContain(word);
    }
  }, 240_000);
});

describe('round 1: drafting runs in the draft worker, never in /api/mcp', () => {
  it('write_script, set_script with an instruction, generate_cast and generate_storyboard only queue; the worker drafts and get_status shows it', async () => {
    const user = newUser();
    await fund(user.id, 2000);
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Queued', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    const projectId = data.project.id;

    for (const [name, args, task, label] of [
      ['write_script', {}, 'write', 'script'],
      ['set_script', { instruction: 'Make the opening funnier' }, 'revise', 'script'],
      ['generate_cast', {}, 'cast', 'cast'],
    ]) {
      const before = modelTotal();
      const out = await use(client, name, { project_id: projectId, ...args });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.drafting, name).toEqual({ task, status: 'queued' });
      expect(modelTotal(), `${name} called the model inside the request`).toBe(before);
      // A second draft while one waits is refused, and nothing more is queued.
      const busy = await use(client, 'write_script', { project_id: projectId });
      expect(busy).toMatchObject({ isError: true, data: { error: 'drafting_busy' } });
      let status = await use(client, 'get_status', { project_id: projectId });
      expect(status.data.drafts[label]).toMatchObject({ task, status: 'queued' });
      expect(await runDrafts()).toBe(1);
      expect(modelTotal()).toBeGreaterThan(before);
      status = await use(client, 'get_status', { project_id: projectId });
      expect(status.data.drafts[label]).toEqual({ task, status: 'ready' });
    }
    // The revise made a new script version; the cast draft is ready and nothing was charged or saved for it yet.
    expect((await storyDb().select('story_scripts', { project_id: projectId })).length).toBe(2);
    expect(await storyDb().select('story_cast', { project_id: projectId })).toHaveLength(0);
    expect(await ledger(user.id)).toHaveLength(1);

    const fee = (await getPricing()).projectFee;
    await use(client, 'generate_cast', { project_id: projectId, confirm_total: fee });
    await runJobs(projectId);
    const { data: s } = await use(client, 'get_status', { project_id: projectId });
    for (const c of s.cast) await use(client, 'pick_cast', { project_id: projectId, cast_id: c.id, candidate_index: 0 });
    await runJobs(projectId);
    const before = modelTotal();
    const plan = await use(client, 'generate_storyboard', { project_id: projectId });
    expect(plan.data.drafting).toEqual({ task: 'shots', status: 'queued' });
    expect(modelTotal()).toBe(before);
    expect(await storyDb().select('story_shots', { project_id: projectId })).toHaveLength(0);
    expect(await runDrafts()).toBe(1);
    expect(modelCalls.story_shots).toBe(1);
    expect((await storyDb().select('story_shots', { project_id: projectId })).length).toBeGreaterThan(0);
  });

  it('the draft worker route needs the cron secret and runs one drafting job; script is a worker kind', async () => {
    expect(draftRoute.config.maxDuration).toBe(300);
    expect(WORKER_KINDS).toContain('script');
    const call = async (authorization) => {
      const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await draftRoute.default({ method: 'POST', headers: authorization ? { authorization } : {} }, res);
      return res;
    };
    expect((await call()).statusCode).toBe(401);
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Route', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    await use(client, 'write_script', { project_id: data.project.id });
    const res = await call(`Bearer ${process.env.CRON_SECRET}`);
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, draft: 1 } });
    expect(await storyDb().select('story_scripts', { project_id: data.project.id })).toHaveLength(1);
  });

  it('a drafting job killed mid-run gives the free-tier count back; a refused draft does too', async () => {
    accounts.set({ paid: false });
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Killed', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    const projectId = data.project.id;
    const count = async () => Number((await raw.query(
      `select coalesce(sum(count), 0)::int as n from story_usage where user_id = $1 and action like 'script_write%'`, [user.id],
    )).rows[0].n);

    expect((await use(client, 'write_script', { project_id: projectId })).isError).toBe(false);
    expect(await count()).toBe(1);
    // The worker dies twice mid-draft (the claim is taken, the run never ends): the sweep retries once, then fails it.
    const [job] = await storyDb().select('story_jobs', { project_id: projectId, kind: 'script' });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await raw.query(`update story_jobs set status = 'running', attempts = $2, started_at = now() - interval '1 hour', run_after = null where id = $1`, [job.id, attempt]);
      await sweep({ now: new Date(Date.now() + 60_000) });
    }
    const [ended] = await storyDb().select('story_jobs', { id: job.id });
    expect(ended.status).toBe('failed');
    expect(await count()).toBe(0);
    const status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.script).toMatchObject({ task: 'write', status: 'failed' });
    expect(status.text).not.toContain('receipt');

    // A draft the service refuses (no brief to write from) is a result, not a retry, and gives the count back too.
    const { data: empty } = await use(client, 'create_project', { title: 'Empty brief' });
    expect((await use(client, 'write_script', { project_id: empty.project.id })).isError).toBe(false);
    expect(await count()).toBe(1);
    await runDrafts();
    expect(await count()).toBe(0);
    const refused = await use(client, 'get_status', { project_id: empty.project.id });
    expect(refused.data.drafts.script).toMatchObject({ status: 'failed', error: 'validation_failed' });
  });
});

describe('round 1: money', () => {
  it('O1: a fee changed between the quote and the confirm is quote_changed with nothing charged; a fee changed during the model call charges the confirmed fee', async () => {
    try {
      const user = newUser();
      await fund(user.id, 5000);
      const client = await connect(await tokenFor(user));
      const projectId = await projectWithScript(client);
      const quote = await draftCast(client, projectId);
      expect(quote.data.quote.total).toBe(90);
      await setFee(120);
      const late = await use(client, 'generate_cast', { project_id: projectId, confirm_total: 90 });
      expect(late).toMatchObject({ isError: true, data: { error: 'quote_changed', quote: { total: 120 } } });
      expect(await ledger(user.id)).toHaveLength(1);
      expect(await storyDb().select('story_cast', { project_id: projectId })).toHaveLength(0);
      // Confirmed at the new price: exactly that is charged, and the answer says what was spent.
      const ok = await use(client, 'generate_cast', { project_id: projectId, confirm_total: 120 });
      expect(ok.data.credits).toBe(120);
      expect(charged(await ledger(user.id))).toBe(120);

      // The website path (the model asked inside generateCast): the fee moves while the model writes.
      await setFee(90);
      const web = newUser();
      await fund(web.id, 5000);
      const webClient = await connect(await tokenFor(web));
      const webProject = await projectWithScript(webClient);
      const real = mockFn('story_cast');
      registerMock('story_cast', async (input) => {
        await setFee(500);
        return real(input);
      });
      let out;
      try {
        out = await generateCast({ userId: web.id, projectId: webProject, expectedCredits: 90 });
      } finally {
        registerMock('story_cast', real);
      }
      expect(out.charged).toBe(90);
      expect(charged(await ledger(web.id))).toBe(90);
    } finally {
      await clearFee();
    }
  });

  it('a3: the fee raised while the characters are drafted is quoted, never charged unseen', async () => {
    try {
      const user = newUser();
      await fund(user.id, 5000);
      const client = await connect(await tokenFor(user));
      const projectId = await projectWithScript(client);
      await use(client, 'generate_cast', { project_id: projectId });
      const real = mockFn('story_cast');
      registerMock('story_cast', async (input) => {
        await setFee(500);
        return real(input);
      });
      try {
        await runDrafts();
      } finally {
        registerMock('story_cast', real);
      }
      const old = await use(client, 'generate_cast', { project_id: projectId, confirm_total: 90 });
      expect(old).toMatchObject({ isError: true, data: { error: 'quote_changed', quote: { total: 500 } } });
      expect(await ledger(user.id)).toHaveLength(1);
      const quote = await use(client, 'generate_cast', { project_id: projectId });
      expect(quote.data.quote.total).toBe(500);
    } finally {
      await clearFee();
    }
  });

  it('a7: a fee already in the ledger (a request died after the spend) is not quoted or reported again', async () => {
    const { spendCredits } = await import('../../lib/credits.js');
    const user = newUser();
    await fund(user.id, 5000);
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    await spendCredits({ userId: user.id, currency: 'video', amount: 90, reason: 'story_project_fee', ref: `project-fee:${projectId}`, projectId });
    await use(client, 'generate_cast', { project_id: projectId });
    await runDrafts();
    // Nothing is due: it starts at once and reports 0 spent.
    const out = await use(client, 'generate_cast', { project_id: projectId });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toMatchObject({ credits: 0 });
    expect(out.data.needs_confirmation).toBeUndefined();
    expect(charged(await ledger(user.id))).toBe(90);
    expect((await storyDb().select('story_projects', { id: projectId }))[0].fee_charged).toBe(true);
  });

  it('Om5: paid storyboard pictures are quoted, a wrong amount is quote_changed, and the confirmed total is held', async () => {
    const user = newUser();
    await fund(user.id, 1000);
    const [project] = await storyDb().insert('story_projects', {
      user_id: user.id, title: 'Paid pictures', style: '3d_family', step: 'storyboard', seconds: 15, quality: 'standard', mode: 'narrated', fee_charged: true,
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: [SCENE], source: 'brief' });
    await storyDb().insert('story_shots', [0, 1].map((i) => ({
      project_id: project.id, ord: i, scene_id: 's1', scene_sig: sceneSig(SCENE), description: `Shot ${i + 1} of the shop.`,
      seconds: 5, quality: 'standard', status: 'draft', still_delivered: true,
    })));
    const price = 2 * (await getPricing()).stillReroll;
    expect(price).toBeGreaterThan(0);
    const client = await connect(await tokenFor(user));
    const quote = await use(client, 'generate_storyboard', { project_id: project.id });
    expect(quote.data).toMatchObject({ needs_confirmation: true, quote: { total: price } });
    const wrong = await use(client, 'generate_storyboard', { project_id: project.id, confirm_total: price - 1 });
    expect(wrong).toMatchObject({ isError: true, data: { error: 'quote_changed', quote: { total: price } } });
    expect(await jobsOf(project.id)).toHaveLength(0);
    expect((await getBalance(user.id)).held).toBe(0);
    const ok = await use(client, 'generate_storyboard', { project_id: project.id, confirm_total: price });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.data).toMatchObject({ credits: price, started: 2 });
    expect((await getBalance(user.id)).held).toBe(price);
  });

  it('Om5: generate_video confirmed twice with the same total charges once', async () => {
    const user = newUser();
    await fund(user.id, 1000);
    const project = await generateReady(user.id);
    const { total } = await quoteGeneration({ userId: user.id, projectId: project.id });
    const client = await connect(await tokenFor(user));
    const [first, second] = await Promise.all([
      use(client, 'generate_video', { project_id: project.id, confirm_total: total }),
      use(client, 'generate_video', { project_id: project.id, confirm_total: total }),
    ]);
    expect([first.isError, second.isError].sort()).toEqual([false, true]);
    const again = await use(client, 'generate_video', { project_id: project.id, confirm_total: total });
    expect(again.isError).toBe(true);
    await runJobs(project.id);
    expect(charged(await ledger(user.id))).toBe(total);
    expect((await getBalance(user.id)).held).toBe(0);
    expect((await jobsOf(project.id)).filter((j) => j.kind === 'clip')).toHaveLength(3);
  });

  it('make_audio quotes paid makes, refuses a wrong amount, starts at the confirmed total, and will not use another customer\'s voice', async () => {
    const user = newUser();
    await fund(user.id, 1000);
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    // The included makes are used up, so both parts are priced.
    await storyDb().update('story_projects', { id: projectId }, { narrations_used: 10, music_used: 10 });
    const quote = await use(client, 'make_audio', { project_id: projectId });
    expect(quote.data).toMatchObject({ needs_confirmation: true });
    const total = quote.data.quote.total;
    expect(total).toBeGreaterThan(0);
    expect(quote.data.voices.length).toBeGreaterThan(0);
    const wrong = await use(client, 'make_audio', { project_id: projectId, confirm_total: total + 1 });
    expect(wrong).toMatchObject({ isError: true, data: { error: 'quote_changed', quote: { total } } });
    expect(await jobsOf(projectId).then((j) => j.filter((x) => x.kind === 'narration' || x.kind === 'music'))).toHaveLength(0);
    expect((await getBalance(user.id)).held).toBe(0);

    const other = newUser();
    const [voice] = await storyDb().insert('story_voices', { user_id: other.id, name: 'Theirs', provider: 'fish', status: 'ready', provider_voice_id: 'their-voice', consent_statement: 'x', consent_at: new Date().toISOString() });
    // Their row id (a UUID) goes through audio.js's owner check; their provider id is not one of this customer's voices either.
    for (const voiceId of [voice.id, voice.provider_voice_id]) {
      const stolen = await use(client, 'make_audio', { project_id: projectId, voice_id: voiceId });
      expect(stolen, voiceId).toMatchObject({ isError: true, data: { error: 'not_found' } });
    }
    expect((await storyDb().select('story_projects', { id: projectId }))[0].audio_plan?.voiceId).not.toBe(voice.id);

    const ok = await use(client, 'make_audio', { project_id: projectId, confirm_total: total });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.data).toMatchObject({ started: ['narration', 'music'], credits: total });
    expect((await getBalance(user.id)).held).toBe(total);
  });
});

describe('round 1: the route', () => {
  it('F2: a JSON-RPC batch is 400 and runs nothing; more requests than the per-user limit is 429 with Retry-After', async () => {
    const user = newUser();
    const token = await tokenFor(user);
    const H = { authorization: `Bearer ${token}` };
    const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_project', arguments: { title: 'Batch' } } });
    const batch = await rpc([call(1), call(2)], H);
    expect(batch.status).toBe(400);
    expect(await storyDb().select('story_projects', { user_id: user.id })).toHaveLength(0);

    _setMcpRateLimit(3);
    const second = await tokenFor(newUser());
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await rpc(TOOLS_CALL, { authorization: `Bearer ${second}` })).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    const limited = await rpc(TOOLS_CALL, { authorization: `Bearer ${second}` });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('Fm4: a tools/call with malformed params is a readable validation_failed tool error', async () => {
    const token = await tokenFor(newUser());
    for (const params of [{ name: 5 }, { name: 'get_project', arguments: 'x' }, null]) {
      const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params }, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(7);
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toMatchObject({ error: 'validation_failed' });
    }
  });

  it('Fm1: a token without the story scope is 401', async () => {
    const token = await tokenFor(newUser());
    const hash = createHash('sha256').update(token).digest('base64url');
    await raw.query(`update story_oauth_tokens set scope = 'other' where access_token_hash = $1`, [hash]);
    const res = await rpc(TOOLS_CALL, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('Fm3 and Fm5: NUL characters are dropped from text, and the project list is the newest 50', async () => {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const out = await use(client, 'create_project', { title: '\u0000Barber\u0000 app', offer: 'A booking\u0000 app' });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.project).toMatchObject({ title: 'Barber app', offer: 'A booking app' });
    await storyDb().insert('story_projects', Array.from({ length: 55 }, (_, i) => ({ user_id: user.id, title: `P${i}` })));
    const list = await use(client, 'get_project', {});
    expect(list.data.projects).toHaveLength(50);
    expect(Object.keys(list.data.projects[0]).sort()).toEqual(['id', 'status', 'step', 'title', 'updated_at']);
  });
});

describe('round 2', () => {
  const usage = async (userId, prefix) => Number((await raw.query(
    `select coalesce(sum(count), 0)::int as n from story_usage where user_id = $1 and action like $2`, [userId, `${prefix}%`],
  )).rows[0].n);
  const draftJob = async (projectId) => (await storyDb().select('story_jobs', { project_id: projectId, kind: 'script' }, { order: '-created_at', limit: 1 }))[0];

  it('S1: onFail and onDone run again give the count back once', async () => {
    accounts.set({ paid: false });
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Once', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    const projectId = data.project.id;
    await use(client, 'write_script', { project_id: projectId });
    // Two writes counted today (one earlier, one by this draft), so a second give-back would show.
    await raw.query(`update story_usage set count = count + 1 where user_id = $1 and action like 'script_write%'`, [user.id]);
    expect(await usage(user.id, 'script_write')).toBe(2);
    const job = await draftJob(projectId);
    await draftHandler.onFail(job);
    await draftHandler.onFail(job);
    await draftHandler.onDone(job, { error: { code: 'x', message: 'x' } });
    expect(await usage(user.id, 'script_write')).toBe(1);
    expect((await draftJob(projectId)).allowance_returned_at).toBeTruthy();
  });

  it('S2/T1: a retry of a draft that died after saving does not write again, and shows the saved version as ready', async () => {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    const versions = async () => (await storyDb().select('story_scripts', { project_id: projectId })).length;
    expect(await versions()).toBe(1);
    // A first attempt never skips: running the finished write's job again is not a retry, so it is script_changed.
    const written = await draftJob(projectId);
    expect(await draftHandler.run({ ...written, attempts: 1 })).toEqual({ error: { code: 'script_changed', message: 'The script changed while this was waiting. Ask again.' } });

    await use(client, 'set_script', { project_id: projectId, instruction: 'Make the opening funnier' });
    const revise = await draftJob(projectId);
    // The run saves v2 and dies before the runner records it; the sweep puts it back; the retry finds its own v2.
    await draftHandler.run({ ...revise, attempts: 1 });
    expect(await versions()).toBe(2);
    await raw.query(`update story_jobs set status = 'running', attempts = 1, started_at = now() - interval '6 minutes', run_after = null where id = $1`, [revise.id]);
    await sweep({ now: new Date() });
    expect((await draftJob(projectId)).status).toBe('queued');
    // Past the retry backoff.
    await raw.query(`update story_jobs set run_after = null where id = $1`, [revise.id]);
    expect(await runDrafts()).toBe(1);
    expect(await versions()).toBe(2);
    expect((await draftJob(projectId)).result).toMatchObject({ script_version: 2, already_saved: true });
    const status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.script).toEqual({ task: 'revise', status: 'ready' });
    expect(modelCalls.story_script).toBe(2);
  });

  it('T1: a revise queued before the customer edited a scene is applied to the latest version', async () => {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    await use(client, 'set_script', { project_id: projectId, instruction: 'Make the opening funnier' });
    const { data } = await use(client, 'get_project', { project_id: projectId });
    const scene = data.summary.script.scenes[0];
    const edited = await use(client, 'set_script', { project_id: projectId, scene_id: scene.id, patch: { title: 'Edited while waiting' } });
    expect(edited.data.script.version).toBe(2);
    expect(await runDrafts()).toBe(1);
    const latest = (await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 }))[0];
    expect(latest).toMatchObject({ version: 3, source: 'revision', instruction: 'Make the opening funnier' });
    // Applied on top of the edit: the edited title is still there (the mock keeps titles it does not change).
    expect(latest.scenes[0].title).toBe('Edited while waiting');
    const status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.script).toEqual({ task: 'revise', status: 'ready' });
  });

  it('T1: any other skip ends as script_changed and gives the count back', async () => {
    accounts.set({ paid: false });
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Forced', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    const projectId = data.project.id;
    await use(client, 'write_script', { project_id: projectId });
    expect(await usage(user.id, 'script_write')).toBe(1);
    const job = await draftJob(projectId);
    // A version carrying this job's id before its first attempt ran.
    await storyDb().insert('story_scripts', { project_id: projectId, version: 1, scenes: [SCENE], source: 'brief', draft_job_id: job.id });
    expect(await runDrafts()).toBe(1);
    expect(await storyDb().select('story_scripts', { project_id: projectId })).toHaveLength(1);
    const status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.script).toMatchObject({ status: 'failed', error: 'script_changed', message: 'The script changed while this was waiting. Ask again.' });
    expect(await usage(user.id, 'script_write')).toBe(0);
  });

  it('S3: a killed draft is retried after the worker limit, not 10 minutes; a retried plan takes one storyboard build count', async () => {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const { data } = await use(client, 'create_project', { title: 'Stuck', purpose: 'app', offer: 'A booking app for barbers', seconds: 15 });
    await use(client, 'write_script', { project_id: data.project.id });
    const job = await draftJob(data.project.id);
    await raw.query(`update story_jobs set status = 'running', attempts = 1, started_at = now() - interval '6 minutes', run_after = null where id = $1`, [job.id]);
    await sweep({ now: new Date() });
    expect((await draftJob(data.project.id)).status).toBe('queued');

    await fund(user.id, 2000);
    const projectId = await projectWithScript(client);
    await draftCast(client, projectId);
    await use(client, 'generate_cast', { project_id: projectId, confirm_total: (await getPricing()).projectFee });
    await runJobs(projectId);
    const { data: st } = await use(client, 'get_status', { project_id: projectId });
    for (const c of st.cast) await use(client, 'pick_cast', { project_id: projectId, cast_id: c.id, candidate_index: 0 });
    await runJobs(projectId);
    await use(client, 'generate_storyboard', { project_id: projectId });
    expect(await usage(user.id, 'shots_build')).toBe(1);
    const plan = await draftJob(projectId);
    expect(plan.payload.task).toBe('shots');
    await draftHandler.run(plan);
    // The run died after the plan was saved and is run again: no second count, and the first one is kept.
    await draftHandler.run(plan);
    expect(await usage(user.id, 'shots_build')).toBe(1);
    expect(modelCalls.story_shots).toBe(1);
  });

  it('S5: two cast confirms at once charge the fee once and only one reports it', async () => {
    const user = newUser();
    await fund(user.id, 2000);
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    await draftCast(client, projectId);
    const fee = (await getPricing()).projectFee;
    const outs = await Promise.all([1, 2].map(() => use(client, 'generate_cast', { project_id: projectId, confirm_total: fee })));
    const reported = outs.filter((o) => !o.isError).map((o) => o.data.credits);
    expect(reported.reduce((a, b) => a + b, 0)).toBe(fee);
    expect(charged(await ledger(user.id))).toBe(fee);
  });

  it('S5: the request that loses the cast insert race reports 0 spent', async () => {
    const user = newUser();
    await fund(user.id, 2000);
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    await use(client, 'generate_cast', { project_id: projectId });
    await runDrafts();
    const [job] = await storyDb().select('story_jobs', { project_id: projectId, kind: 'script' }, { order: '-created_at', limit: 1 });
    const drafted = { characters: job.result.characters, scriptId: job.result.script_id };
    const fee = (await getPricing()).projectFee;
    // Both read the fee as due before either inserts the characters; the loser hits the unique index.
    const outs = await Promise.all([1, 2].map(() => generateCast({ userId: user.id, projectId, expectedCredits: fee, drafted })));
    expect(outs.map((o) => o.charged).sort((a, b) => a - b)).toEqual([0, fee]);
    expect(charged(await ledger(user.id))).toBe(fee);
  });

  it('S6: generate_storyboard reports the previous failed plan when it plans again', async () => {
    const user = newUser();
    await fund(user.id, 2000);
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    await use(client, 'generate_storyboard', { project_id: projectId });
    const real = mockFn('story_shots');
    registerMock('story_shots', () => ({ shots: [] }));
    try {
      await runDrafts();
    } finally {
      registerMock('story_shots', real);
    }
    const status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.drafts.shot_plan).toMatchObject({ status: 'failed' });
    const again = await use(client, 'generate_storyboard', { project_id: projectId });
    expect(again.isError, again.text).toBe(false);
    expect(again.data.previous_attempt).toMatchObject({ task: 'shots', status: 'failed' });
    expect(again.data.drafting).toEqual({ task: 'shots', status: 'queued' });
  });
});

describe('round 3: the storyboard build count across retries', () => {
  const usage = async (userId) => Number((await raw.query(
    `select coalesce(sum(count), 0)::int as n from story_usage where user_id = $1 and action like 'shots_build%'`, [userId],
  )).rows[0].n);
  const planJob = async (projectId) => (await storyDb().select('story_jobs', { project_id: projectId, kind: 'script' }, { order: '-created_at', limit: 1 }))[0];

  async function queuedPlan() {
    const user = newUser();
    const client = await connect(await tokenFor(user));
    const projectId = await projectWithScript(client);
    const out = await use(client, 'generate_storyboard', { project_id: projectId });
    expect(out.data.drafting).toEqual({ task: 'shots', status: 'queued' });
    // A second build counted today, so a double give-back would show.
    await raw.query(`update story_usage set count = count + 1 where user_id = $1 and action like 'shots_build%'`, [user.id]);
    expect(await usage(user.id)).toBe(2);
    return { user, projectId };
  }

  it('T2: two failures before the model was asked give the count back exactly once, by the job', async () => {
    const { user, projectId } = await queuedPlan();
    const job = await planJob(projectId);
    // Fails before the model each time (the shots are busy): the service keeps the count, the job gives it back once.
    await storyDb().insert('story_shots', { project_id: projectId, ord: 0, scene_id: 's9', description: 'x', seconds: 3, quality: 'standard', status: 'still_pending' });
    const results = [];
    for (const attempts of [1, 2]) {
      const result = await draftHandler.run({ ...job, attempts });
      expect(result.error?.code).toBe('shots_busy');
      expect(result.model_asked).toBeUndefined();
      results.push(result);
    }
    // The service gave nothing back itself.
    expect(await usage(user.id)).toBe(2);
    // The hooks may run more than once: the count goes back exactly once.
    for (const result of results) await draftHandler.onDone(job, result);
    await draftHandler.onFail(job);
    expect(await usage(user.id)).toBe(1);
  });

  it('T2: a plan that failed after the model was asked keeps the count, on every later hook', async () => {
    const { user, projectId } = await queuedPlan();
    const job = await planJob(projectId);
    const real = mockFn('story_shots');
    registerMock('story_shots', () => {
      throw new ProviderError('failed', 'The model is down.');
    });
    try {
      await expect(draftHandler.run({ ...job, attempts: 1 })).rejects.toThrow();
    } finally {
      registerMock('story_shots', real);
    }
    expect((await planJob(projectId)).payload.model_asked).toBe(true);
    // The retry fails early this time; the earlier attempt asked the model, so nothing goes back.
    await storyDb().insert('story_shots', { project_id: projectId, ord: 0, scene_id: 's9', description: 'x', seconds: 3, quality: 'standard', status: 'still_pending' });
    const retry = await draftHandler.run({ ...(await planJob(projectId)), attempts: 2 });
    expect(retry.error?.code).toBe('shots_busy');
    await draftHandler.onDone(job, retry);
    await draftHandler.onFail(job);
    expect(await usage(user.id)).toBe(2);
  });
});
