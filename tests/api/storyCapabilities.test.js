import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock';

let currentUser = null;
vi.mock('../../lib/supabaseServer.js', () => ({
  getUserFromRequest: async () => (currentUser ? { user: currentUser, supabase: {} } : null),
}));

const { storyCapabilities } = await import('../../lib/providers/capabilities.js');
const handler = (await import('../../pages/api/story/capabilities.js')).default;

afterEach(() => {
  vi.unstubAllEnvs();
  currentUser = null;
});

function noKeys() {
  vi.stubEnv('STORY_MOCK', '0');
  for (const k of ['APIFY_TOKEN', 'SCRAPECREATORS_API_KEY', 'GROQ_API_KEY', 'REPLICATE_API_TOKEN']) vi.stubEnv(k, '');
}

describe('storyCapabilities', () => {
  it('is all false with no provider keys', () => {
    noKeys();
    expect(storyCapabilities()).toEqual({ linkDownload: false, transcription: false });
  });

  it('each feature follows its own keys', () => {
    noKeys();
    vi.stubEnv('SCRAPECREATORS_API_KEY', 'sc-key');
    expect(storyCapabilities()).toEqual({ linkDownload: true, transcription: false });
    vi.stubEnv('SCRAPECREATORS_API_KEY', '');
    vi.stubEnv('APIFY_TOKEN', 'ap-key');
    vi.stubEnv('REPLICATE_API_TOKEN', 'rep-key');
    expect(storyCapabilities()).toEqual({ linkDownload: true, transcription: true });
    vi.stubEnv('APIFY_TOKEN', '');
    vi.stubEnv('REPLICATE_API_TOKEN', '');
    vi.stubEnv('GROQ_API_KEY', 'groq-key');
    expect(storyCapabilities()).toEqual({ linkDownload: false, transcription: true });
  });

  it('mock mode has everything', () => {
    vi.stubEnv('STORY_MOCK', '1');
    expect(storyCapabilities()).toEqual({ linkDownload: true, transcription: true });
  });
});

describe('GET /api/story/capabilities', () => {
  it('needs a signed-in user and answers with booleans only, never a key', async () => {
    noKeys();
    vi.stubEnv('APIFY_TOKEN', 'ap-secret-value');
    let res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(401);
    currentUser = { id: 'u1', email: 'a@example.test' };
    res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ linkDownload: true, transcription: false });
    expect(JSON.stringify(res.body)).not.toContain('ap-secret-value');
    res = makeRes();
    await handler(makeReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
  });
});
