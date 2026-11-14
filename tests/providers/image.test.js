import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildImageRequest, getImage, submitImage } from '../../lib/providers/image.js';
import { _resetMocks } from '../../lib/providers/mock.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetMocks();
});

describe('buildImageRequest', () => {
  it('uses the kie Nano Banana model with up to 8 references', () => {
    const refs = Array.from({ length: 10 }, (_, i) => `https://r/${i}.png`);
    expect(buildImageRequest({ prompt: 'a cosy bakery', refs, aspect: '9:16', size: '2K' })).toEqual({
      model: 'nano-banana-pro',
      input: {
        prompt: 'a cosy bakery',
        image_input: refs.slice(0, 8),
        aspect_ratio: '9:16',
        resolution: '2K',
        output_format: 'png',
      },
    });
  });

  it('defaults to 9:16 and the configured size', () => {
    const req = buildImageRequest({ prompt: 'p' });
    expect(req.input.aspect_ratio).toBe('9:16');
    expect(req.input.resolution).toBe('2K');
    expect(req.input.image_input).toEqual([]);
  });
});

describe('submitImage / getImage (real mode)', () => {
  it('posts to createTask and maps recordInfo', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('KIE_API_KEY', 'k');
    const fetchSpy = vi.fn(async (url) => {
      if (String(url).includes('createTask')) {
        return new Response(JSON.stringify({ code: 200, data: { taskId: 'img-1' } }));
      }
      return new Response(JSON.stringify({
        code: 200,
        data: { taskId: 'img-1', state: 'success', resultJson: '{"resultUrls":["https://cdn/i.png"]}' },
      }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    expect(await submitImage({ prompt: 'p', refs: ['https://r/1.png'] })).toEqual({ provider: 'kie', taskId: 'img-1' });
    expect(await getImage({ provider: 'kie', taskId: 'img-1' })).toEqual({
      status: 'done', url: 'https://cdn/i.png', error: null,
    });
    expect(String(fetchSpy.mock.calls[1][0])).toBe('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=img-1');
  });
});

describe('mock mode', () => {
  it('returns a fixture still after one pending poll, without network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = await submitImage({ prompt: 'a cast sheet' });
    expect(t).toEqual({ provider: 'mock', taskId: 'mock-image-1' });
    expect((await getImage(t)).status).toBe('pending');
    expect(await getImage(t)).toEqual({ status: 'done', url: '/api/mock/fixtures/still.png', error: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours [[mock:blocked]]', async () => {
    const t = await submitImage({ prompt: '[[mock:blocked]] something' });
    expect((await getImage(t)).status).toBe('pending');
    const out = await getImage(t);
    expect(out.status).toBe('blocked');
    expect(out.url).toBeNull();
    expect(out.error).toBeTruthy();
  });
});
