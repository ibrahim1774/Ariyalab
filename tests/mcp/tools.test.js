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
const { tick, runWorkerJob } = await import('../../lib/story/runner.js');
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
useTestAccounts();

const ISSUER = 'https://app.test';
const RESOURCE = `${ISSUER}/api/mcp`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const TOOL_NAMES = [
  'create_project', 'analyze_reference', 'get_project', 'write_script', 'set_script', 'generate_cast', 'pick_cast',
  'generate_storyboard', 'get_quote', 'generate_video', 'get_status', 'render', 'get_result',
];

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

beforeEach(() => {
  _resetPricingCache();
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
    const fee = (await getPricing()).projectFee;

    const quote = await use(client, 'generate_cast', { project_id: projectId });
    expect(quote.data).toMatchObject({ needs_confirmation: true, quote: { total: fee } });
    const wrong = await use(client, 'generate_cast', { project_id: projectId, confirm_total: fee + 5 });
    expect(wrong).toMatchObject({ isError: true, data: { error: 'quote_changed', quote: { total: fee } } });
    expect(await ledger(user.id)).toHaveLength(1);
    expect(await storyDb().select('story_cast', { project_id: projectId })).toHaveLength(0);
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
  it('goes from a brief to a finished video and ends in a render URL', async () => {
    const user = newUser();
    await fund(user.id, 3000);
    const client = await connect(await tokenFor(user));
    const pricing = await getPricing();

    const created = await use(client, 'create_project', {
      title: 'Barber app', purpose: 'app', offer: 'A booking app for barbers', audience: 'Busy barbers', style: '3d_family', seconds: 15, quality: 'standard',
    });
    expect(created.isError, created.text).toBe(false);
    const projectId = created.data.project.id;

    const script = await use(client, 'write_script', { project_id: projectId });
    expect(script.isError, script.text).toBe(false);
    expect(script.data.script.scenes.length).toBeGreaterThan(0);

    const scene = script.data.script.scenes[0];
    const edited = await use(client, 'set_script', { project_id: projectId, scene_id: scene.id, patch: { title: 'Opening' } });
    expect(edited.isError, edited.text).toBe(false);
    expect(edited.data.script.scenes[0].title).toBe('Opening');

    // The cast: quote, then the confirmed fee.
    const castQuote = await use(client, 'generate_cast', { project_id: projectId });
    expect(castQuote.data).toMatchObject({ needs_confirmation: true, quote: { total: pricing.projectFee } });
    const cast = await use(client, 'generate_cast', { project_id: projectId, confirm_total: pricing.projectFee });
    expect(cast.isError, cast.text).toBe(false);
    expect(cast.data.status_text).toMatch(/get_status/);
    expect(cast.data.credits).toBe(pricing.projectFee);

    await runJobs(projectId);
    let status = await use(client, 'get_status', { project_id: projectId });
    expect(status.isError, status.text).toBe(false);
    expect(status.data.cast.every((c) => c.status === 'ready' && c.pictures.length > 0)).toBe(true);

    for (const c of status.data.cast) {
      const picked = await use(client, 'pick_cast', { project_id: projectId, cast_id: c.id, candidate_index: 0 });
      expect(picked.isError, picked.text).toBe(false);
    }
    await runJobs(projectId);

    // The storyboard: the first call plans the shots and quotes the pictures, the next one starts them.
    const planned = await use(client, 'generate_storyboard', { project_id: projectId });
    expect(planned.isError, planned.text).toBe(false);
    expect(planned.data.shots.length).toBeGreaterThan(0);
    expect(planned.data.quote).toMatchObject({ total: 0 });
    expect(await jobsOf(projectId).then((j) => j.filter((x) => x.kind === 'still'))).toHaveLength(0);
    const stills = await use(client, 'generate_storyboard', { project_id: projectId, confirm_total: 0 });
    expect(stills.isError, stills.text).toBe(false);
    expect(stills.data.status_text).toMatch(/get_status/);
    await runJobs(projectId);

    const quote = await use(client, 'get_quote', { project_id: projectId });
    expect(quote.isError, quote.text).toBe(false);
    expect(quote.data.quote.total).toBeGreaterThan(0);
    const video = await use(client, 'generate_video', { project_id: projectId, confirm_total: quote.data.quote.total });
    expect(video.isError, video.text).toBe(false);
    await runJobs(projectId);

    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.shots).toMatchObject({ total: quote.data.quote.shot_ids.length, with_clip: quote.data.quote.shot_ids.length });

    // The tools have no voice or music step: a render before the narration exists is refused (Task 20 round 1, F1).
    const early = await use(client, 'render', { project_id: projectId });
    expect(early.isError).toBe(true);
    expect(early.data.error).toBe('audio_not_ready');
    // Made on the maker's Voice and sound step: no music, and the narration (the first one is included).
    const { setAudioPlan, generateNarration } = await import('../../lib/story/audio.js');
    await setAudioPlan({ userId: user.id, projectId, plan: { music: { type: 'none' } } });
    await generateNarration({ userId: user.id, projectId, user });
    expect(await runWorkerJob('narration', {})).toMatchObject({ claimed: true, outcome: 'done' });

    const render = await use(client, 'render', { project_id: projectId });
    expect(render.isError, render.text).toBe(false);
    expect(render.data.status_text).toMatch(/get_status|get_result/);
    // What the render worker route does when it is kicked.
    expect(await runWorkerJob('render', {})).toMatchObject({ claimed: true, outcome: 'done' });

    status = await use(client, 'get_status', { project_id: projectId });
    expect(status.data.render).toMatchObject({ status: 'done' });
    const result = await use(client, 'get_result', { project_id: projectId });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.render.url).toMatch(new RegExp(`^${ISSUER}/api/mock/storage/story/${projectId}/render/v1-.*\\.mp4$`));

    // Money: the fee once and the clips at the confirmed quote; nothing left held.
    const b = await getBalance(user.id);
    expect(b.held).toBe(0);
    expect(charged(await ledger(user.id))).toBe(pricing.projectFee + quote.data.quote.total);

    // get_status never shows holds, prompts or internal ids.
    for (const word of ['hold_id', 'gen_claim', 'gen_hold', 'prompt', 'cost_credits', 'payload', 'storage_key', 'job_id', 'pending_shots']) {
      expect(status.text, word).not.toContain(word);
    }
  }, 240_000);
});
