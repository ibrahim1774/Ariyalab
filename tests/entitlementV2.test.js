// billing_v2 adapter for the old tools (lib/entitlement.js): with the flag on,
// the old routes charge through the Postgres ledger (lib/credits.js) with a
// hold per paid job, never through Stripe metadata. Stripe is the in-memory
// fake from tests/helpers/apiMock.js; providers are stubs. No network.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.js';
import {
  makeReq,
  makeRes,
  signIn,
  setCredits,
  getMetadata,
  kieMocks,
  replicateMocks,
  seedanceMocks,
  resetApiMocks,
  supabaseServerModule,
} from './helpers/apiMock';

vi.mock('../lib/supabaseServer', async () => (await import('./helpers/apiMock')).supabaseServerModule);
vi.mock('../lib/stripe', async () => (await import('./helpers/apiMock')).stripeModule);
vi.mock('../lib/meta', () => ({ sendCapiEvent: async () => {} }));
vi.mock('../lib/replicate', async (importOriginal) => ({
  ...(await importOriginal()),
  ...(await import('./helpers/apiMock')).replicateMocks,
}));
vi.mock('../lib/kie', async (importOriginal) => ({
  ...(await importOriginal()),
  ...(await import('./helpers/apiMock')).kieMocks,
}));
vi.mock('../lib/seedance', async () => (await import('./helpers/apiMock')).seedanceMocks);
vi.mock('../lib/moderation', async (importOriginal) => ({
  ...(await importOriginal()),
  ...(await import('./helpers/apiMock')).moderationMocks,
}));

const { setCreditsDb, grantCredits, getBalance, InsufficientCreditsError } = await import('../lib/credits.js');
const { setPricingDb, _resetPricingCache } = await import('../lib/pricing.js');
const { getEntitlement, reserveCredits, refundCredits, settleReservation, decrementCredits } = await import(
  '../lib/entitlement'
);
const { verifyJobToken } = await import('../lib/jobToken');
const { v2CostForGeneration, costForGeneration, FACE_SWAP_COST } = await import('../lib/cost');
const imageToVideo = (await import('../pages/api/image-to-video')).default;
const ugcAnimate = (await import('../pages/api/ugc-animate')).default;
const ugcImage = (await import('../pages/api/ugc-image')).default;
const characterFrame = (await import('../pages/api/character-frame')).default;
const status = (await import('../pages/api/status')).default;

let db;
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(db);
  setPricingDb(db);
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  setPricingDb(null);
  await db?.close();
});

