// scripts/migrate-legacy-credits.mjs against PGlite and an in-memory Stripe
// stub only. Never a real key, never the network. Probes A, B, C, D and E of
// the round-1 adversarial review are the "re-run" and "renewal" tests below.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.js';

// Belt and braces: if anything reached lib/stripe's real client it would throw.
vi.mock('../lib/stripe.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stripe: () => {
      throw new Error('real Stripe client used in a test');
    },
  };
});

const { runMigration } = await import('../scripts/migrate-legacy-credits.mjs');
const { setCreditsDb, getBalance, renewPlanCredits } = await import('../lib/credits.js');
const { setGrantsDb, v2PlanAllotment, claimPendingGrants } = await import('../lib/grants.js');
const { setPricingDb, _resetPricingCache } = await import('../lib/pricing.js');
const { PLANS } = await import('../lib/stripe.js');
const { KEY } = await import('../lib/metaKeys.js');

const nowS = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
// The moment billing_v2 was turned on, for --cutoff (an hour ago by default).
const flipIso = (agoS = 3600) => new Date((nowS() - agoS) * 1000).toISOString();

function fakeStripe() {
  const customers = [];
  const subs = new Map(); // customer -> [sub]
  const writes = [];
  return {
    customers,
    subs,
    writes,
    api: {
      customers: {
        list: async ({ limit = 100, starting_after: after } = {}) => {
          const from = after ? customers.findIndex((c) => c.id === after) + 1 : 0;
          return { data: customers.slice(from, from + limit).map((c) => structuredClone(c)), has_more: from + limit < customers.length };
        },
        update: async (...args) => {
          writes.push(args);
          throw new Error('the migration must never write Stripe');
        },
        del: async (...args) => {
          writes.push(args);
          throw new Error('the migration must never delete in Stripe');
        },
      },
      subscriptions: {
        list: async ({ customer }) => ({ data: structuredClone(subs.get(customer) || []), has_more: false }),
      },
    },
  };
}

let db;
let S;
const reports = [];
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(db);
  setGrantsDb(db);
  setPricingDb(db);
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  setGrantsDb(null);
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

const linkProfile = (userId, customerId) =>
  db.query(
    `insert into public.profiles (id, stripe_customer_id) values ($1, $2)
     on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id`,
    [userId, customerId]
  );

function subscription(id, plan = 'monthly', { status = 'active', startedAgoS = DAY } = {}) {
  return { id: `sub_${id}`, status, current_period_start: nowS() - startedAgoS, items: { data: [{ price: { lookup_key: PLANS[plan].lookupKey } }] } };
}
function addCustomer(metadata, { plan = 'monthly', status = 'active', startedAgoS = DAY } = {}) {
  const id = `cus_${randomUUID().slice(0, 10)}`;
  S.customers.push({ id, metadata });
  if (plan) S.subs.set(id, [subscription(id, plan, { status, startedAgoS })]);
  return id;
}
const seeded = (credits, extra = {}) => ({
  [KEY.credits]: String(credits),
  [KEY.plan]: 'monthly',
  [KEY.periodStart]: String((nowS() - DAY) * 1000),
  [KEY.lastSeededCap]: String(PLANS.monthly.cap),
  ...extra,
});

async function run(args, env = {}) {
  const lines = [];
  const out = await runMigration({
    argv: args,
    env: { STRIPE_SECRET_KEY: 'sk_test_stub', ...env },
    stripeClient: S.api,
    log: (l) => lines.push(l),
    fail: (l) => lines.push(l),
    writeReport: (path, body) => reports.push({ path, body: JSON.parse(body) }),
  });
  return { ...out, lines };
}
const cutoff = (agoS) => `--cutoff=${flipIso(agoS)}`;
const dry = (extra = [], agoS) => run([cutoff(agoS), ...extra]);
async function apply(extra = [], agoS) {
  const d = await dry(extra, agoS);
  return run([cutoff(agoS), '--apply', `--confirm=${d.count}:${d.total}`, ...extra]);
}
const ledgerRows = async (userId) =>
  (await db.query('select reason, ref, amount, bucket, currency from public.credit_ledger where user_id = $1 order by id', [userId])).rows;

