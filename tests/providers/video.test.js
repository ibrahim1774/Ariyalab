import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QUALITIES,
  buildClipRequest,
  clampSeconds,
  getClip,
  parseCallback,
  submitClip,
} from '../../lib/providers/video.js';
import { ProviderError } from '../../lib/providers/errors.js';
import { _resetMocks } from '../../lib/providers/mock.js';

function kieOk(data) {
  return new Response(JSON.stringify({ code: 200, msg: 'success', data }), { status: 200 });
}

function useRealMode() {
  vi.stubEnv('STORY_MOCK', '0');
  vi.stubEnv('KIE_API_KEY', 'test-kie-key');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetMocks();
});

describe('QUALITIES', () => {
  it('lists the four quality levels in order', () => {
    expect(QUALITIES).toEqual(['economy', 'standard', 'pro_narrated', 'pro_talking']);
  });
});

describe('clampSeconds', () => {
  it('clamps Kling qualities to 3..15 and rounds up', () => {
    expect(clampSeconds('pro_narrated', 1)).toBe(3);
    expect(clampSeconds('pro_narrated', 4.2)).toBe(5);
    expect(clampSeconds('pro_talking', 40)).toBe(15);
    expect(clampSeconds('pro_talking', 'nope')).toBe(3);
  });

  it('clamps Gemini Omni (standard) to 3..15 and rounds up', () => {
    expect(clampSeconds('standard', 1)).toBe(3);
    expect(clampSeconds('standard', 4.2)).toBe(5);
    expect(clampSeconds('standard', 40)).toBe(15);
    expect(clampSeconds('standard', 'nope')).toBe(3);
  });

  it('clamps Seedance (economy) to 4..15', () => {
    expect(clampSeconds('economy', 3)).toBe(4);
    expect(clampSeconds('economy', 9.1)).toBe(10);
    expect(clampSeconds('economy', 99)).toBe(15);
  });
});