async function setV2(on) {
  await db.query(
    `insert into public.pricing_config (key, value) values ('billing_v2', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(on)]
  );
  _resetPricingCache();
}

let user;
beforeEach(async () => {
  resetApiMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await setV2(true);
  user = { id: randomUUID(), email: `u-${randomUUID()}@example.test` };
  signIn(user);
  setCredits(10_000); // legacy metadata: must never be read or written on the v2 path
});
afterEach(() => {
  vi.restoreAllMocks();
});

const grant = (amount, bucket = 'topup') =>
  grantCredits({ userId: user.id, currency: 'video', amount, bucket, reason: 'test_grant', ref: randomUUID() });

async function call(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}
const entitlementFor = async () => {
  const { supabase } = await supabaseServerModule.getUserFromRequest();
  return getEntitlement({ supabase, userId: user.id, user });
};

describe('getEntitlement with billing_v2 on', () => {
  it('reads the ledger balance and writes nothing to Stripe', async () => {
    await grant(150);
    const before = { ...getMetadata() };
    const ent = await entitlementFor();
    expect(ent.billing).toBe('v2');
    expect(ent.creditsRemaining).toBe(150);
    expect(ent.canSwap).toBe(true);
    expect(ent.tier).toBe('monthly');
    expect(getMetadata()).toEqual(before);
  });
});

describe('reserveCredits with billing_v2 on', () => {
  it('two parallel reserves of 100 against 150: one holds, one gets InsufficientCreditsError', async () => {
    await grant(150);
    const [a, b] = await Promise.all([entitlementFor(), entitlementFor()]);
    const results = await Promise.allSettled([
      reserveCredits(a, 100, { route: 'test' }),
      reserveCredits(b, 100, { route: 'test' }),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(InsufficientCreditsError);
    // The routes branch on these two fields for their 402.
    expect(failed[0].reason.code).toBe('INSUFFICIENT');
    expect(failed[0].reason.remaining).toBe(50);
    expect(await getBalance(user.id)).toMatchObject({ held: 100, available: 50 });
  });

  it('settle spends the hold once; refund releases it; neither touches Stripe', async () => {
    await grant(150);
    const before = { ...getMetadata() };
    const ent = await entitlementFor();
    await reserveCredits(ent, 40, { route: 'test' });
    await settleReservation(ent, 'job-1');
    await settleReservation(ent, 'job-1');
    expect(await getBalance(user.id)).toMatchObject({ available: 110, held: 0 });

    const ent2 = await entitlementFor();
    await reserveCredits(ent2, 30, { route: 'test' });
    await refundCredits(ent2, 30);
    expect(await getBalance(user.id)).toMatchObject({ available: 110, held: 0 });
    expect(getMetadata()).toEqual(before);
  });

  it('decrementCredits spends with a required ref, idempotently', async () => {
    await grant(50);
    const ent = await entitlementFor();
    await expect(decrementCredits(ent, 5)).rejects.toThrow(/ref/);
    await decrementCredits(ent, 5, { ref: 'once' });
    await decrementCredits(ent, 5, { ref: 'once' });
    expect(await getBalance(user.id)).toMatchObject({ available: 45 });
  });

  it('an account without credits is refused like the legacy path (INSUFFICIENT)', async () => {
    const ent = await entitlementFor();
    const err = await reserveCredits(ent, 1, { route: 'test' }).catch((e) => e);
    expect(err.code).toBe('INSUFFICIENT');
    expect(err.remaining).toBe(0);
  });
});

describe('old tools charge v2 prices', () => {
  it('per-second prices convert the rate with LEGACY_TO_V2, rounded up (100/s -> 21/s)', () => {
    const top = { model: 'studio-pro', resolution: '1080p', audio: true };
    expect(costForGeneration({ ...top, seconds: 1 })).toBe(100);
    expect(v2CostForGeneration({ ...top, seconds: 1 })).toBe(21);
    expect(v2CostForGeneration({ ...top, seconds: 5 })).toBe(105);
    // 15/s -> ceil(3.15) = 4/s, not ceil(75 * 0.21) = 16 for 5 s.
    expect(v2CostForGeneration({ model: 'standard', resolution: '480p', audio: true, seconds: 5 })).toBe(20);
  });

  it('image-to-video holds the v2 price and signs the hold into the job id', async () => {
    await grant(500);
    const res = await call(imageToVideo, {
      body: { imageUrl: 'https://x.test/a.jpg', duration: 5, model: 'studio-pro', resolution: '1080p', audio: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.cost).toBe(105);
    expect(await getBalance(user.id)).toMatchObject({ held: 105, available: 395 });
    const token = verifyJobToken(user.id, res.body.predictionId);
    expect(token.predictionId).toBe('kling-task-1');
    expect(token.hold).toMatchObject({ amount: 105, route: 'image-to-video' });
  });

  it('a 402 reports the v2 cost and the ledger balance', async () => {
    await grant(50);
    const res = await call(imageToVideo, {
      body: { imageUrl: 'https://x.test/a.jpg', duration: 5, model: 'studio-pro', resolution: '1080p', audio: true },
    });
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatchObject({ error: 'paywall', cost: 105, creditsRemaining: 50 });
    expect(kieMocks.createKlingSinglePrediction).not.toHaveBeenCalled();
  });

  it('a provider that refuses the job releases the hold', async () => {
    await grant(500);
    seedanceMocks.createSeedancePrediction.mockImplementationOnce(async () => {
      throw new Error('provider down');
    });
    const res = await call(ugcAnimate, { body: { script: 'a cat waves', duration: 5 } });
    expect(res.statusCode).toBe(500);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 });
  });

  it('ugc-animate storyboard: per-second v2 rate times total seconds', async () => {
    await grant(500);
    const scenes = [{ prompt: 'a', duration: 3 }, { prompt: 'b', duration: 4 }];
    const res = await call(ugcAnimate, { body: { scenes, resolution: '480p' } });
    expect(res.statusCode).toBe(200);
    // studio-pro 480p silent = 40/s -> ceil(8.4) = 9/s, 7 s.
    expect(res.body.cost).toBe(63);
    expect(await getBalance(user.id)).toMatchObject({ held: 63 });
  });

  it('character-frame charges FACE_SWAP_COST converted (100 -> 21) and settles at once', async () => {
    await grant(100);
    const res = await call(characterFrame, {
      body: {
        firstFrameUrl: 'https://x.test/f.jpg',
        referenceImageUrl: 'https://x.test/r.jpg',
        sourceVideoUrl: 'https://x.test/v.mp4',
        swapMode: 'face',
      },
    });
    expect(FACE_SWAP_COST).toBe(100);
    expect(res.statusCode).toBe(200);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 79 });
    expect(verifyJobToken(user.id, res.body.predictionId).hold).toBeNull();
    const { rows } = await db.query(
      `select ref, amount from public.credit_ledger where user_id = $1 and op = 'settle'`,
      [user.id]
    );
    expect(rows).toEqual([{ ref: 'legacy:character-frame:frame-pred-1', amount: 21 }]);
  });

  it('ugc-image settles 1 credit right after the provider accepts the job', async () => {
    await grant(10);
    const res = await call(ugcImage, { body: { prompt: 'a cat on a sofa' } });
    expect(res.statusCode).toBe(200);
    expect(replicateMocks.createImagePrediction).toHaveBeenCalledTimes(1);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 9 });
  });
});

describe('/api/status settles the hold carried in the job id', () => {
  async function startKieJob() {
    await grant(500);
    const res = await call(imageToVideo, { body: { imageUrl: 'https://x.test/a.jpg', duration: 5 } });
    expect(res.statusCode).toBe(200);
    return res.body;
  }
  const poll = (predictionId) => call(status, { method: 'GET', query: { predictionId, vendor: 'kie' } });

  it('a finished job is spent once, however often it is polled', async () => {
    const job = await startKieJob();
    kieMocks.getKiePrediction.mockImplementation(async () => ({
      state: 'success',
      resultJson: JSON.stringify({ resultUrls: ['https://cdn.test/out.mp4'] }),
    }));
    await poll(job.predictionId);
    await poll(job.predictionId);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 - job.cost });
    const { rows } = await db.query(
      `select ref from public.credit_ledger where user_id = $1 and op = 'settle'`,
      [user.id]
    );
    expect(rows).toEqual([{ ref: 'legacy:image-to-video:seed-task-1' }]);
  });

  it('a failed job releases the hold (the customer pays nothing)', async () => {
    const job = await startKieJob();
    kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'fail', failMsg: 'blocked' }));
    await poll(job.predictionId);
    await poll(job.predictionId);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 });
  });

  it('a job still running keeps its hold', async () => {
    const job = await startKieJob();
    await poll(job.predictionId);
    expect(await getBalance(user.id)).toMatchObject({ held: job.cost });
  });
});

describe('admin tier needs a confirmed email in ADMIN_EMAILS', () => {
  const prev = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  });
  it('no built-in admin, no email-only admin, no unconfirmed admin', async () => {
    const { supabase } = await supabaseServerModule.getUserFromRequest();
    const owner = { id: user.id, email: 'ibrahim3709@gmail.com', email_confirmed_at: '2026-11-01T00:00:00Z' };
    delete process.env.ADMIN_EMAILS;
    expect((await getEntitlement({ supabase, userId: user.id, user: owner })).isAdmin).toBeFalsy();
    process.env.ADMIN_EMAILS = 'boss@example.test';
    const boss = { id: user.id, email: 'boss@example.test' };
    expect((await getEntitlement({ supabase, userId: user.id, email: boss.email })).isAdmin).toBeFalsy();
    expect((await getEntitlement({ supabase, userId: user.id, user: boss })).isAdmin).toBeFalsy();
    const confirmed = { ...boss, email_confirmed_at: '2026-11-01T00:00:00Z' };
    expect((await getEntitlement({ supabase, userId: user.id, user: confirmed })).isAdmin).toBe(true);
  });
});
