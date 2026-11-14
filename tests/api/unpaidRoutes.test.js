import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setMockEnv } from '../helpers/mockEnv';
import {
  USER_A,
  USER_B,
  makeReq,
  makeRes,
  signIn,
  signOut,
  setCredits,
  getCredits,
  setMetadata,
  getMetadata,
  historyUpserts,
  replicateMocks,
  kieMocks,
  seedanceMocks,
  moderationMocks,
  resetApiMocks,
} from '../helpers/apiMock';
import { KEY } from '../../lib/metaKeys';
import { FACE_SWAP_COST } from '../../lib/cost';

vi.mock('../../lib/supabaseServer', async () => (await import('../helpers/apiMock')).supabaseServerModule);
vi.mock('../../lib/stripe', async () => (await import('../helpers/apiMock')).stripeModule);
vi.mock('../../lib/meta', () => ({ sendCapiEvent: async () => {} }));
vi.mock('../../lib/replicate', async (importOriginal) => ({
  ...(await importOriginal()),
  ...(await import('../helpers/apiMock')).replicateMocks,
}));
vi.mock('../../lib/kie', async (importOriginal) => ({
  ...(await importOriginal()),
  ...(await import('../helpers/apiMock')).kieMocks,
}));
vi.mock('../../lib/seedance', async () => (await import('../helpers/apiMock')).seedanceMocks);
vi.mock('../../lib/moderation', async (importOriginal) => ({
  ...(await importOriginal()),
  ...(await import('../helpers/apiMock')).moderationMocks,
}));

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() {
      this.messages = { create: anthropicCreate };
    }
  },
}));

const handleUpload = vi.fn(async ({ body, onBeforeGenerateToken }) => {
  if (body.type === 'blob.generate-client-token') {
    const { pathname, clientPayload, multipart } = body.payload;
    const options = await onBeforeGenerateToken(pathname, clientPayload, multipart);
    return { type: body.type, clientToken: 'fake-client-token', options };
  }
  return { type: body.type, response: 'ok' };
});
vi.mock('@vercel/blob/client', () => ({ handleUpload }));

const { signJobId, verifyJobId, signSwapToken, verifySwapToken } = await import('../../lib/jobToken');
const swap = (await import('../../pages/api/swap')).default;
const characterFrame = (await import('../../pages/api/character-frame')).default;
const uploadToken = (await import('../../pages/api/upload-token')).default;
const moderateImage = (await import('../../pages/api/moderate-image')).default;
const status = (await import('../../pages/api/status')).default;
const ugcImage = (await import('../../pages/api/ugc-image')).default;
const ugcAnimate = (await import('../../pages/api/ugc-animate')).default;
const imageToVideo = (await import('../../pages/api/image-to-video')).default;
const planEdits = (await import('../../pages/api/video/plan-edits')).default;
const extractFrame = (await import('../../pages/api/extract-frame')).default;

const VIDEO_URL = 'https://blob.example.test/source.mp4';
const FRAME_URL = 'https://blob.example.test/frame0.jpg';
const FACE_URL = 'https://blob.example.test/face.jpg';
const HYBRID_URL = 'https://replicate.delivery/hybrid.jpg';