describe('submitClip request bodies', () => {
  let calls;
  beforeEach(() => {
    useRealMode();
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return kieOk({ taskId: 'task-123' });
    }));
  });

  const base = {
    imageUrl: 'https://cdn.example.com/still.png',
    prompt: 'A baker slides a tray of bread into the oven',
    seconds: 5,
    aspect: '9:16',
    callbackUrl: 'https://app.example.com/api/story/callback/kie',
  };

  it('economy: Seedance 2.0 Mini 720p, audio on, still as first frame', async () => {
    const out = await submitClip({ ...base, quality: 'economy' });
    expect(out).toEqual({ provider: 'kie', taskId: 'task-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.kie.ai/api/v1/jobs/createTask');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-kie-key');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: 'bytedance/seedance-2-mini',
      callBackUrl: base.callbackUrl,
      input: {
        prompt: base.prompt,
        first_frame_url: base.imageUrl,
        resolution: '720p',
        duration: '5',
        aspect_ratio: '9:16',
        generate_audio: true,
      },
    });
  });

  it('standard: Gemini Omni 1.2 Flash 1080p, audio on (no flag), still as first frame', async () => {
    await submitClip({ ...base, quality: 'standard' });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: 'google/gemini-omni-flash-1-2',
      callBackUrl: base.callbackUrl,
      input: {
        prompt: base.prompt,
        first_frame_url: base.imageUrl,
        duration: 5,
        resolution: '1080p',
        aspect_ratio: '9:16',
      },
    });
  });

  it('standard: reference images go in image_urls (up to 6) only when there is no first frame', () => {
    const els = [
      { name: 'a', description: 'x', imageUrls: ['https://a/1.png', 'https://a/2.png', 'https://a/3.png', 'https://a/4.png'] },
      { name: 'b', description: 'y', imageUrls: ['https://b/1.png', 'https://b/2.png', 'https://b/3.png'] },
    ];
    const withStill = buildClipRequest({ ...base, quality: 'standard', elements: els });
    expect(withStill.input.first_frame_url).toBe(base.imageUrl);
    expect(withStill.input).not.toHaveProperty('image_urls');
    const noStill = buildClipRequest({ ...base, imageUrl: undefined, quality: 'standard', elements: els });
    expect(noStill.input).not.toHaveProperty('first_frame_url');
    expect(noStill.input.image_urls).toHaveLength(6);
  });

  it('standard: a short shot is made at the 3 second minimum', () => {
    expect(buildClipRequest({ ...base, quality: 'standard', seconds: 1 }).input.duration).toBe(3);
  });

  it('pro_narrated: Kling 3.0 std 720p, sound on', async () => {
    await submitClip({ ...base, quality: 'pro_narrated' });
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe('kling-3.0/video');
    expect(body.input.mode).toBe('std');
    expect(body.input.sound).toBe(true);
  });

  it('pro_talking: Kling 3.0 pro 1080p, sound on, with character elements', async () => {
    await submitClip({
      ...base,
      quality: 'pro_talking',
      prompt: '@mia waves at the camera',
      elements: [{ name: 'mia', description: 'the baker', imageUrls: ['https://a/1.png', 'https://a/2.png'] }],
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: 'kling-3.0/video',
      callBackUrl: base.callbackUrl,
      input: {
        prompt: '@mia waves at the camera',
        image_urls: [base.imageUrl],
        duration: '5',
        aspect_ratio: '9:16',
        mode: 'pro',
        sound: true,
        multi_shots: false,
        kling_elements: [
          { name: 'mia', description: 'the baker', element_input_urls: ['https://a/1.png', 'https://a/2.png'] },
        ],
      },
    });
  });

  it('omits callBackUrl when none is given', () => {
    const req = buildClipRequest({ ...base, callbackUrl: undefined, quality: 'standard' });
    expect(req).not.toHaveProperty('callBackUrl');
  });

  it('rejects elements with fewer than 2 or more than 4 images, or more than 3 elements', () => {
    const one = [{ name: 'a', description: 'a', imageUrls: ['https://a/1.png'] }];
    expect(() => buildClipRequest({ ...base, quality: 'pro_narrated', elements: one })).toThrow(ProviderError);
    const four = Array.from({ length: 4 }, (_, i) => ({
      name: `c${i}`, description: 'x', imageUrls: ['https://a/1.png', 'https://a/2.png'],
    }));
    expect(() => buildClipRequest({ ...base, quality: 'pro_narrated', elements: four })).toThrow(ProviderError);
  });

  it('rejects an unknown quality', async () => {
    await expect(submitClip({ ...base, quality: 'ultra' })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('submitClip error mapping', () => {
  beforeEach(useRealMode);

  it('maps a kie rate limit inside an HTTP 200 body to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 429, msg: 'The request rate exceeds the limit' }), { status: 200 },
    )));
    const err = await submitClip({ quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('rate_limited');
    expect(err.message).not.toMatch(/kie|kling/i);
  });

  it('maps HTTP 429 to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    await expect(submitClip({ quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 }))
      .rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('maps other errors to failed with the raw detail only on .cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 500, msg: 'internal kie stack trace xyz' }), { status: 200 },
    )));
    const err = await submitClip({ quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 })
      .catch((e) => e);
    expect(err.code).toBe('failed');
    expect(err.message).not.toContain('xyz');
    expect(String(err.cause?.message)).toContain('xyz');
  });

  it('throws config naming KIE_API_KEY when the key is missing', async () => {
    vi.stubEnv('KIE_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = await submitClip({ quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 })
      .catch((e) => e);
    expect(err.code).toBe('config');
    expect(err.message).toContain('KIE_API_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('getClip (real mode)', () => {
  beforeEach(useRealMode);

  it('maps kie recordInfo states', async () => {
    const records = [
      { taskId: 't', state: 'generating' },
      { taskId: 't', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn/out.mp4'] }) },
      { taskId: 't', state: 'fail', failCode: '500', failMsg: 'internal error' },
      { taskId: 't', state: 'fail', failCode: '400', failMsg: 'The content violates our sensitive content policy' },
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => kieOk(records[i++])));
    expect(await getClip({ provider: 'kie', taskId: 't' })).toMatchObject({ status: 'pending', url: null });
    expect(await getClip({ provider: 'kie', taskId: 't' })).toMatchObject({ status: 'done', url: 'https://cdn/out.mp4' });
    expect(await getClip({ provider: 'kie', taskId: 't' })).toMatchObject({ status: 'failed' });
    expect(await getClip({ provider: 'kie', taskId: 't' })).toMatchObject({ status: 'blocked' });
  });
});

describe('kie calls for the story pipeline', () => {
  beforeEach(useRealMode);

  it('read the endpoint from config and carry a timeout signal', async () => {
    const { PROVIDER_CONFIG } = await import('../../lib/providers/config.js');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return kieOk({ taskId: 't', state: 'success', resultJson: JSON.stringify({ videos: [{ url: 'https://cdn/v0.mp4' }] }) });
    }));
    await submitClip({ quality: 'standard', imageUrl: 'https://x/a.png', prompt: 'p', seconds: 5 });
    expect(calls[0].url).toBe(`${PROVIDER_CONFIG.kie.baseUrl}${PROVIDER_CONFIG.kie.createPath}`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    // shares the legacy result-url extractor, including the videos[0] shape
    expect(await getClip({ provider: 'kie', taskId: 't' })).toMatchObject({ status: 'done', url: 'https://cdn/v0.mp4' });
    expect(calls[1].url).toBe(`${PROVIDER_CONFIG.kie.baseUrl}${PROVIDER_CONFIG.kie.recordPath}?taskId=t`);
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not treat a technical "violates" failure as a content block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => kieOk({ taskId: 't', state: 'fail', failCode: '422', failMsg: 'image size violates minimum dimensions' })));
    expect((await getClip({ provider: 'kie', taskId: 't' })).status).toBe('failed');
  });
});