beforeEach(async () => {
  S = fakeStripe();
  reports.length = 0;
  await setV2(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('scripts/migrate-legacy-credits.mjs: dry run and apply', () => {
  it('--dry-run (the default) prints a row per customer of this app and writes nothing', async () => {
    const user = randomUUID();
    const sub = addCustomer(seeded(1000, { [KEY.imageCredits]: '45', creditsRemaining: '999' }));
    await linkProfile(user, sub);
    const orphan = addCustomer(seeded(100));
    addCustomer({ creditsRemaining: '50' }); // haelabs-only customer: skipped
    addCustomer({ [KEY.credits]: '0' }, { plan: null }); // ours, nothing to move

    const before = (await db.query('select count(*)::int as n from public.credit_ledger')).rows[0].n;
    const { lines, rows, count, total } = await dry();
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.customerId === sub);
    expect(a).toMatchObject({
      linkedUserId: user, legacyCredits: 1000, v2Credits: 210, legacyImageCredits: 45, imageCredits: 45, action: 'grant',
    });
    // Split: plan = this period's allotment still unspent (min(balance, cap)), the rest top-up.
    expect(a.split).toEqual({ videoPlan: 160, videoTopup: 50, imagePlan: 0, imageTopup: 45 });
    expect(rows.find((r) => r.customerId === orphan)).toMatchObject({ linkedUserId: null, v2Credits: 21, action: 'park' });
    expect(count).toBe(2);
    expect(total).toBe(210 + 45 + 21);
    expect(lines.join('\n')).toContain(sub);
    expect((await db.query('select count(*)::int as n from public.credit_ledger')).rows[0].n).toBe(before);
    expect((await db.query('select count(*)::int as n from public.credit_pending_grants')).rows[0].n).toBe(0);
    expect((await db.query('select count(*)::int as n from public.credit_legacy_migrations')).rows[0].n).toBe(0);
    expect(reports).toEqual([]);
    expect(S.writes).toEqual([]);
  });

  it('--cutoff is required; --apply needs --confirm=<rows>:<total v2 amount>', async () => {
    const user = randomUUID();
    const cid = addCustomer(seeded(500, { [KEY.imageCredits]: '10' }));
    await linkProfile(user, cid);
    const orphan = addCustomer(seeded(100, { [KEY.imageCredits]: '3' }));

    const noCutoff = await run([]);
    expect(noCutoff.ok).toBe(false);
    expect(noCutoff.lines.join('\n')).toMatch(/--cutoff/);

    const refused = await run([cutoff(), '--apply']);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join('\n')).toMatch(/--confirm=2:/);
    const rowsOnly = await run([cutoff(), '--apply', '--confirm=2']);
    expect(rowsOnly.ok).toBe(false);
    const wrongTotal = await run([cutoff(), '--apply', '--confirm=2:1']);
    expect(wrongTotal.ok).toBe(false);
    expect(await getBalance(user)).toMatchObject({ available: 0 });

    const first = await apply();
    expect(first.ok).toBe(true);
    expect(await getBalance(user)).toMatchObject({ plan: 105, topup: 0 });
    expect(await getBalance(user, 'image')).toMatchObject({ topup: 10 });
    const { rows: pending } = await db.query(
      'select currency, amount, bucket, reason, ref from public.credit_pending_grants where stripe_customer_id = $1 order by currency',
      [orphan]
    );
    expect(pending).toEqual([
      { currency: 'image', amount: 3, bucket: 'topup', reason: 'legacy_migration_image_topup', ref: `legacy-migration:${orphan}` },
      { currency: 'video', amount: 21, bucket: 'plan', reason: 'legacy_migration_plan', ref: `legacy-migration:${orphan}` },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0].body.rows.map((r) => r.result).sort()).toEqual(['migrated', 'parked']);
    expect(S.writes).toEqual([]);
  });

  it('a customer linked to several users is parked, not guessed', async () => {
    const cid = addCustomer(seeded(100));
    await linkProfile(randomUUID(), cid);
    await linkProfile(randomUUID(), cid);
    const { rows } = await dry();
    expect(rows[0]).toMatchObject({ linkedUserId: null, action: 'park_multi' });
  });
});

describe('re-runs never grant twice (probes A-D)', () => {
  it('A: the subscription ends between runs; the second run replays nothing', async () => {
    const user = randomUUID();
    const cid = addCustomer(seeded(500));
    await linkProfile(user, cid);
    expect((await apply()).ok).toBe(true);
    expect(await getBalance(user)).toMatchObject({ plan: 105, topup: 0 });
    const again = await apply();
    expect(again.rows[0].action).toBe('already');
    S.subs.get(cid)[0].status = 'canceled';
    const third = await apply();
    expect(third.rows[0].action).toBe('already');
    expect(await getBalance(user)).toMatchObject({ plan: 105, topup: 0, available: 105 });
    expect(await ledgerRows(user)).toEqual([
      { reason: 'legacy_migration_plan', ref: `legacy-migration:${cid}`, amount: 105, bucket: 'plan', currency: 'video' },
    ]);
  });

  it('B: the customer moves to another account between runs; nobody gets it twice', async () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    const cid = addCustomer(seeded(1000));
    await linkProfile(u1, cid);
    await apply();
    expect((await getBalance(u1)).available).toBe(210);
    await db.query('update public.profiles set stripe_customer_id = null where id = $1', [u1]);
    await linkProfile(u2, cid);
    const second = await apply();
    expect(second.rows[0].action).toBe('already');
    expect((await getBalance(u1)).available).toBe(210);
    expect((await getBalance(u2)).available).toBe(0);
  });

  it('C: parked at run 1, linked without a claim, the re-run claims the parked grant once', async () => {
    const u = randomUUID();
    const cid = addCustomer(seeded(1000));
    await apply(); // parked (no user)
    await linkProfile(u, cid);
    const d = await dry();
    expect(d.rows[0].action).toBe('already');
    const second = await apply();
    expect(second.rows[0].result).toBe('already');
    expect((await getBalance(u)).available).toBe(210);
    await apply();
    expect((await getBalance(u)).available).toBe(210);
  });

  it('D: dormant at run 1 (no plan): not migrated without --include-dormant; migrated once after subscribing', async () => {
    const u = randomUUID();
    const cid = addCustomer(seeded(300, { [KEY.periodStart]: String((nowS() - 40 * DAY) * 1000) }), { plan: null });
    await linkProfile(u, cid);
    const d = await dry();
    expect(d.rows[0]).toMatchObject({ action: 'dormant', legacyCredits: 300, v2Credits: 63 });
    expect(d.count).toBe(0);
    await apply();
    expect((await getBalance(u)).available).toBe(0);
    S.subs.set(cid, [subscription(cid, 'monthly', { startedAgoS: 7200 })]);
    const second = await apply();
    expect(second.rows[0].result).toBe('migrated');
    const third = await apply();
    expect(third.rows[0].action).toBe('already');
    const bal = await getBalance(u);
    // 300 left + the rollover of the period that started before the cutoff (760) = 1060 -> 223.
    expect(bal.available).toBe(223);
  });

  it('D2: --include-dormant migrates a churned balance as top-up, once', async () => {
    const u = randomUUID();
    const cid = addCustomer({ [KEY.credits]: '300' }, { plan: null });
    await linkProfile(u, cid);
    await apply(['--include-dormant']);
    expect(await getBalance(u)).toMatchObject({ topup: 63, plan: 0 });
    S.subs.set(cid, [subscription(cid)]);
    expect((await apply(['--include-dormant'])).rows[0].action).toBe('already');
    expect(await getBalance(u)).toMatchObject({ topup: 63, plan: 0 });
  });
});

