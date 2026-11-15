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
const { verifyJobToken, signJobId } = await import('../lib/jobToken');
const { reconcileLegacyHolds } = await import('../lib/legacyHolds');
const swap = (await import('../pages/api/swap')).default;
const cronLegacyHolds = (await import('../pages/api/cron/legacy-holds')).default;
const { KEY } = await import('../lib/metaKeys');
const { setMetadata } = await import('./helpers/apiMock');
const { v2CostForGeneration, costForGeneration, FACE_SWAP_COST } = await import('../lib/cost');
const imageToVideo = (await import('../pages/api/image-to-video')).default;
const ugcAnimate = (await import('../pages/api/ugc-animate')).default;
const ugcImage = (await import('../pages/api/ugc-image')).default;
const characterFrame = (await import('../pages/api/character-frame')).default;
const status = (await import('../pages/api/status')).default;

let db;
// The credit functions go through this handle; `failOn` makes calls whose SQL
// mentions that function fail once per listed name (a database blip).
const failOn = new Set();
const handle = {
  query: (sql, params) => {
    for (const name of failOn) {
      if (sql.includes(name)) {
        failOn.delete(name);
        return Promise.reject(new Error(`db down (${name})`));
      }
    }
    return db.query(sql, params);
  },
};
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(handle);
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
  failOn.clear();
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
  it('v2 price = the legacy TOTAL x LEGACY_TO_V2, rounded up (100 legacy credits per second -> 21)', () => {
    const top = { model: 'studio-pro', resolution: '1080p', audio: true };
    expect(costForGeneration({ ...top, seconds: 1 })).toBe(100);
    expect(v2CostForGeneration({ ...top, seconds: 1 })).toBe(21);
    expect(v2CostForGeneration({ ...top, seconds: 5 })).toBe(105);
    // 15/s for 5 s = 75 legacy -> ceil(15.75) = 16 (not 4/s x 5 = 20).
    expect(v2CostForGeneration({ model: 'standard', resolution: '480p', audio: true, seconds: 5 })).toBe(16);
    expect(v2CostForGeneration({ model: 'standard', resolution: '480p', seconds: 5 })).toBe(11);
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
    // studio-pro 480p silent = 40/s x 7 s = 280 legacy -> ceil(58.8) = 59.
    expect(res.body.cost).toBe(59);
    expect(await getBalance(user.id)).toMatchObject({ held: 59 });
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

// ---------------------------------------------------------------- round 1

const holdRows = async () =>
  (await db.query('select route, provider, job_id, status, amount from public.credit_legacy_holds where user_id = $1 order by created_at', [user.id])).rows;
const age = (minutes) =>
  db.query(`update public.credit_legacy_holds set created_at = now() - make_interval(mins => $2) where user_id = $1`, [user.id, minutes]);
const imageToVideoBody = { imageUrl: 'https://x.test/a.jpg', duration: 5 };

describe('round 1: every v2 hold is recorded server-side (I2)', () => {
  it('an async kie job records its hold, provider and job id', async () => {
    await grant(500);
    const res = await call(imageToVideo, { body: imageToVideoBody });
    expect(res.statusCode).toBe(200);
    expect(await holdRows()).toEqual([
      { route: 'image-to-video', provider: 'kie', job_id: 'seed-task-1', status: 'open', amount: res.body.cost },
    ]);
  });

  it('a sync route settles before answering; a settle that fails is recorded for retry, not swallowed', async () => {
    await grant(10);
    failOn.add('credit_settle');
    const res = await call(ugcImage, { body: { prompt: 'a cat on a sofa' } });
    expect(res.statusCode).toBe(200);
    expect(await holdRows()).toMatchObject([{ route: 'ugc-image', provider: 'replicate', job_id: 'image-pred-1', status: 'settle_retry' }]);
    expect(await getBalance(user.id)).toMatchObject({ held: 1 });
    const summary = await reconcileLegacyHolds({ olderThanMinutes: 0 });
    expect(summary.settled).toBe(1);
    expect(await holdRows()).toMatchObject([{ status: 'settled' }]);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 9 });
  });

  it('a hold that cannot be recorded is released and the job is not started', async () => {
    await grant(500);
    failOn.add('credit_legacy_hold_open');
    const res = await call(imageToVideo, { body: imageToVideoBody });
    expect(res.statusCode).toBe(500);
    expect(seedanceMocks.createSeedancePrediction).not.toHaveBeenCalled();
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 });
  });

  it('the reconciler ends a kie job nobody polled: settle on success (read-only status check)', async () => {
    await grant(500);
    const res = await call(imageToVideo, { body: imageToVideoBody });
    await age(30);
    kieMocks.getKiePrediction.mockImplementation(async () => ({
      state: 'success',
      resultJson: JSON.stringify({ resultUrls: ['https://cdn.test/out.mp4'] }),
    }));
    const summary = await reconcileLegacyHolds();
    expect(summary).toMatchObject({ settled: 1 });
    expect(kieMocks.getKiePrediction).toHaveBeenCalledWith('seed-task-1');
    expect(seedanceMocks.createSeedancePrediction).toHaveBeenCalledTimes(1); // never re-submitted
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 - res.body.cost });
    // The customer polls afterwards: still charged once.
    await call(status, { method: 'GET', query: { predictionId: res.body.predictionId, vendor: 'kie' } });
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 - res.body.cost });
  });

  it('the reconciler releases a failed job, a job still unknown after the cap, and a job never submitted', async () => {
    await grant(500);
    await call(imageToVideo, { body: imageToVideoBody });
    await age(30);
    kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'fail', failMsg: 'blocked' }));
    expect((await reconcileLegacyHolds()).released).toBe(1);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 });

    await call(imageToVideo, { body: imageToVideoBody });
    kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'generating' }));
    await db.query(`update public.credit_legacy_holds set created_at = now() - interval '30 minutes' where status = 'open' and user_id = $1`, [user.id]);
    expect((await reconcileLegacyHolds()).released).toBe(0); // still running, inside the cap
    await db.query(`update public.credit_legacy_holds set created_at = now() - interval '25 hours' where status = 'open' and user_id = $1`, [user.id]);
    expect((await reconcileLegacyHolds()).released).toBe(1);

    seedanceMocks.createSeedancePrediction.mockImplementationOnce(() => new Promise(() => {})); // the request dies mid-submit
    call(imageToVideo, { body: imageToVideoBody });
    await vi.waitFor(async () => expect((await holdRows()).filter((r) => r.status === 'open')).toHaveLength(1));
    await db.query(`update public.credit_legacy_holds set created_at = now() - interval '20 minutes' where status = 'open' and user_id = $1`, [user.id]);
    expect((await reconcileLegacyHolds()).released).toBe(1);
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 });
  });

  it('the cron route needs CRON_SECRET', async () => {
    const denied = await call(cronLegacyHolds, { method: 'GET', headers: {} });
    expect(denied.statusCode).toBe(401);
    const ok = await call(cronLegacyHolds, { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.ok).toBe(true);
  });
});