describe('parseCallback', () => {
  it('maps a kie success payload', () => {
    const body = {
      code: 200,
      msg: 'Playground task completed successfully.',
      data: {
        taskId: 'task_kling-3.0_1',
        model: 'kling-3.0/video',
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: ['https://cdn/video.mp4'] }),
      },
    };
    expect(parseCallback('kie', body)).toEqual({
      taskId: 'task_kling-3.0_1', status: 'done', url: 'https://cdn/video.mp4', error: null,
    });
  });

  it('maps a kie failure payload to failed with a generic message', () => {
    const body = {
      code: 501,
      msg: 'Playground task failed.',
      data: { taskId: 't2', state: 'fail', failCode: '500', failMsg: 'GPU node crashed' },
    };
    const out = parseCallback('kie', body);
    expect(out).toMatchObject({ taskId: 't2', status: 'failed', url: null });
    expect(out.error).toBeTruthy();
    expect(out.error).not.toContain('GPU');
  });

  it('maps a kie content refusal to blocked', () => {
    const body = {
      code: 501,
      data: { taskId: 't3', state: 'fail', failCode: '400', failMsg: 'Prompt flagged as NSFW by moderation' },
    };
    const out = parseCallback('kie', body);
    expect(out.status).toBe('blocked');
    expect(out.error).not.toMatch(/nsfw|moderation/i);
  });

  it('accepts a JSON string body', () => {
    const body = JSON.stringify({ data: { taskId: 't4', state: 'success', resultJson: '{"resultUrls":["https://c/v.mp4"]}' } });
    expect(parseCallback('kie', body)).toMatchObject({ taskId: 't4', status: 'done' });
  });
});

describe('mock mode', () => {
  it('submit returns mock task ids and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const a = await submitClip({ quality: 'standard', imageUrl: '/mock/still.png', prompt: 'hello', seconds: 5 });
    const b = await submitClip({ quality: 'economy', imageUrl: '/mock/still.png', prompt: 'hello', seconds: 5 });
    expect(a).toEqual({ provider: 'mock', taskId: 'mock-clip-1' });
    expect(b).toEqual({ provider: 'mock', taskId: 'mock-clip-2' });
    expect(await getClip(a)).toMatchObject({ status: 'pending', url: null });
    expect(await getClip(a)).toMatchObject({ status: 'done', url: '/api/mock/fixtures/clip.mp4' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours the [[mock:blocked]] and [[mock:fail]] tokens', async () => {
    const blocked = await submitClip({ quality: 'standard', prompt: 'x [[mock:blocked]]', seconds: 5 });
    const failed = await submitClip({ quality: 'standard', prompt: 'x [[mock:fail]]', seconds: 5 });
    expect((await getClip(blocked)).status).toBe('pending');
    expect((await getClip(failed)).status).toBe('pending');
    expect(await getClip(blocked)).toMatchObject({ status: 'blocked', url: null });
    expect(await getClip(failed)).toMatchObject({ status: 'failed', url: null });
    expect(blocked.taskId).toMatch(/^mock-clip-\d+/);
  });
});
