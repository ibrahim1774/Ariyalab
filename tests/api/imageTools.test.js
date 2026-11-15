// /api/glow-up and /api/interior-design on the shared entitlement
// (lib/entitlement.js getImageEntitlement): image credits are currency
// 'image' in the ledger under billing_v2, and a monthly refill never wipes
// purchased image credits. kie.ai, Blob and Stripe are in-memory stubs; no
// network call leaves the process.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/apiMock';

const S = vi.hoisted(() => ({
  metadata: {},
  subs: [],
  updates: [],
  user: null,
  customerId: 'cus_img',
  customerCreated: Math.floor(Date.now() / 1000) - 3 * 86400,
  kie: { create: 'ok', record: 'success' },
  tasks: 0,
  fetches: [],
}));

vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal();
  const api = {
    customers: {
      retrieve: async () => ({ id: S.customerId, created: S.customerCreated, metadata: { ...S.metadata } }),
      // Stripe merges metadata: listed keys are set, '' removes a key.
      update: async (_id, { metadata }) => {
        S.updates.push({ ...metadata });
        const next = { ...S.metadata };
        for (const [k, v] of Object.entries(metadata || {})) {
          if (v === '') delete next[k];
          else next[k] = v;
        }
        S.metadata = next;
        return { id: S.customerId, metadata: { ...next } };
      },
    },
    subscriptions: {
      list: async ({ status }) => ({
        data: S.subs.filter((s) => status === 'all' || s.status === status).map((s) => structuredClone(s)),
      }),
    },
  };
  return { ...actual, stripe: () => api };
});
vi.mock('../../lib/supabaseServer', () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { stripe_customer_id: S.customerId }, error: null }) }),
      }),
    }),
  };
  return {
    getUserFromRequest: async () => (S.user ? { user: S.user, supabase: client } : null),
    getSupabaseAdmin: () => client,
  };
});
vi.mock('../../lib/meta', () => ({ sendCapiEvent: async () => {} }));
vi.mock('../../lib/moderation', async (importOriginal) => ({
  ...(await importOriginal()),
  screenText: async () => {},
  screenImage: async () => {},
}));
vi.mock('@vercel/blob', () => ({ put: async (name) => ({ url: `https://blob.test/${name}` }) }));

const { setCreditsDb, grantCredits, getBalance } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache } = await import('../../lib/pricing.js');
const { PLANS } = await import('../../lib/stripe');
const { KEY } = await import('../../lib/metaKeys');
const glowUp = (await import('../../pages/api/glow-up.js')).default;
const interior = (await import('../../pages/api/interior-design.js')).default;

// kie.ai stand-in: glow-up uses /jobs/*, interior-design /flux/kontext/*.
function fakeFetch(url) {
  S.fetches.push(String(url));
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  if (/createTask|kontext\/generate/.test(url)) {
    if (S.kie.create === 'fail') return json({ code: 500, msg: 'kie down' });
    S.tasks += 1;
    return json({ code: 200, data: { taskId: `task-${S.tasks}` } });
  }
  if (/recordInfo/.test(url)) {
    return json({
      code: 200,
      data:
        S.kie.record === 'success'
          ? { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.test/out.png'] }) }
          : { state: 'fail', failMsg: 'model refused' },
    });
  }
  if (/record-info/.test(url)) {
    return json({
      code: 200,
      data:
        S.kie.record === 'success'
          ? { successFlag: 1, response: { resultImageUrl: 'https://cdn.test/room.png' } }
          : { successFlag: 3, errorMessage: 'model refused' },
    });
  }
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(4) };
}

let db;
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(db);
  setPricingDb(db);
  process.env.KIE_API_KEY = 'test-kie-key';
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

const DAY = 24 * 60 * 60 * 1000;
const monthlyPrice = () => ({ id: 'price_m', lookup_key: PLANS.monthly.lookupKey });
function subscribe(status = 'active') {
  S.subs = [
    {
      id: `sub_${randomUUID().slice(0, 8)}`,
      status,
      start_date: Math.floor((Date.now() - 3 * DAY) / 1000),
      current_period_start: Math.floor((Date.now() - 3 * DAY) / 1000),
      items: { data: [{ price: monthlyPrice() }] },
    },
  ];
}