describe('renewals around the switch (probe E)', () => {
  function renewedAfterFlip() {
    const user = randomUUID();
    // 100 left of last period; the stored period started 31 days ago; Stripe renewed a minute ago.
    const cid = addCustomer(seeded(100, { [KEY.periodStart]: String((nowS() - 31 * DAY) * 1000) }), { startedAgoS: 60 });
    return { user, cid };
  }

  it('a period that started after the cutoff is not simulated (the v2 webhook grants it)', async () => {
    const { user, cid } = renewedAfterFlip();
    await linkProfile(user, cid);
    await renewPlanCredits({ userId: user, allotment: v2PlanAllotment('monthly'), ref: 'invoice:in_renewal' });
    const out = await apply([], 3600); // flipped an hour ago
    expect(out.rows[0]).toMatchObject({ legacyCredits: 100, v2Credits: 21 });
    expect((await getBalance(user)).available).toBe(160 + 21);
  });

  it('a period that started before the cutoff is skipped when the ledger already has its renewal', async () => {
    const { user, cid } = renewedAfterFlip();
    await linkProfile(user, cid);
    await renewPlanCredits({ userId: user, allotment: v2PlanAllotment('monthly'), ref: 'invoice:in_renewal_2' });
    const out = await apply([], 10); // flipped 10 s ago, after the renewal started
    expect(out.rows[0].legacyCredits).toBe(100);
    expect((await getBalance(user)).available).toBe(160 + 21);
  });

  it('a period that started before the cutoff with no v2 renewal is included', async () => {
    const { user, cid } = renewedAfterFlip();
    await linkProfile(user, cid);
    const out = await apply([], 10);
    expect(out.rows[0].legacyCredits).toBe(100 + PLANS.monthly.cap);
    expect(out.rows[0].split).toMatchObject({ videoPlan: 160 });
  });
});