async function call(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

function frameSucceeds(url = HYBRID_URL) {
  replicateMocks.getPrediction.mockImplementation(async (id) =>
    id === 'frame-pred-1' ? { status: 'succeeded', output: url } : { status: 'processing' }
  );
}

async function runCharacterFrame(extra = {}) {
  return call(characterFrame, {
    body: { firstFrameUrl: FRAME_URL, referenceImageUrl: FACE_URL, sourceVideoUrl: VIDEO_URL, swapMode: 'face', ...extra },
  });
}

// Run outside the test runner's key fallback with no CRON_SECRET.
function unsetSigningSecret() {
  delete process.env.CRON_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.STORY_MOCK = '1'; // mock mode alone must not unlock the fallback key
}

// Frame succeeds; motion jobs get ids swap-pred-1, -2, ... with statuses
// taken from `swapStatuses` (default 'processing').
function stageSwaps(swapStatuses = {}) {
  let n = 0;
  replicateMocks.createMotionTransferPrediction.mockImplementation(async () => ({
    id: `swap-pred-${++n}`,
    status: 'starting',
  }));
  replicateMocks.getPrediction.mockImplementation(async (id) => {
    if (id === 'frame-pred-1') return { status: 'succeeded', output: HYBRID_URL };
    return { status: swapStatuses[id] || 'processing' };
  });
}

beforeEach(() => {
  resetApiMocks();
  handleUpload.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMockEnv();
});

describe('lib/jobToken', () => {
  it('round-trips a job id for the same user only', () => {
    const signed = signJobId('user-a', 'pred.with.dots');
    expect(signed.startsWith('pred.with.dots.')).toBe(true);
    expect(verifyJobId('user-a', signed)).toBe('pred.with.dots');
    expect(verifyJobId('user-b', signed)).toBeNull();
    expect(verifyJobId('user-a', 'pred.with.dots')).toBeNull();
    expect(verifyJobId('user-a', `${signed}x`)).toBeNull();
  });

  it('a job id signature is not accepted as a swap token', () => {
    const signed = signJobId('user-a', 'frame-pred-1');
    expect(verifySwapToken(signed, { userId: 'user-a', videoUrl: VIDEO_URL })).toBeNull();
  });

  it('falls back to a test key only when NODE_ENV is test', () => {
    delete process.env.CRON_SECRET;
    expect(process.env.NODE_ENV).toBe('test');
    expect(verifyJobId('user-a', signJobId('user-a', 'p1'))).toBe('p1');
  });

  it('refuses to sign without CRON_SECRET outside tests, even with STORY_MOCK=1', () => {
    unsetSigningSecret();
    expect(() => signJobId('user-a', 'p1')).toThrow();
    expect(() => signSwapToken({ userId: 'user-a', videoUrl: VIDEO_URL, framePredictionId: 'p1' })).toThrow();
  });
});

describe('/api/swap', () => {
  it('with zero credits and no charge token returns 402 and does not call Replicate', async () => {
    signIn(USER_A);
    setCredits(0);
    const res = await call(swap, { body: { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL } });
    expect(res.statusCode).toBe(402);
    expect(replicateMocks.createMotionTransferPrediction).not.toHaveBeenCalled();
  });

  it('with zero credits the face-swap flow stops at character-frame with 402', async () => {
    signIn(USER_A);
    setCredits(0);
    const res = await runCharacterFrame();
    expect(res.statusCode).toBe(402);
    expect(replicateMocks.createCharacterFramePrediction).not.toHaveBeenCalled();
  });

  it('charges FACE_SWAP_COST once across character-frame, swap and a failed-job retry', async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    expect(frame.statusCode).toBe(200);
    expect(typeof frame.body.swapToken).toBe('string');
    expect(getCredits()).toBe(500 - FACE_SWAP_COST);

    stageSwaps({ 'swap-pred-1': 'failed' });
    const body = { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken };
    const first = await call(swap, { body });
    const retry = await call(swap, { body });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(verifyJobId(USER_A.id, first.body.predictionId)).toBe('swap-pred-1');
    expect(verifyJobId(USER_A.id, retry.body.predictionId)).toBe('swap-pred-2');
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledTimes(2);
    expect(getCredits()).toBe(500 - FACE_SWAP_COST);
  });

  it('a second call while the first job runs returns the same id and creates nothing', async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    stageSwaps();
    const body = { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken };
    const first = await call(swap, { body });
    const again = await call(swap, { body });
    expect(again.statusCode).toBe(200);
    expect(again.body.predictionId).toBe(first.body.predictionId);
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledTimes(1);
  });

  it('a call after the job succeeded returns that job and creates nothing', async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    stageSwaps({ 'swap-pred-1': 'succeeded' });
    const body = { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken };
    await call(swap, { body });
    const again = await call(swap, { body });
    expect(verifyJobId(USER_A.id, again.body.predictionId)).toBe('swap-pred-1');
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledTimes(1);
  });

  it('refuses a fourth job for one frame even after three failures', async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    stageSwaps({ 'swap-pred-1': 'failed', 'swap-pred-2': 'canceled', 'swap-pred-3': 'failed' });
    const body = { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken };
    for (let i = 0; i < 3; i += 1) expect((await call(swap, { body })).statusCode).toBe(200);
    const fourth = await call(swap, { body });
    expect(fourth.statusCode).toBe(402);
    expect(fourth.body.code).toBe('SWAP_RETRY_LIMIT');
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledTimes(3);
  });

  it("runs the token's mode, not the body's", async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame({ mode: 'std' });
    stageSwaps();
    await call(swap, {
      body: { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken, mode: 'pro' },
    });
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'std' })
    );
  });

  it('a pro token runs pro', async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame({ mode: 'pro' });
    stageSwaps();
    await call(swap, { body: { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken } });
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pro' })
    );
  });

  it.each([
    ['another user', { user: USER_B }],
    ['a different video', { videoUrl: 'https://blob.example.test/other.mp4' }],
    ['an image that is not the paid frame', { imageUrl: 'https://replicate.delivery/other.jpg' }],
    ['a tampered token', { tamper: true }],
  ])('rejects a token used with %s (402, no Replicate call)', async (_label, { user, videoUrl, imageUrl, tamper }) => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    frameSucceeds();
    signIn(user || USER_A);
    const token = tamper ? `${frame.body.swapToken.slice(0, -2)}xx` : frame.body.swapToken;
    const res = await call(swap, {
      body: { imageUrl: imageUrl || HYBRID_URL, videoUrl: videoUrl || VIDEO_URL, swapToken: token },
    });
    expect(res.statusCode).toBe(402);
    expect(replicateMocks.createMotionTransferPrediction).not.toHaveBeenCalled();
  });

  it('rejects a token after its 30 minute lifetime', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z') });
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    frameSucceeds();
    vi.setSystemTime(new Date('2026-11-14T10:31:00Z'));
    const res = await call(swap, {
      body: { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken },
    });
    expect(res.statusCode).toBe(402);
    expect(replicateMocks.createMotionTransferPrediction).not.toHaveBeenCalled();
  });

  it('rejects while the paid frame has not finished', async () => {
    signIn(USER_A);
    setCredits(500);
    const frame = await runCharacterFrame();
    const res = await call(swap, {
      body: { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: frame.body.swapToken },
    });
    expect(res.statusCode).toBe(402);
    expect(replicateMocks.createMotionTransferPrediction).not.toHaveBeenCalled();
  });

  it('refuses when CRON_SECRET is unset outside tests', async () => {
    signIn(USER_A);
    unsetSigningSecret();
    const res = await call(swap, { body: { imageUrl: HYBRID_URL, videoUrl: VIDEO_URL, swapToken: 'x.y' } });
    expect(res.statusCode).toBe(503);
    expect(replicateMocks.createMotionTransferPrediction).not.toHaveBeenCalled();
  });
});