beforeEach(() => {
  S.metadata = {};
  S.subs = [];
  S.updates = [];
  S.fetches = [];
  S.kie = { create: 'ok', record: 'success' };
  S.user = { id: randomUUID(), email: `u-${randomUUID()}@example.test` };
  vi.stubGlobal('fetch', vi.fn(async (url) => fakeFetch(url)));
  // The routes wait 3 s between kie.ai polls.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(handler, reqOpts) {
  const res = makeRes();
  const done = handler(makeReq(reqOpts), res);
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(3_100);
  await done;
  return res;
}
const generate = () => call(glowUp, { body: { style: 'casual', imageUrls: ['https://x.test/me.jpg'] } });
const balanceGet = () => call(glowUp, { method: 'GET' });
const redesign = () =>
  call(interior, { body: { imageUrl: 'https://x.test/room.jpg', style: 'japandi' } });
const imageBalance = () => getBalance(S.user.id, 'image');

describe('billing_v2: image credits are ledger currency "image"', () => {
  beforeEach(() => setV2(true));

  it('the monthly 30 arrive once per 30-day window and keep purchased image credits', async () => {
    subscribe();
    await grantCredits({ userId: S.user.id, currency: 'image', amount: 50, bucket: 'topup', reason: 'test', ref: randomUUID() });
    const first = await balanceGet();
    expect(first.statusCode).toBe(200);
    expect(first.body.imageCreditsRemaining).toBe(80);
    const second = await balanceGet();
    expect(second.body.imageCreditsRemaining).toBe(80);
    expect(await imageBalance()).toMatchObject({ plan: 30, topup: 50 });
    expect(S.updates).toEqual([]); // nothing written to Stripe
  });

  it('a generation holds 1 image credit and spends it once kie.ai succeeds', async () => {
    subscribe();
    const res = await generate();
    expect(res.statusCode).toBe(200);
    expect(res.body.imageCreditsRemaining).toBe(29);
    expect(await imageBalance()).toMatchObject({ available: 29, held: 0 });
    const { rows } = await db.query(
      `select ref from public.credit_ledger where user_id = $1 and currency = 'image' and op = 'settle'`,
      [S.user.id]
    );
    expect(rows).toEqual([{ ref: `legacy:glow-up:task-${S.tasks}` }]);
    expect(S.updates).toEqual([]);
  });

  it('a failed generation releases the hold', async () => {
    subscribe();
    S.kie.record = 'fail';
    const res = await generate();
    expect(res.statusCode).toBe(502);
    expect(await imageBalance()).toMatchObject({ available: 30, held: 0 });
    S.kie = { create: 'fail', record: 'success' };
    expect((await generate()).statusCode).toBe(502);
    expect(await imageBalance()).toMatchObject({ available: 30, held: 0 });
  });

  it('interior-design draws from the same image pool', async () => {
    subscribe();
    const res = await redesign();
    expect(res.statusCode).toBe(200);
    expect(res.body.imageCreditsRemaining).toBe(29);
    expect(await imageBalance()).toMatchObject({ available: 29, held: 0 });
  });

  it('no plan: paywall, nothing held; out of image credits: 402 image-credits-exhausted', async () => {
    const none = await generate();
    expect(none.statusCode).toBe(402);
    expect(none.body).toEqual({ error: 'paywall' });
    subscribe();
    await balanceGet(); // 30 arrive
    const { rows } = await db.query(`select 1 from public.credit_holds where user_id = $1`, [S.user.id]);
    expect(rows).toEqual([]);
    for (let i = 0; i < 30; i += 1) expect((await generate()).statusCode).toBe(200);
    const out = await generate();
    expect(out.statusCode).toBe(402);
    expect(out.body).toEqual({ error: 'paywall', reason: 'image-credits-exhausted' });
    expect(S.fetches.filter((u) => /createTask/.test(u))).toHaveLength(30);
  });
});

describe('round 1: v2 image allotment resets each window, anchored on the customer (M1)', () => {
  beforeEach(() => setV2(true));
  afterEach(() => vi.restoreAllMocks());

  it('unused monthly image credits do not roll over; purchased ones stay', async () => {
    subscribe();
    S.customerCreated = Math.floor(Date.now() / 1000) - 3 * DAY / 1000;
    await grantCredits({ userId: S.user.id, currency: 'image', amount: 50, bucket: 'topup', reason: 'test', ref: randomUUID() });
    expect((await balanceGet()).body.imageCreditsRemaining).toBe(80);
    for (let i = 0; i < 5; i += 1) expect((await generate()).statusCode).toBe(200);
    expect(await imageBalance()).toMatchObject({ plan: 25, topup: 50 });
    // 30 days later, the next window: the plan bucket is 30 again, not 55.
    const later = Date.now() + 30 * DAY;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await balanceGet()).body.imageCreditsRemaining).toBe(80);
    expect(await imageBalance()).toMatchObject({ plan: 30, topup: 50 });
    // A new subscription in the same window does not add another 30.
    subscribe();
    await balanceGet();
    expect(await imageBalance()).toMatchObject({ plan: 30, topup: 50 });
  });
});