describe('round 2: a renewal parked for the customer counts too (probe E4)', () => {
  const parkRenewal = (cid, ref) =>
    db.query(
      `insert into public.credit_pending_grants (stripe_customer_id, currency, amount, original_amount, bucket, reason, ref)
       values ($1, 'video', $2, $2, 'plan', 'plan_renewal', $3)`,
      [cid, v2PlanAllotment('monthly'), ref]
    );

  it('unlinked: the parked renewal is not simulated again; after link and claim the customer has 181', async () => {
    const u = randomUUID();
    const cid = addCustomer(seeded(100, { [KEY.periodStart]: String((nowS() - 31 * DAY) * 1000) }), { startedAgoS: 3 * 3600 });
    await parkRenewal(cid, `invoice:in_E4_${cid}`);
    const out = await apply();
    expect(out.rows[0]).toMatchObject({ legacyCredits: 100, v2Credits: 21, action: 'park' });
    await linkProfile(u, cid);
    await claimPendingGrants(cid, u);
    expect((await getBalance(u)).available).toBe(160 + 21);
  });

  it('linked but not yet claimed: the same', async () => {
    const u = randomUUID();
    const cid = addCustomer(seeded(100, { [KEY.periodStart]: String((nowS() - 31 * DAY) * 1000) }), { startedAgoS: 3 * 3600 });
    await parkRenewal(cid, `invoice:in_E4b_${cid}`);
    await linkProfile(u, cid);
    const out = await apply();
    expect(out.rows[0]).toMatchObject({ legacyCredits: 100, v2Credits: 21 });
    expect((await getBalance(u)).available).toBe(160 + 21); // the re-run claim delivered the parked renewal
  });
});

describe('trials', () => {
  it('the remaining trial credits move too (x0.21, rounded up)', async () => {
    const u = randomUUID();
    const cid = addCustomer({ [KEY.credits]: '100', [KEY.trialCreditsUsed]: '1', [KEY.plan]: 'monthly' }, { status: 'trialing' });
    await linkProfile(u, cid);
    const d = await dry();
    // 1 trial credit left + 100 top-up = 101 -> 22, all top-up.
    expect(d.rows[0]).toMatchObject({ legacyCredits: 101, v2Credits: 22, action: 'grant' });
    expect(d.rows[0].split).toMatchObject({ videoPlan: 0, videoTopup: 22 });
  });
});

describe('guards', () => {
  it('refuses a live key unless --allow-live, and refuses --apply while billing_v2 is off', async () => {
    const cid = addCustomer(seeded(100));
    for (const key of ['sk_live_abc', 'rk_live_abc']) {
      const out = await run([cutoff()], { STRIPE_SECRET_KEY: key });
      expect(out.ok).toBe(false);
      expect(out.lines.join('\n')).toMatch(/live/i);
    }
    expect((await run([cutoff(), '--allow-live'], { STRIPE_SECRET_KEY: 'sk_live_abc' })).ok).toBe(true);
    await setV2(false);
    const off = await run([cutoff(), '--apply', '--confirm=1:21']);
    expect(off.ok).toBe(false);
    expect(off.lines.join('\n')).toMatch(/billing_v2/);
    expect(
      (await db.query('select count(*)::int as n from public.credit_pending_grants where stripe_customer_id = $1', [cid])).rows[0].n
    ).toBe(0);
  });

  it('as a command with no key it refuses cleanly (plain node, nothing contacted)', () => {
    const script = fileURLToPath(new URL('../scripts/migrate-legacy-credits.mjs', import.meta.url));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/STRIPE_SECRET_KEY/);
    const live = spawnSync(process.execPath, [script, '--dry-run'], {
      env: { ...env, STRIPE_SECRET_KEY: 'sk_live_not_a_real_key' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(live.status).toBe(2);
    expect(live.stderr).toMatch(/live/i);
  }, 30_000);
});