describe('/api/upload-token', () => {
  const tokenRequest = (clientPayload) => ({
    body: {
      type: 'blob.generate-client-token',
      payload: { pathname: 'photo.jpg', clientPayload, multipart: false },
    },
  });

  it('without a session returns 401', async () => {
    signOut();
    const res = await call(uploadToken, tokenRequest(null));
    expect(res.statusCode).toBe(401);
    expect(handleUpload).not.toHaveBeenCalled();
  });

  it("without a session but surface 'anon-image' gets a 5-minute, 25 MB photo-only token", async () => {
    signOut();
    const before = Date.now();
    const res = await call(uploadToken, tokenRequest(JSON.stringify({ surface: 'anon-image' })));
    expect(res.statusCode).toBe(200);
    expect(res.body.options.maximumSizeInBytes).toBe(25 * 1024 * 1024);
    expect(res.body.options.allowedContentTypes).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
    const ttl = res.body.options.validUntil - before;
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('ignores a malformed client payload (401 when signed out)', async () => {
    signOut();
    const res = await call(uploadToken, tokenRequest('{not json'));
    expect(res.statusCode).toBe(401);
  });

  it('signed-in callers keep the 1 GB image and video limits', async () => {
    signIn(USER_A);
    const res = await call(uploadToken, tokenRequest(JSON.stringify({ surface: 'anon-image' })));
    expect(res.statusCode).toBe(200);
    expect(res.body.options.maximumSizeInBytes).toBe(1024 * 1024 * 1024);
    expect(res.body.options.allowedContentTypes).toEqual(['video/*', 'image/*']);
    expect(res.body.options.validUntil).toBeUndefined();
  });

  it('passes Vercel upload-completed callbacks (no session cookie) to handleUpload', async () => {
    signOut();
    const res = await call(uploadToken, { body: { type: 'blob.upload-completed', payload: {} } });
    expect(res.statusCode).toBe(200);
    expect(handleUpload).toHaveBeenCalledTimes(1);
  });
});

describe('/api/moderate-image', () => {
  it('without a session returns 401 and makes no classifier call', async () => {
    signOut();
    const res = await call(moderateImage, { body: { url: FACE_URL } });
    expect(res.statusCode).toBe(401);
    expect(moderationMocks.screenImage).not.toHaveBeenCalled();
  });

  it('with a session screens the image', async () => {
    signIn(USER_A);
    const res = await call(moderateImage, { body: { url: FACE_URL } });
    expect(res.statusCode).toBe(200);
    expect(moderationMocks.screenImage).toHaveBeenCalledWith(FACE_URL);
  });
});

describe('/api/status', () => {
  const poll = (predictionId, extra = {}) =>
    call(status, { method: 'GET', query: { predictionId, ...extra } });

  it('without a session returns 401', async () => {
    signOut();
    const res = await poll(signJobId(USER_A.id, 'image-pred-1'));
    expect(res.statusCode).toBe(401);
  });

  it('an unsigned id returns 404 without calling the provider', async () => {
    signIn(USER_A);
    const res = await poll('image-pred-1');
    expect(res.statusCode).toBe(404);
    expect(replicateMocks.getPrediction).not.toHaveBeenCalled();
  });

  it('an id signed for another user returns 404', async () => {
    signIn(USER_A);
    const res = await poll(signJobId(USER_B.id, 'image-pred-1'));
    expect(res.statusCode).toBe(404);
    expect(replicateMocks.getPrediction).not.toHaveBeenCalled();
  });

  it('a correctly signed id proceeds with the raw id', async () => {
    signIn(USER_A);
    replicateMocks.getPrediction.mockImplementation(async () => ({ status: 'succeeded', output: HYBRID_URL }));
    const signed = signJobId(USER_A.id, 'image-pred-1');
    const res = await poll(signed, { historyKind: 'ugc' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('complete');
    expect(res.body.predictionId).toBe(signed);
    expect(replicateMocks.getPrediction).toHaveBeenCalledWith('image-pred-1');
    expect(historyUpserts[0].prediction_id).toBe('image-pred-1');
  });

  it('refunds a failed kie job keyed on the raw id', async () => {
    signIn(USER_A);
    setCredits(100);
    setMetadata({ [KEY.pendingJobs]: 'kling-task-1:50' });
    kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'fail', failMsg: 'boom' }));
    const res = await poll(signJobId(USER_A.id, 'kling-task-1'), { vendor: 'kie' });
    expect(res.statusCode).toBe(200);
    expect(kieMocks.getKiePrediction).toHaveBeenCalledWith('kling-task-1');
    expect(getCredits()).toBe(150);
    expect(getMetadata()[KEY.pendingJobs]).toBe('');
  });
});

describe('prediction-creating routes return ids signed for the caller', () => {
  it('ugc-image', async () => {
    signIn(USER_A);
    setCredits(10);
    const res = await call(ugcImage, { body: { prompt: 'a cat on a sofa' } });
    expect(res.statusCode).toBe(200);
    expect(verifyJobId(USER_A.id, res.body.predictionId)).toBe('image-pred-1');
  });

  it('ugc-animate tracks the raw id for refunds', async () => {
    signIn(USER_A);
    setCredits(500);
    const res = await call(ugcAnimate, { body: { script: 'a cat waves', duration: 5 } });
    expect(res.statusCode).toBe(200);
    expect(verifyJobId(USER_A.id, res.body.predictionId)).toBe('seed-task-1');
    await vi.waitFor(() => expect(getMetadata()[KEY.pendingJobs]).toMatch(/^seed-task-1:/));
  });

  it('image-to-video', async () => {
    signIn(USER_A);
    setCredits(500);
    const res = await call(imageToVideo, { body: { imageUrl: FACE_URL, prompt: 'smile', duration: 5 } });
    expect(res.statusCode).toBe(200);
    expect(verifyJobId(USER_A.id, res.body.predictionId)).toBe('seed-task-1');
    expect(seedanceMocks.createSeedancePrediction).toHaveBeenCalledTimes(1);
  });

  it('character-frame', async () => {
    signIn(USER_A);
    setCredits(500);
    const res = await runCharacterFrame();
    expect(res.statusCode).toBe(200);
    expect(verifyJobId(USER_A.id, res.body.predictionId)).toBe('frame-pred-1');
  });
});

describe('creating routes refuse before charging when CRON_SECRET is missing', () => {
  it.each([
    ['character-frame', () => runCharacterFrame()],
    ['ugc-image', () => call(ugcImage, { body: { prompt: 'a cat on a sofa' } })],
    ['ugc-animate', () => call(ugcAnimate, { body: { script: 'a cat waves', duration: 5 } })],
    ['image-to-video', () => call(imageToVideo, { body: { imageUrl: FACE_URL, prompt: 'smile', duration: 5 } })],
  ])('%s returns 503 and reserves nothing', async (_name, run) => {
    signIn(USER_A);
    setCredits(500);
    unsetSigningSecret();
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(getCredits()).toBe(500);
    expect(replicateMocks.createCharacterFramePrediction).not.toHaveBeenCalled();
    expect(replicateMocks.createImagePrediction).not.toHaveBeenCalled();
    expect(seedanceMocks.createSeedancePrediction).not.toHaveBeenCalled();
    expect(kieMocks.createKlingSinglePrediction).not.toHaveBeenCalled();
  });
});

describe('/api/video/plan-edits', () => {
  const plan = {
    sourceUrl: 'https://example.com/v.mp4',
    duration: 10,
    width: 1080,
    height: 1920,
    operations: [],
  };
  const edit = (body) => call(planEdits, { body: { currentPlan: plan, userMessage: 'trim the start', ...body } });

  beforeEach(() => {
    anthropicCreate.mockReset();
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ plan, assistantMessage: 'Done.' }) }],
    });
  });

  it('a signed-in account with no credits gets 402 and no model call', async () => {
    signIn(USER_A);
    setCredits(0);
    const res = await edit();
    expect(res.statusCode).toBe(402);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('an account with credits gets a plan', async () => {
    signIn(USER_A);
    setCredits(5);
    const res = await edit();
    expect(res.statusCode).toBe(200);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['more than 10 history messages', { chatHistory: Array.from({ length: 11 }, () => ({ role: 'user', content: 'hi' })) }],
    ['a history message over 2,000 characters', { chatHistory: [{ role: 'user', content: 'x'.repeat(2001) }] }],
    ['a plan over 20,000 characters of JSON', { currentPlan: { ...plan, padding: 'x'.repeat(20001) } }],
  ])('rejects %s with 422 before any model call', async (_label, body) => {
    signIn(USER_A);
    setCredits(5);
    const res = await edit(body);
    expect(res.statusCode).toBe(422);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('accepts 10 history messages of exactly 2,000 characters', async () => {
    signIn(USER_A);
    setCredits(5);
    const chatHistory = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'x'.repeat(2000),
    }));
    const res = await edit({ chatHistory });
    expect(res.statusCode).toBe(200);
  });
});

describe('/api/extract-frame', () => {
  it('without a session returns 401', async () => {
    signOut();
    const res = await call(extractFrame, { body: { videoUrl: VIDEO_URL } });
    expect(res.statusCode).toBe(401);
  });
});