describe('round 1: only this app\'s subscriptions count (dual-site customers)', () => {
  it('a haelabs.live subscription listed first is skipped; alone it is no plan', async () => {
    await setV2(true);
    const haelabs = { id: 'sub_hae', status: 'active', start_date: Math.floor(Date.now() / 1000), items: { data: [{ price: { id: 'p_h', lookup_key: 'haelabs_monthly' } }] } };
    S.subs = [haelabs];
    expect((await generate()).statusCode).toBe(402);
    subscribe();
    S.subs = [haelabs, ...S.subs];
    expect((await generate()).statusCode).toBe(200);
  });
});

describe('legacy (billing_v2 off): Stripe metadata, refill no longer wipes purchases', () => {
  beforeEach(() => setV2(false));

  it('a refill keeps a purchased pack (200 stays 200, not 30)', async () => {
    subscribe();
    S.metadata = {
      [KEY.plan]: 'monthly',
      [KEY.imageCredits]: '200',
      [KEY.imagePeriodStart]: String(Date.now() - 31 * DAY),
      creditsRemaining: '7', // haelabs.live's own key: never touched
    };
    const res = await generate();
    expect(res.statusCode).toBe(200);
    expect(res.body.imageCreditsRemaining).toBe(199);
    expect(S.metadata[KEY.imageCredits]).toBe('199');
    expect(S.metadata.creditsRemaining).toBe('7');
    // Only this app's two image keys are sent.
    for (const u of S.updates) {
      expect(Object.keys(u).sort()).toEqual([KEY.imageCredits, KEY.imagePeriodStart].sort());
    }
  });

  it('a low balance is topped up to 30 at the refill, as before', async () => {
    subscribe();
    S.metadata = {
      [KEY.plan]: 'monthly',
      [KEY.imageCredits]: '3',
      [KEY.imagePeriodStart]: String(Date.now() - 31 * DAY),
    };
    expect((await balanceGet()).body.imageCreditsRemaining).toBe(30);
    const res = await generate();
    expect(res.body.imageCreditsRemaining).toBe(29);
    expect(S.metadata[KEY.imageCredits]).toBe('29');
  });

  it('inside the window nothing is refilled; a failure refunds the credit', async () => {
    subscribe();
    S.metadata = {
      [KEY.plan]: 'monthly',
      [KEY.imageCredits]: '5',
      [KEY.imagePeriodStart]: String(Date.now() - 2 * DAY),
    };
    S.kie.record = 'fail';
    expect((await generate()).statusCode).toBe(502);
    expect(S.metadata[KEY.imageCredits]).toBe('5');
    S.kie.record = 'success';
    expect((await redesign()).body.imageCreditsRemaining).toBe(4);
    expect(S.metadata[KEY.imageCredits]).toBe('4');
  });

  it('no paid plan in metadata: paywall', async () => {
    subscribe();
    S.metadata = { [KEY.imageCredits]: '50' };
    expect((await generate()).statusCode).toBe(402);
  });
});

describe('admin', () => {
  const prev = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  });
  it('only a confirmed ADMIN_EMAILS user skips the image credit check', async () => {
    await setV2(true);
    process.env.ADMIN_EMAILS = 'boss@example.test';
    S.user = { id: randomUUID(), email: 'boss@example.test' };
    expect((await generate()).statusCode).toBe(402);
    S.user = { ...S.user, email_confirmed_at: '2026-11-01T00:00:00Z' };
    const res = await generate();
    expect(res.statusCode).toBe(200);
    expect(res.body.imageCreditsRemaining).toBe(9999);
    delete process.env.ADMIN_EMAILS;
    S.user = { id: randomUUID(), email: 'ibrahim3709@gmail.com', email_confirmed_at: '2026-11-01T00:00:00Z' };
    expect((await generate()).statusCode).toBe(402);
  });
});
