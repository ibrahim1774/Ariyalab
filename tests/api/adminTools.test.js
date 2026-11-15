// The admin gate (lib/adminGate.js) on every admin surface, and the manual
// grant tool (pages/api/admin/grant-credits.js): full account search and an
// idempotent grant through the ledger (billing_v2) or a once-per-ref legacy
// write. Stripe and Supabase are in-memory stubs; no network.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/apiMock';

const S = vi.hoisted(() => ({
  user: null,
  db: null,
  users: [], // the Supabase auth user list (paginated by listUsers)
  endlessUsers: false,
  listCalls: 0,
  customers: new Map(),
  updates: [],
}));

vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal();
  const api = {
    customers: {
      retrieve: async (id) => {
        const c = S.customers.get(id);
        if (!c) throw Object.assign(new Error('No such customer'), { code: 'resource_missing' });
        return structuredClone(c);
      },
      update: async (id, { metadata }) => {
        S.updates.push({ id, metadata: { ...metadata } });
        const c = S.customers.get(id);
        c.metadata = { ...c.metadata, ...metadata };
        return structuredClone(c);
      },
    },
  };
  return { ...actual, stripe: () => api };
});
vi.mock('../../lib/supabaseServer', () => {
  const client = {
    auth: {
      admin: {
        // Like Supabase: `perPage` users from page 1, and nextPage (null on the last page).
        listUsers: async ({ page = 1, perPage = 50 } = {}) => {
          S.listCalls += 1;
          if (S.endlessUsers) {
            const users = Array.from({ length: perPage }, (_, i) => ({ id: randomUUID(), email: `f-${page}-${i}@x.test` }));
            return { data: { users, nextPage: page + 1 }, error: null };
          }
          const users = S.users.slice((page - 1) * perPage, page * perPage);
          const nextPage = page * perPage < S.users.length ? page + 1 : null;
          return { data: { users, nextPage }, error: null };
        },
      },
    },
    from: () => ({
      select: () => ({
        eq: (_col, id) => ({
          maybeSingle: async () => {
            const { rows } = await S.db.query('select stripe_customer_id from public.profiles where id = $1', [id]);
            return { data: rows[0] || null, error: null };
          },
        }),
      }),
    }),
  };
  return {
    getUserFromRequest: async () => (S.user ? { user: S.user, supabase: client } : null),
    getSupabaseAdmin: () => client,
  };
});

const { setCreditsDb, getBalance } = await import('../../lib/credits.js');
const { setPricingDb, _resetPricingCache } = await import('../../lib/pricing.js');
const { setGrantsDb } = await import('../../lib/grants.js');
const { requireAdmin, checkAdmin } = await import('../../lib/adminGate.js');
const { KEY } = await import('../../lib/metaKeys');
const grantCreditsRoute = (await import('../../pages/api/admin/grant-credits.js')).default;
const featureTabs = (await import('../../pages/api/admin/feature-tabs.js')).default;
const healTopups = (await import('../../pages/api/admin/heal-topups.js')).default;
const trackingData = (await import('../../pages/api/tracking-data.js')).default;
const { getServerSideProps: adminPageProps } = await import('../../pages/admin/index.js');
const { middleware } = await import('../../middleware.js');

let db;
beforeAll(async () => {
  db = await createTestDb();
  S.db = db;
  setCreditsDb(db);
  setPricingDb(db);
  setGrantsDb(db);
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  setPricingDb(null);
  setGrantsDb(null);
  await db?.close();
});

const PREV_ADMINS = process.env.ADMIN_EMAILS;
const CONFIRMED = '2026-11-01T00:00:00Z';
const ADMIN = { id: randomUUID(), email: 'boss@example.test', email_confirmed_at: CONFIRMED };