describe('round 1: /api/status', () => {
  it('settles a hold-carrying job even when the client omits vendor=kie (F-I4)', async () => {
    await grant(500);
    const res = await call(imageToVideo, { body: imageToVideoBody });
    kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'fail', failMsg: 'x' }));
    await call(status, { method: 'GET', query: { predictionId: res.body.predictionId } });
    expect(kieMocks.getKiePrediction).toHaveBeenCalledWith('seed-task-1');
    expect(await getBalance(user.id)).toMatchObject({ held: 0, available: 500 });
  });

  it('a legacy job (no hold) that fails after the switch is refunded in the ledger, once (M2)', async () => {
    setMetadata({ [KEY.pendingJobs]: 'old-task:100' });
    kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'fail', failMsg: 'x' }));
    const token = signJobId(user.id, 'old-task');
    await call(status, { method: 'GET', query: { predictionId: token, vendor: 'kie' } });
    await call(status, { method: 'GET', query: { predictionId: token, vendor: 'kie' } });
    expect(await getBalance(user.id)).toMatchObject({ topup: 21, available: 21 });
    expect(getMetadata()[KEY.pendingJobs]).toBe('old-task:100'); // nothing written to Stripe
  });
});

describe('round 1: face-swap replay guard under billing_v2 (I3)', () => {
  const HYBRID = 'https://replicate.delivery/hybrid.jpg';
  const VIDEO = 'https://x.test/v.mp4';
  async function frame() {
    await grant(100);
    const res = await call(characterFrame, {
      body: { firstFrameUrl: 'https://x.test/f.jpg', referenceImageUrl: 'https://x.test/r.jpg', sourceVideoUrl: VIDEO, swapMode: 'face' },
    });
    expect(res.statusCode).toBe(200);
    return res.body.swapToken;
  }
  function stage(statuses = {}) {
    let n = 0;
    replicateMocks.createMotionTransferPrediction.mockImplementation(async () => ({ id: `swap-pred-${++n}`, status: 'starting' }));
    replicateMocks.getPrediction.mockImplementation(async (id) =>
      id === 'frame-pred-1' ? { status: 'succeeded', output: HYBRID } : { status: statuses[id] || 'processing' }
    );
  }

  it('records uses per user in the database, never in Stripe, and stops at three', async () => {
    const swapToken = await frame();
    const before = { ...getMetadata() };
    stage({ 'swap-pred-1': 'failed', 'swap-pred-2': 'failed', 'swap-pred-3': 'failed' });
    const body = { imageUrl: HYBRID, videoUrl: VIDEO, swapToken };
    for (let i = 0; i < 3; i += 1) expect((await call(swap, { body })).statusCode).toBe(200);
    const fourth = await call(swap, { body });
    expect(fourth.statusCode).toBe(402);
    expect(fourth.body.code).toBe('SWAP_RETRY_LIMIT');
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledTimes(3);
    const { rows } = await db.query('select frame_id, swap_id, count from public.credit_swap_uses where user_id = $1', [user.id]);
    expect(rows).toEqual([{ frame_id: 'frame-pred-1', swap_id: 'swap-pred-3', count: 3 }]);
    expect(getMetadata()).toEqual(before);
  });

  it('a running swap is handed back, not started again', async () => {
    const swapToken = await frame();
    stage();
    const body = { imageUrl: HYBRID, videoUrl: VIDEO, swapToken };
    const first = await call(swap, { body });
    const again = await call(swap, { body });
    expect(again.body.predictionId).toBe(first.body.predictionId);
    expect(replicateMocks.createMotionTransferPrediction).toHaveBeenCalledTimes(1);
  });

  it('refuses the swap when the use cannot be recorded', async () => {
    const swapToken = await frame();
    stage();
    failOn.add('credit_claim_swap_use');
    const res = await call(swap, { body: { imageUrl: HYBRID, videoUrl: VIDEO, swapToken } });
    expect(res.statusCode).toBe(503);
    expect(replicateMocks.createMotionTransferPrediction).not.toHaveBeenCalled();
  });
});

describe('round 1: migrated customers cannot spend on the legacy path (F-I5)', () => {
  it('flag off again after --apply: the legacy route refuses with a clear message', async () => {
    await setV2(false);
    await db.query(
      `insert into public.credit_legacy_migrations (customer_id, currency, user_id, plan, topup, parked)
       values ('cus_test', 'video', $1, 100, 0, false) on conflict do nothing`,
      [user.id]
    );
    try {
      const res = await call(ugcImage, { body: { prompt: 'a cat' } });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'MIGRATED' });
      expect(res.body.error).toMatch(/moved to the new system/);
      expect(replicateMocks.createImagePrediction).not.toHaveBeenCalled();
    } finally {
      await db.query(`delete from public.credit_legacy_migrations where customer_id = 'cus_test'`);
    }
  });
});
