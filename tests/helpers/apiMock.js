// Shared fakes for API route tests: req/res builders, a switchable
// signed-in user, an in-memory Stripe customer, and Replicate/kie stubs.
// Test files wire these in with vi.mock(path, async () => (await import(...)).xModule).
import { vi } from 'vitest';
import { KEY } from '../../lib/metaKeys';

export const USER_A = { id: 'user-a', email: 'a@example.test' };
export const USER_B = { id: 'user-b', email: 'b@example.test' };

export function makeReq({ method = 'POST', body = {}, query = {}, headers = {} } = {}) {
  return { method, body, query, headers };
}

export function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
  };
  return res;
}

// ---- auth -----------------------------------------------------------
let currentUser = null;
export function signIn(user) {
  currentUser = user;
}
export function signOut() {
  currentUser = null;
}

const CUSTOMER_ID = 'cus_test';
const fakeSupabase = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { stripe_customer_id: CUSTOMER_ID }, error: null }) }),
    }),
  }),
};

export const historyUpserts = [];
export const supabaseServerModule = {
  getUserFromRequest: vi.fn(async () => (currentUser ? { user: currentUser, supabase: fakeSupabase } : null)),
  getSupabaseAdmin: () => ({
    from: () => ({
      upsert: async (row) => {
        historyUpserts.push(row);
        return {};
      },
    }),
  }),
};

// ---- Stripe (one active monthly customer, metadata in memory) --------
const PLAN_CAP = 760;
const PERIOD_START_S = 1;
let metadata = {};

export function setCredits(n) {
  metadata = {
    ...metadata,
    [KEY.credits]: String(n),
    [KEY.periodStart]: String(PERIOD_START_S * 1000),
    [KEY.lastSeededCap]: String(PLAN_CAP),
    [KEY.plan]: 'monthly',
  };
}
export function getCredits() {
  return parseInt(metadata[KEY.credits], 10);
}
export function setMetadata(patch) {
  metadata = { ...metadata, ...patch };
}
export function getMetadata() {
  return metadata;
}

const fakeStripe = {
  subscriptions: {
    list: async ({ status }) => ({
      data:
        status === 'active'
          ? [{ status: 'active', current_period_start: PERIOD_START_S, items: { data: [{ price: { id: 'price_monthly' } }] } }]
          : [],
    }),
  },
  customers: {
    retrieve: async () => ({ id: CUSTOMER_ID, metadata: { ...metadata } }),
    update: async (_id, { metadata: next }) => {
      metadata = { ...next };
      return { id: CUSTOMER_ID, metadata };
    },
  },
};

export const stripeModule = {
  stripe: () => fakeStripe,
  CAPS: { monthly: PLAN_CAP, pro: PLAN_CAP, yearly: PLAN_CAP },
  TRIAL_CREDITS: 2,
  planFromPrice: () => 'monthly',
};

// ---- providers ------------------------------------------------------
export const replicateMocks = {
  createMotionTransferPrediction: vi.fn(async () => ({ id: 'swap-pred-1', status: 'starting' })),
  createCharacterFramePrediction: vi.fn(async () => ({ id: 'frame-pred-1', status: 'starting' })),
  createImagePrediction: vi.fn(async () => ({ id: 'image-pred-1', status: 'starting' })),
  getPrediction: vi.fn(async () => ({ status: 'processing' })),
};

export const kieMocks = {
  createKlingSinglePrediction: vi.fn(async () => ({ id: 'kling-task-1' })),
  createKlingStoryboardPrediction: vi.fn(async () => ({ id: 'kling-board-1' })),
  getKiePrediction: vi.fn(async () => ({ state: 'generating' })),
};

export const seedanceMocks = {
  createSeedancePrediction: vi.fn(async () => ({ id: 'seed-task-1' })),
};

export const moderationMocks = {
  screenText: vi.fn(async () => {}),
  screenImage: vi.fn(async () => {}),
};

export function resetApiMocks() {
  currentUser = null;
  metadata = {};
  historyUpserts.length = 0;
  for (const group of [replicateMocks, kieMocks, seedanceMocks, moderationMocks]) {
    for (const fn of Object.values(group)) fn.mockClear();
  }
  replicateMocks.getPrediction.mockImplementation(async () => ({ status: 'processing' }));
  kieMocks.getKiePrediction.mockImplementation(async () => ({ state: 'generating' }));
}