async function setV2(on) {
  await db.query(
    `insert into public.pricing_config (key, value) values ('billing_v2', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(on)]
  );
  _resetPricingCache();
}

beforeEach(() => {
  process.env.ADMIN_EMAILS = ADMIN.email;
  S.user = ADMIN;
  S.users = [];
  S.endlessUsers = false;
  S.listCalls = 0;
  S.customers = new Map();
  S.updates = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (PREV_ADMINS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = PREV_ADMINS;
  vi.restoreAllMocks();
});

async function call(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

describe('lib/adminGate.js requireAdmin', () => {
  const gate = async () => {
    const res = makeRes();
    const out = await requireAdmin(makeReq(), res);
    return { out, res };
  };

  it('ADMIN_EMAILS unset: 503 for everyone, including the old built-in address', async () => {
    delete process.env.ADMIN_EMAILS;
    S.user = { id: randomUUID(), email: 'ibrahim3709@gmail.com', email_confirmed_at: CONFIRMED };
    const { out, res } = await gate();
    expect(out).toBeNull();
    expect(res.statusCode).toBe(503);
    process.env.ADMIN_EMAILS = '  ';
    expect((await gate()).res.statusCode).toBe(503);
  });

  it('no session: 401', async () => {
    S.user = null;
    expect((await gate()).res.statusCode).toBe(401);
  });

  it('an admin email that is not confirmed: 403', async () => {
    S.user = { id: randomUUID(), email: ADMIN.email };
    const { out, res } = await gate();
    expect(out).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_ADMIN');
  });

  it('a confirmed non-admin: 403', async () => {
    S.user = { id: randomUUID(), email: 'someone@example.test', email_confirmed_at: CONFIRMED };
    expect((await gate()).res.statusCode).toBe(403);
  });

  it('a confirmed admin passes (case and spaces in ADMIN_EMAILS do not matter)', async () => {
    process.env.ADMIN_EMAILS = ` other@x.test , BOSS@example.test `;
    const { out, res } = await gate();
    expect(out.user.id).toBe(ADMIN.id);
    expect(res.body).toBeUndefined();
    expect((await checkAdmin(makeReq(), makeRes())).status).toBe(200);
  });
});

describe('every admin surface uses the gate', () => {
  const unconfirmed = () => {
    S.user = { id: randomUUID(), email: ADMIN.email };
  };

  it('grant-credits, heal-topups, feature-tabs and tracking-data refuse an unconfirmed admin email', async () => {
    unconfirmed();
    expect((await call(grantCreditsRoute, { body: { email: 'a@x.test', credits: 5, ref: 'r1' } })).statusCode).toBe(403);
    expect((await call(healTopups, { body: { email: 'a@x.test' } })).statusCode).toBe(403);
    expect((await call(featureTabs, { method: 'GET' })).statusCode).toBe(403);
    expect((await call(trackingData, { method: 'GET' })).statusCode).toBe(403);
  });

  it('with ADMIN_EMAILS unset they all answer 503', async () => {
    delete process.env.ADMIN_EMAILS;
    expect((await call(grantCreditsRoute, { body: { email: 'a@x.test', credits: 5, ref: 'r1' } })).statusCode).toBe(503);
    expect((await call(healTopups, { body: { email: 'a@x.test' } })).statusCode).toBe(503);
    expect((await call(featureTabs, { method: 'GET' })).statusCode).toBe(503);
    expect((await call(trackingData, { method: 'GET' })).statusCode).toBe(503);
  });

  it('the /admin page checks on the server', async () => {
    const ctx = () => ({ req: { headers: {} }, res: { setHeader() {}, getHeader() {} }, resolvedUrl: '/admin' });
    expect(await adminPageProps(ctx())).toMatchObject({ props: { gate: 'ok', adminEmail: ADMIN.email } });
    unconfirmed();
    expect(await adminPageProps(ctx())).toEqual({ props: { gate: 'forbidden', adminEmail: null } });
    delete process.env.ADMIN_EMAILS;
    expect(await adminPageProps(ctx())).toEqual({ props: { gate: 'disabled', adminEmail: null } });
    process.env.ADMIN_EMAILS = ADMIN.email;
    S.user = null;
    expect((await adminPageProps(ctx())).redirect.destination).toBe('/sign-in?returnTo=%2Fadmin');
  });
});

describe('middleware has no built-in admin', () => {
  it('the gated tabs need ADMIN_EMAILS and a confirmed email', async () => {
    const { isConfirmedAdmin } = await import('../../lib/adminEmails.js');
    delete process.env.ADMIN_EMAILS;
    expect(isConfirmedAdmin({ email: 'ibrahim3709@gmail.com', email_confirmed_at: CONFIRMED })).toBe(false);
    expect(typeof middleware).toBe('function');
  });
});

describe('pages/api/admin/grant-credits.js', () => {
  const target = () => ({ id: randomUUID(), email: `t-${randomUUID()}@example.test` });
  const fill = (n) => Array.from({ length: n }, () => target());
  const grant = (body) => call(grantCreditsRoute, { body });

  it('needs a ref (one per submission) so a retry cannot grant twice', async () => {
    await setV2(true);
    const t = target();
    S.users = [t];
    const res = await grant({ email: t.email, credits: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/ref/);
  });

  it('billing_v2: a top-up grant in the ledger, once per ref, found past the first 1,000 users', async () => {
    await setV2(true);
    const t = target();
    S.users = [...fill(2_500), t];
    const ref = randomUUID();
    const first = await grant({ email: t.email, credits: 40, ref });
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ ok: true, billing: 'v2', added: 40, supabaseUserId: t.id });
    const again = await grant({ email: t.email, credits: 40, ref });
    expect(again.statusCode).toBe(200);
    expect(await getBalance(t.id)).toMatchObject({ topup: 40, plan: 0 });
    // A user on the third page: the search followed nextPage to the end.
    expect(S.listCalls).toBeGreaterThanOrEqual(3);
    // A used ref grants nothing more, whatever the amount.
    const reused = await grant({ email: t.email, credits: 41, ref });
    expect(reused.body.already).toBe(true);
    expect(await getBalance(t.id)).toMatchObject({ topup: 40 });
    expect(S.updates).toEqual([]);
  });

  it('a search that never ends is an explicit error, not "no user"', async () => {
    await setV2(true);
    S.endlessUsers = true;
    const res = await grant({ email: 'nobody@example.test', credits: 5, ref: randomUUID() });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/incomplete/i);
  });

  it('an unknown email is 404 only after the last page', async () => {
    await setV2(true);
    S.users = fill(1_200);
    const res = await grant({ email: 'nobody@example.test', credits: 5, ref: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(S.listCalls).toBe(2);
  });

  it('legacy: adds to this app\'s credit key once per ref and sends only that key', async () => {
    await setV2(false);
    const t = target();
    S.users = [t];
    await db.query('insert into public.profiles (id, stripe_customer_id) values ($1, $2)', [t.id, 'cus_grant']);
    S.customers.set('cus_grant', { id: 'cus_grant', metadata: { [KEY.credits]: '10', creditsRemaining: '3' } });
    const ref = randomUUID();
    const first = await grant({ email: t.email, credits: 25, ref });
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ ok: true, billing: 'legacy', beforeCredits: 10, afterCredits: 35 });
    const again = await grant({ email: t.email, credits: 25, ref });
    expect(again.statusCode).toBe(200);
    expect(again.body.already).toBe(true);
    expect(S.customers.get('cus_grant').metadata).toEqual({ [KEY.credits]: '35', creditsRemaining: '3' });
    expect(S.updates).toEqual([{ id: 'cus_grant', metadata: { [KEY.credits]: '35' } }]);
  });

  it('legacy: no linked Stripe customer is 404 NO_CUSTOMER', async () => {
    await setV2(false);
    const t = target();
    S.users = [t];
    const res = await grant({ email: t.email, credits: 5, ref: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NO_CUSTOMER');
  });
});

describe('round 1 minors', () => {
  it('only email_confirmed_at counts as a confirmed email', async () => {
    const { isConfirmedAdmin } = await import('../../lib/adminEmails.js');
    expect(isConfirmedAdmin({ email: ADMIN.email, confirmed_at: CONFIRMED })).toBe(false);
    expect(isConfirmedAdmin({ email: ADMIN.email, email_confirmed_at: CONFIRMED })).toBe(true);
  });

  it('a grant ref is used once across all users (billing_v2)', async () => {
    await setV2(true);
    const a = { id: randomUUID(), email: `a-${randomUUID()}@example.test` };
    const b = { id: randomUUID(), email: `b-${randomUUID()}@example.test` };
    S.users = [a, b];
    const ref = randomUUID();
    expect((await call(grantCreditsRoute, { body: { email: a.email, credits: 10, ref } })).statusCode).toBe(200);
    const reused = await call(grantCreditsRoute, { body: { email: b.email, credits: 10, ref } });
    expect(reused.statusCode).toBe(200);
    expect(reused.body.already).toBe(true);
    expect((await getBalance(a.id)).available).toBe(10);
    expect((await getBalance(b.id)).available).toBe(0);
  });

  it('the admin page says which credits a grant adds', async () => {
    const ctx = { req: { headers: {} }, res: { setHeader() {}, getHeader() {} }, resolvedUrl: '/admin' };
    await setV2(true);
    expect((await adminPageProps(ctx)).props.billing).toBe('v2');
    await setV2(false);
    expect((await adminPageProps(ctx)).props.billing).toBe('legacy');
  });
});
