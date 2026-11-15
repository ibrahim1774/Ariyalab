// scripts/migrate-legacy-credits.mjs against PGlite and an in-memory Stripe
// stub only. Never a real key, never the network.
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
const { setCreditsDb, getBalance } = await import('../lib/credits.js');
const { setGrantsDb } = await import('../lib/grants.js');
const { setPricingDb, _resetPricingCache } = await import('../lib/pricing.js');
const { PLANS } = await import('../lib/stripe.js');
const { KEY } = await import('../lib/metaKeys.js');

const nowS = () => Math.floor(Date.now() / 1000);

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
  db.query('insert into public.profiles (id, stripe_customer_id) values ($1, $2)', [userId, customerId]);

function addCustomer(metadata, { plan = null, status = 'active' } = {}) {
  const id = `cus_${randomUUID().slice(0, 10)}`;
  S.customers.push({ id, metadata });
  if (plan) {
    S.subs.set(id, [
      { id: `sub_${id}`, status, current_period_start: nowS() - 86400, items: { data: [{ price: { lookup_key: PLANS[plan].lookupKey } }] } },
    ]);
  }
  return id;
}

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

beforeEach(async () => {
  S = fakeStripe();
  reports.length = 0;
  await setV2(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('scripts/migrate-legacy-credits.mjs', () => {
  it('--dry-run (the default) prints a row per customer of this app and writes nothing', async () => {
    const user = randomUUID();
    const sub = addCustomer(
      {
        [KEY.credits]: '1000', [KEY.imageCredits]: '45', [KEY.plan]: 'monthly',
        [KEY.periodStart]: String((nowS() - 86400) * 1000), [KEY.lastSeededCap]: String(PLANS.monthly.cap),
        creditsRemaining: '999', // haelabs.live: not ours
      },
      { plan: 'monthly' }
    );
    await linkProfile(user, sub);
    const orphan = addCustomer({ [KEY.credits]: '100' });
    addCustomer({ creditsRemaining: '50' }); // haelabs-only customer: skipped
    addCustomer({ [KEY.credits]: '0' }); // ours, nothing to move

    const before = (await db.query('select count(*)::int as n from public.credit_ledger')).rows[0].n;
    const { lines, rows, count } = await run([]);
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.customerId === sub);
    expect(a).toMatchObject({
      linkedUserId: user, legacyCredits: 1000, v2Credits: 210, legacyImageCredits: 45, imageCredits: 45, action: 'grant',
    });
    // Split: plan = this period's allotment still unspent (min(balance, cap)), the rest top-up.
    expect(a.split).toEqual({ videoPlan: 160, videoTopup: 50, imageTopup: 45 });
    expect(rows.find((r) => r.customerId === orphan)).toMatchObject({ linkedUserId: null, v2Credits: 21, action: 'park' });
    expect(count).toBe(2);
    expect(lines.join('\n')).toContain(sub);
    expect((await db.query('select count(*)::int as n from public.credit_ledger')).rows[0].n).toBe(before);
    expect((await db.query('select count(*)::int as n from public.credit_pending_grants')).rows[0].n).toBe(0);
    expect(reports).toEqual([]);
    expect(S.writes).toEqual([]);
  });

  it('--apply needs --confirm=<the dry-run count>, then grants once even when run twice', async () => {
    const user = randomUUID();
    const cid = addCustomer({ [KEY.credits]: '500', [KEY.imageCredits]: '10' });
    await linkProfile(user, cid);
    const orphan = addCustomer({ [KEY.credits]: '100', [KEY.imageCredits]: '3' });

    const refused = await run(['--apply']);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join('\n')).toMatch(/--confirm=2/);
    const wrong = await run(['--apply', '--confirm=3']);
    expect(wrong.ok).toBe(false);
    expect(await getBalance(user)).toMatchObject({ available: 0 });

    const first = await run(['--apply', '--confirm=2']);
    expect(first.ok).toBe(true);
    expect(await getBalance(user)).toMatchObject({ topup: 105, plan: 0 });
    expect(await getBalance(user, 'image')).toMatchObject({ topup: 10 });
    const { rows: pending } = await db.query(
      'select currency, amount, bucket, reason, ref from public.credit_pending_grants where stripe_customer_id = $1 order by currency',
      [orphan]
    );
    expect(pending).toEqual([
      { currency: 'image', amount: 3, bucket: 'topup', reason: 'legacy_migration_image_topup', ref: `legacy-migration:${orphan}` },
      { currency: 'video', amount: 21, bucket: 'topup', reason: 'legacy_migration_topup', ref: `legacy-migration:${orphan}` },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0].body.rows.map((r) => r.result).sort()).toEqual(['granted', 'parked']);

    // Second run: nothing left to do, nothing granted again.
    const dry = await run([]);
    expect(dry.count).toBe(0);
    expect(dry.rows.every((r) => r.action === 'already')).toBe(true);
    const second = await run(['--apply', '--confirm=0']);
    expect(second.ok).toBe(true);
    expect(await getBalance(user)).toMatchObject({ topup: 105 });
    expect((await db.query('select count(*)::int as n from public.credit_pending_grants where stripe_customer_id = $1', [orphan])).rows[0].n).toBe(2);
    const { rows: ledger } = await db.query(
      "select count(*)::int as n from public.credit_ledger where ref = $1", [`legacy-migration:${cid}`]
    );
    expect(ledger[0].n).toBe(2);
    expect(S.writes).toEqual([]);
  });

  it('reads the balance the legacy reader would show (a pending rollover is included)', async () => {
    const user = randomUUID();
    const cid = addCustomer(
      {
        [KEY.credits]: '40', [KEY.plan]: 'monthly', [KEY.lastSeededCap]: String(PLANS.monthly.cap),
        [KEY.periodStart]: String((nowS() - 40 * 86400) * 1000), // the period rolled over since
      },
      { plan: 'monthly' }
    );
    await linkProfile(user, cid);
    const { rows } = await run([]);
    expect(rows[0].legacyCredits).toBe(40 + PLANS.monthly.cap);
    expect(rows[0].split).toMatchObject({ videoPlan: 160 });
  });

  it('a customer linked to several users is parked, not guessed', async () => {
    const cid = addCustomer({ [KEY.credits]: '100' });
    await linkProfile(randomUUID(), cid);
    await linkProfile(randomUUID(), cid);
    const { rows } = await run([]);
    expect(rows[0]).toMatchObject({ linkedUserId: null, action: 'park_multi' });
  });

  it('refuses a live key unless --allow-live, and refuses --apply while billing_v2 is off', async () => {
    const cid = addCustomer({ [KEY.credits]: '100' });
    for (const key of ['sk_live_abc', 'rk_live_abc']) {
      const out = await run([], { STRIPE_SECRET_KEY: key });
      expect(out.ok).toBe(false);
      expect(out.lines.join('\n')).toMatch(/live/i);
    }
    expect((await run(['--allow-live'], { STRIPE_SECRET_KEY: 'sk_live_abc' })).ok).toBe(true);
    await setV2(false);
    const off = await run(['--apply', '--confirm=1']);
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
  });
});
