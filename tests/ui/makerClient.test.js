// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../lib/story/client';

afterEach(() => vi.unstubAllGlobals());

function stub(status, body) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('lib/story/client', () => {
  it('sends a PATCH with a JSON body and returns the saved project', async () => {
    const fn = stub(200, { project: { id: 'p1', quality: 'pro_talking', mode: 'talking' } });
    const project = await client.updateProject('p1', { quality: 'pro_talking', mode: 'talking' });
    expect(project.mode).toBe('talking');
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/story/projects/p1');
    expect(init.method).toBe('PATCH');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ quality: 'pro_talking', mode: 'talking' });
  });

  it('calls each route with the method and body the contract gives', async () => {
    const fn = stub(200, {});
    await client.getStatus('p1');
    await client.writeScript('p1');
    await client.reviseScript('p1', 'Funnier');
    await client.updateScene('p1', 's1', { visual: 'x' });
    await client.startCast('p1');
    await client.startCast('p1', 45);
    await client.regenCast('p1', 'c1', 'glasses');
    await client.pickCast('p1', 'c1', 2);
    await client.buildShots('p1');
    await client.makeStills('p1', ['s1']);
    await client.updateShot('p1', 's1', { quality: 'standard' });
    await client.getQuote('p1', ['s1']);
    await client.startGeneration('p1', ['s1'], 700);
    await client.rerollShot('p1', 's1');
    const calls = fn.mock.calls.map(([url, init]) => [init.method, url.replace('/api/story/projects/p1', ''), init.body ? JSON.parse(init.body) : undefined]);
    expect(calls).toEqual([
      ['GET', '/status', undefined],
      ['POST', '/script', {}],
      ['POST', '/revise', { instruction: 'Funnier' }],
      ['PATCH', '/scene', { sceneId: 's1', patch: { visual: 'x' } }],
      ['POST', '/cast', {}],
      ['POST', '/cast', { expected_credits: 45 }],
      ['POST', '/cast-regen', { castId: 'c1', note: 'glasses' }],
      ['POST', '/cast-pick', { castId: 'c1', candidateIndex: 2 }],
      ['POST', '/shots', {}],
      ['POST', '/stills', { shotIds: ['s1'] }],
      ['PATCH', '/shot', { shotId: 's1', patch: { quality: 'standard' } }],
      ['POST', '/quote', { shotIds: ['s1'] }],
      ['POST', '/generate', { shotIds: ['s1'], confirmTotal: 700 }],
      ['POST', '/reroll', { shotId: 's1' }],
    ]);
  });

  it('throws a typed error from a story error body', async () => {
    stub(409, { error: 'conflict', message: 'Another action is in progress.' });
    await expect(client.makeStills('p1')).rejects.toMatchObject({ name: 'StoryApiError', status: 409, code: 'conflict', message: 'Another action is in progress.' });
  });

  it('reads credits off a 402', async () => {
    stub(402, { error: 'insufficient_credits', needed: 300, available: 120 });
    await expect(client.startGeneration('p1', ['s1'], 300)).rejects.toMatchObject({ status: 402, code: 'insufficient_credits', needed: 300, available: 120 });
  });

  it('reads the moderation shape, where error is the message and code is the code', async () => {
    stub(400, { error: 'That text cannot be used.', code: 'BLOCKED_NSFW', category: 'sexual' });
    await expect(client.createProject({ title: 'x' })).rejects.toMatchObject({ status: 400, code: 'BLOCKED_NSFW', message: 'That text cannot be used.' });
  });

  it('keeps the field of a 422', async () => {
    stub(422, { error: 'validation_failed', message: 'offer is too long.', field: 'offer' });
    await expect(client.updateProject('p1', { offer: 'x' })).rejects.toMatchObject({ status: 422, field: 'offer' });
  });

  it('treats a sentence in error as the message', async () => {
    stub(401, { error: 'Authentication required.' });
    await expect(client.getBilling()).rejects.toMatchObject({ status: 401, code: '', message: 'Authentication required.' });
  });

  it('reports a request that never arrived as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(client.getProject('p1')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('survives a body that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('no json'); } })));
    await expect(client.getProject('p1')).rejects.toMatchObject({ status: 502 });
  });

  it('unwraps lists and nulls', async () => {
    stub(200, { projects: [{ id: 'a' }] });
    expect(await client.listProjects()).toEqual([{ id: 'a' }]);
    stub(200, { script: null });
    expect(await client.getScript('p1')).toBeNull();
  });
});
