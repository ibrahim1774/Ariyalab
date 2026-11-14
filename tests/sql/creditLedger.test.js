import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, migrationFiles } from '../helpers/db.js';

let db;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const balance = async (user, currency = 'video') =>
  (await one('select credit_balance($1, $2) as b', [user, currency])).b;

const grant = async (user, amount, bucket = 'plan', ref = randomUUID(), reason = 'test_grant', currency = 'video') =>
  (await one('select credit_grant($1, $2, $3, $4, $5, $6) as b', [user, currency, amount, bucket, reason, ref])).b;

const spend = async (user, amount, ref = randomUUID(), reason = 'test_spend', currency = 'video') =>
  (await one('select credit_spend($1, $2, $3, $4, $5) as b', [user, currency, amount, reason, ref])).b;

const hold = async (user, amount, projectId = randomUUID(), currency = 'video', q = db, holdId = null) =>
  (await q.query('select credit_hold($1, $2, $3, $4, $5) as id', [user, currency, amount, projectId, holdId])).rows[0].id;

const settle = async (holdId, amount, ref, reason = 'shot') =>
  (await one('select credit_settle($1, $2, $3, $4) as b', [holdId, amount, reason, ref])).b;

const release = async (holdId, amount = null, ref = amount === null ? null : randomUUID()) =>
  (await one('select credit_release($1, $2, $3) as b', [holdId, amount, ref])).b;

const renew = async (user, allotment, ref = randomUUID()) =>
  (await one('select credit_renew_plan($1, $2, $3) as b', [user, allotment, ref])).b;

const clawback = async (user, amount, ref = randomUUID(), reason = 'refund', currency = 'video', firstBucket = null) =>
  (await one('select credit_clawback($1, $2, $3, $4, $5, $6) as b', [user, currency, amount, reason, ref, firstBucket])).b;

const owed = async (user, currency = 'video') =>
  (await one('select clawback_owed from credit_accounts where user_id = $1 and currency = $2', [user, currency])).clawback_owed;

const holdRow = async (holdId) => one('select amount, remaining, status from credit_holds where id = $1', [holdId]);

const ledgerRows = async (user, currency = 'video') =>
  (await db.query('select * from credit_ledger where user_id = $1 and currency = $2 order by id', [user, currency])).rows;

const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
};

const bal = (plan, topup, held = 0) => ({ plan, topup, held, available: plan + topup - held });

describe('credit ledger', () => {
  it('grant then balance', async () => {
    const user = randomUUID();
    expect(await balance(user)).toEqual(bal(0, 0));
    expect(await grant(user, 1500, 'plan')).toEqual(bal(1500, 0));
    expect(await grant(user, 700, 'topup')).toEqual(bal(1500, 700));
    expect(await balance(user)).toEqual(bal(1500, 700));
    expect(await balance(user, 'image')).toEqual(bal(0, 0));

    const rows = await ledgerRows(user);
    expect(rows.map((r) => [r.delta, r.bucket, r.balance_after])).toEqual([
      [1500, 'plan', 1500],
      [700, 'topup', 2200],
    ]);
  });

  it('duplicate (reason, ref) grant is a no-op', async () => {
    const user = randomUUID();
    const first = await grant(user, 700, 'topup', 'cs_123', 'checkout');
    const second = await grant(user, 700, 'topup', 'cs_123', 'checkout');
    expect(second).toEqual(first);
    expect(await balance(user)).toEqual(bal(0, 700));
    expect(await ledgerRows(user)).toHaveLength(1);

    // Same ref under another reason is a different event.
    await grant(user, 100, 'topup', 'cs_123', 'bonus');
    expect(await balance(user)).toEqual(bal(0, 800));
  });

  it('spend takes plan before topup', async () => {
    const user = randomUUID();
    await grant(user, 100, 'plan');
    await grant(user, 50, 'topup');
    expect(await spend(user, 120)).toEqual(bal(0, 30));

    const [, , spendRow] = await ledgerRows(user);
    expect(spendRow).toMatchObject({ delta: -120, plan_delta: -100, topup_delta: -20, bucket: 'mixed', balance_after: 30 });
  });

  it('spend is idempotent on (reason, ref)', async () => {
    const user = randomUUID();
    await grant(user, 100);
    const first = await spend(user, 40, 'job-1');
    expect(await spend(user, 40, 'job-1')).toEqual(first);
    expect(await balance(user)).toEqual(bal(60, 0));
  });

  it('spend over balance raises insufficient_credits', async () => {
    const user = randomUUID();
    await grant(user, 100, 'plan');
    await grant(user, 20, 'topup');

    const err = await errorOf(spend(user, 121));
    expect(err.message).toBe('insufficient_credits');
    expect(JSON.parse(err.detail)).toEqual({ needed: 121, available: 120 });
    expect(await balance(user)).toEqual(bal(100, 20));

    // Held credits are not spendable.
    await hold(user, 100);
    const heldErr = await errorOf(spend(user, 30));
    expect(JSON.parse(heldErr.detail)).toEqual({ needed: 30, available: 20 });
  });

  it('rejects non-positive amounts and unknown currencies or buckets', async () => {
    const user = randomUUID();
    expect((await errorOf(grant(user, 0))).message).toBe('invalid_amount');
    expect((await errorOf(grant(user, -5))).message).toBe('invalid_amount');
    expect((await errorOf(spend(user, 0))).message).toBe('invalid_amount');
    expect((await errorOf(grant(user, 10, 'gold'))).message).toBe('invalid_bucket');
    expect((await errorOf(grant(user, 10, 'plan', randomUUID(), 'x', 'gems'))).message).toBe('invalid_currency');
  });

  it('hold reduces available, not plan', async () => {
    const user = randomUUID();
    await grant(user, 100);
    const projectId = randomUUID();
    const holdId = await hold(user, 60, projectId);
    expect(await balance(user)).toEqual(bal(100, 0, 60));
    expect(await holdRow(holdId)).toEqual({ amount: 60, remaining: 60, status: 'active' });
    expect(await ledgerRows(user)).toHaveLength(1); // holds are not ledger rows

    const err = await errorOf(hold(user, 41));
    expect(err.message).toBe('insufficient_credits');
    expect(JSON.parse(err.detail)).toEqual({ needed: 41, available: 40 });
  });

  it('concurrent holds cannot overdraw', async () => {
    // PGlite has one connection and runs these transactions one after the
    // other, so this proves the check-under-lock logic rejects the second
    // hold, not that FOR UPDATE serializes real concurrent sessions.
    const user = randomUUID();
    await grant(user, 100);
    const attempt = () => db.transaction((tx) => hold(user, 60, randomUUID(), 'video', tx));

    const results = await Promise.allSettled([attempt(), attempt()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.message).toBe('insufficient_credits');

    expect(await balance(user)).toEqual(bal(100, 0, 60));
    const holds = (await db.query("select amount from credit_holds where user_id = $1 and status = 'active'", [user])).rows;
    expect(holds).toEqual([{ amount: 60 }]);
  });

  it('the account table itself refuses held above plan + topup', async () => {
    // Backstop that holds on real Postgres even without the row lock: a
    // concurrent UPDATE re-checks constraints against the newest row version.
    const user = randomUUID();
    await grant(user, 100);
    await hold(user, 60);
    const err = await errorOf(
      db.query("update credit_accounts set held = held + 60 where user_id = $1 and currency = 'video'", [user]),
    );
    expect(err.message).toMatch(/check constraint/);
    expect(await balance(user)).toEqual(bal(100, 0, 60));
  });

  it('settle is idempotent on ref and cannot exceed remaining', async () => {
    const user = randomUUID();
    await grant(user, 50, 'plan');
    await grant(user, 100, 'topup');
    const projectId = randomUUID();
    const holdId = await hold(user, 120, projectId);

    const first = await settle(holdId, 70, 'shot-1');
    expect(first).toEqual(bal(0, 80, 50)); // 50 from plan, 20 from topup
    expect(await settle(holdId, 70, 'shot-1')).toEqual(first);
    expect(await holdRow(holdId)).toEqual({ amount: 120, remaining: 50, status: 'active' });

    const err = await errorOf(settle(holdId, 51, 'shot-2'));
    expect(err.message).toBe('hold_exceeded');
    expect(await balance(user)).toEqual(bal(0, 80, 50));

    // Settling the rest closes the hold; a retry of that same call still
    // returns the result instead of failing on the closed hold.
    const last = await settle(holdId, 50, 'shot-2');
    expect(last).toEqual(bal(0, 30, 0));
    expect(await holdRow(holdId)).toEqual({ amount: 120, remaining: 0, status: 'closed' });
    expect(await settle(holdId, 50, 'shot-2')).toEqual(last);

    const settled = (await ledgerRows(user)).filter((r) => r.reason === 'shot');
    expect(settled.map((r) => [r.ref, r.delta, r.project_id])).toEqual([
      ['shot-1', -70, projectId],
      ['shot-2', -50, projectId],
    ]);

    expect((await errorOf(settle(holdId, 1, 'shot-3'))).message).toBe('hold_closed');
    expect((await errorOf(settle(randomUUID(), 1, 'shot-4'))).message).toBe('hold_not_found');
  });

  it('release returns the rest', async () => {
    const user = randomUUID();
    await grant(user, 100);
    const holdId = await hold(user, 80);
    await settle(holdId, 30, 'shot-1');
    expect(await balance(user)).toEqual(bal(70, 0, 50));

    expect(await release(holdId, 20)).toEqual(bal(70, 0, 30));
    expect(await holdRow(holdId)).toEqual({ amount: 80, remaining: 30, status: 'active' });
    expect((await errorOf(release(holdId, 31))).message).toBe('hold_exceeded');

    expect(await release(holdId)).toEqual(bal(70, 0, 0));
    expect(await holdRow(holdId)).toEqual({ amount: 80, remaining: 0, status: 'closed' });

    // Releasing "the rest" of a closed hold is a harmless no-op.
    expect(await release(holdId)).toEqual(bal(70, 0, 0));
    expect((await errorOf(release(holdId, 5))).message).toBe('hold_closed');
    expect((await ledgerRows(user)).map((r) => [r.reason, r.delta])).toEqual([
      ['test_grant', 100],
      ['shot', -30],
      ['hold_release', 0],
    ]);
  });

  it('renew caps rollover at one allotment', async () => {
    const low = randomUUID();
    await grant(low, 400, 'plan');
    await grant(low, 700, 'topup');
    expect(await renew(low, 1500, 'in_1')).toEqual(bal(1900, 700));

    const high = randomUUID();
    await grant(high, 2000, 'plan');
    const renewed = await renew(high, 1500, 'in_2');
    expect(renewed).toEqual(bal(3000, 0));
    expect(await renew(high, 1500, 'in_2')).toEqual(renewed);
    expect((await ledgerRows(high)).map((r) => [r.reason, r.ref, r.delta])).toEqual([
      ['test_grant', expect.any(String), 2000],
      ['plan_renewal', 'in_2', 1500],
      ['plan_expiry', 'in_2', -500],
    ]);
  });

  it('renew never expires credits that are on hold', async () => {
    const user = randomUUID();
    await grant(user, 5000, 'plan');
    await hold(user, 4500);
    // Target is 1500 + 1500 = 3000, but expiry stops at the 4500 held.
    expect(await renew(user, 1500)).toEqual(bal(4500, 0, 4500));
  });

  it('renew with credits on hold still lands on the contract value', async () => {
    const user = randomUUID();
    await grant(user, 2000, 'plan');
    await hold(user, 1800);
    expect(await renew(user, 1500)).toEqual(bal(3000, 0, 1800));
  });

  it('holding everything across renewals does not grow the plan', async () => {
    const user = randomUUID();
    await grant(user, 3000, 'plan');
    for (let i = 0; i < 3; i += 1) {
      const holdId = await hold(user, 3000);
      await renew(user, 1500);
      await release(holdId);
      expect(await balance(user)).toEqual(bal(3000, 0));
    }
  });

  it('clawback floors at 0', async () => {
    const user = randomUUID();
    await grant(user, 100, 'plan');
    await grant(user, 50, 'topup');
    const first = await clawback(user, 300, 'ch_1');
    expect(first).toEqual({ ...bal(0, 0), taken: 150, owed: 0 });
    expect(await clawback(user, 300, 'ch_1')).toEqual(first);
    const row = (await ledgerRows(user)).at(-1);
    expect(row).toMatchObject({ reason: 'refund', delta: -150, plan_delta: -100, topup_delta: -50, balance_after: 0 });

    // Nothing left: still recorded once, no negative balances.
    expect(await clawback(user, 10, 'ch_2')).toEqual({ ...bal(0, 0), taken: 0, owed: 0 });
    expect((await ledgerRows(user)).at(-1)).toMatchObject({ ref: 'ch_2', delta: 0 });
  });

  it('clawback can take a named bucket first', async () => {
    const user = randomUUID();
    await grant(user, 100, 'plan');
    await grant(user, 700, 'topup');
    expect(await clawback(user, 750, undefined, 'topup_refund', 'video', 'topup')).toEqual({ ...bal(50, 0), taken: 750, owed: 0 });
  });

  it('clawback takes what is available and owes the part on hold', async () => {
    const user = randomUUID();
    await grant(user, 100);
    await hold(user, 60);
    expect(await clawback(user, 100)).toEqual({ ...bal(60, 0, 60), taken: 40, owed: 60 });
    expect(await owed(user)).toBe(60);
  });

  it('refund while everything is on hold is collected on release', async () => {
    const user = randomUUID();
    await grant(user, 5000, 'topup');
    const holdId = await hold(user, 5000);

    const first = await clawback(user, 5000, 'ch_held');
    expect(first).toEqual({ ...bal(0, 5000, 5000), taken: 0, owed: 5000 });
    // A retry changes nothing and reports the same split.
    expect(await clawback(user, 5000, 'ch_held')).toEqual(first);
    expect(await owed(user)).toBe(5000);

    expect(await release(holdId)).toEqual(bal(0, 0, 0));
    expect(await owed(user)).toBe(0);
    expect((await ledgerRows(user)).at(-1)).toMatchObject({ reason: 'clawback_deferred', delta: -5000, hold_id: holdId });
  });

  it('settled credits write the owed clawback down; the rest is collected on release', async () => {
    const user = randomUUID();
    await grant(user, 5000, 'topup');
    const holdId = await hold(user, 5000);
    await clawback(user, 5000);
    expect(await settle(holdId, 3000, 'shot-a')).toEqual(bal(0, 2000, 2000));
    expect(await owed(user)).toBe(2000);
    expect(await release(holdId)).toEqual(bal(0, 0, 0));
    expect(await owed(user)).toBe(0);
  });

  it('a reused ref under another operation or hold raises ref_conflict', async () => {
    const user = randomUUID();
    await grant(user, 500, 'plan', 'cs_9', 'checkout');
    const conflict = await errorOf(spend(user, 100, 'cs_9', 'checkout'));
    expect(conflict.message).toBe('ref_conflict');
    expect((await errorOf(grant(user, 999, 'plan', 'cs_9', 'checkout'))).message).toBe('ref_conflict');
    expect((await errorOf(grant(user, 500, 'topup', 'cs_9', 'checkout'))).message).toBe('ref_conflict');

    const h1 = await hold(user, 100);
    const h2 = await hold(user, 100);
    await settle(h1, 40, 'shot-1');
    expect((await errorOf(settle(h2, 40, 'shot-1'))).message).toBe('ref_conflict');
    expect((await errorOf(settle(h1, 41, 'shot-1'))).message).toBe('ref_conflict');
    expect(await holdRow(h2)).toEqual({ amount: 100, remaining: 100, status: 'active' });
    expect(await balance(user)).toEqual(bal(460, 0, 160));
  });

  it('hold is retry-safe with a caller-chosen id', async () => {
    const user = randomUUID();
    const projectId = randomUUID();
    await grant(user, 100);
    const holdId = randomUUID();
    expect(await hold(user, 60, projectId, 'video', db, holdId)).toBe(holdId);
    expect(await hold(user, 60, projectId, 'video', db, holdId)).toBe(holdId);
    expect(await balance(user)).toEqual(bal(100, 0, 60));
    expect((await errorOf(hold(user, 30, projectId, 'video', db, holdId))).message).toBe('ref_conflict');

    const other = randomUUID();
    await grant(other, 100);
    expect((await errorOf(hold(other, 60, projectId, 'video', db, holdId))).message).toBe('ref_conflict');
    expect(await balance(other)).toEqual(bal(100, 0));
  });

  it('partial release is idempotent on (hold, ref) and requires a ref', async () => {
    const user = randomUUID();
    await grant(user, 100);
    const holdId = await hold(user, 100);
    await release(holdId, 40, 'rel-1');
    expect(await release(holdId, 40, 'rel-1')).toEqual(bal(100, 0, 60));
    expect(await holdRow(holdId)).toEqual({ amount: 100, remaining: 60, status: 'active' });
    expect((await errorOf(release(holdId, 30, 'rel-1'))).message).toBe('ref_conflict');
    expect((await errorOf(one('select credit_release($1, $2) as b', [holdId, 10]))).message).toBe('invalid_ref');
    expect(await settle(holdId, 60, 'shot-1')).toEqual(bal(40, 0, 0));
  });

  it('pending grant is claimed once', async () => {
    const user = randomUUID();
    const other = randomUUID();
    const customer = `cus_${randomUUID()}`;
    await db.query(
      `insert into credit_pending_grants (stripe_customer_id, currency, amount, bucket, reason, ref)
       values ($1, 'video', 1500, 'plan', 'checkout', $2), ($1, 'video', 700, 'topup', 'checkout', $3)`,
      [customer, `cs_${randomUUID()}`, `cs_${randomUUID()}`],
    );

    expect((await one('select credit_claim_pending($1, $2) as n', [customer, user])).n).toBe(2);
    expect(await balance(user)).toEqual(bal(1500, 700));

    expect((await one('select credit_claim_pending($1, $2) as n', [customer, user])).n).toBe(0);
    expect((await one('select credit_claim_pending($1, $2) as n', [customer, other])).n).toBe(0);
    expect(await balance(user)).toEqual(bal(1500, 700));
    expect(await balance(other)).toEqual(bal(0, 0));

    const claimed = (await db.query('select claimed_by from credit_pending_grants where stripe_customer_id = $1', [customer])).rows;
    expect(claimed).toEqual([{ claimed_by: user }, { claimed_by: user }]);
  });

  it('ledger rows sum to the account balances', async () => {
    const user = randomUUID();
    await grant(user, 400, 'plan');
    await grant(user, 300, 'topup');
    await spend(user, 450);
    const holdId = await hold(user, 100);
    await settle(holdId, 40, 's1');
    await release(holdId);
    await renew(user, 1500);
    await clawback(user, 200);

    const sums = await one(
      `select sum(plan_delta)::int as plan, sum(topup_delta)::int as topup,
              bool_and(delta = plan_delta + topup_delta) as consistent
         from credit_ledger where user_id = $1`,
      [user],
    );
    const b = await balance(user);
    expect(sums).toEqual({ plan: b.plan, topup: b.topup, consistent: true });
    expect(b.held).toBe(0);
  });

  it('applies the credit migration by filename and pins search_path on every function', async () => {
    expect(migrationFiles()).toContain('20261114000100_credit_ledger.sql');
    expect(migrationFiles()).toEqual([...migrationFiles()].sort());
    const { rows } = await db.query(
      `select proname, proconfig from pg_proc
        where pronamespace = 'public'::regnamespace and proname like 'credit\\_%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(16);
    for (const row of rows) expect(row.proconfig).toEqual(['search_path=public, pg_temp']);
  });

  describe('client access (authenticated role)', () => {
    const asRole = async (role, sql, params) => {
      await db.exec(`set role ${role};`);
      try {
        return await db.query(sql, params);
      } finally {
        await db.exec('reset role;');
      }
    };

    it('service_role can read but not write balances, ledger or holds directly', async () => {
      const me = randomUUID();
      await grant(me, 100);
      const { rows } = await asRole('service_role', 'select plan_balance from credit_accounts where user_id = $1', [me]);
      expect(rows).toEqual([{ plan_balance: 100 }]);
      for (const sql of [
        'update credit_accounts set plan_balance = 99999 where user_id = $1',
        'delete from credit_ledger where user_id = $1',
        'update credit_holds set remaining = 0 where user_id = $1',
      ]) {
        expect((await errorOf(asRole('service_role', sql, [me]))).message).toMatch(/permission denied/);
      }
      // ...and it can still change them through the functions.
      const { rows: [r] } = await asRole('service_role', "select credit_spend($1, 'video', 10, 'x', 'y') as b", [me]);
      expect(r.b).toEqual(bal(90, 0));
    });

    it('anon cannot read the credit tables', async () => {
      for (const table of ['credit_accounts', 'credit_ledger', 'credit_holds', 'credit_pending_grants', 'stripe_events', 'pricing_config']) {
        expect((await errorOf(asRole('anon', `select * from ${table}`))).message).toMatch(/permission denied/);
      }
    });

    const asUser = async (user, sql, params) => {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
      try {
        return await db.query(sql, params);
      } finally {
        await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
      }
    };

    it('owners read only their own account, ledger and holds', async () => {
      const me = randomUUID();
      const them = randomUUID();
      for (const u of [me, them]) {
        await grant(u, 100);
        await hold(u, 10);
      }
      for (const table of ['credit_accounts', 'credit_ledger', 'credit_holds']) {
        const { rows } = await asUser(me, `select distinct user_id from ${table}`);
        expect(rows).toEqual([{ user_id: me }]);
      }
    });

    it('clients cannot write tables or call credit functions', async () => {
      const me = randomUUID();
      await grant(me, 100);
      const denied = [
        ["update credit_accounts set plan_balance = 99999 where user_id = $1", [me]],
        ["insert into credit_ledger (user_id, currency, delta, plan_delta, topup_delta, bucket, reason, ref, balance_after) values ($1, 'video', 5, 5, 0, 'plan', 'x', 'y', 5)", [me]],
        ["select credit_grant($1, 'video', 1000, 'plan', 'free', 'money')", [me]],
        ["select credit_hold($1, 'video', 10, null)", [me]],
        ['select * from credit_pending_grants', []],
        ['select * from pricing_config', []],
        ['select * from stripe_events', []],
      ];
      for (const [sql, params] of denied) {
        const err = await errorOf(asUser(me, sql, params));
        expect(err.message).toMatch(/permission denied/);
      }
      expect(await balance(me)).toEqual(bal(100, 0));
    });

    it('only service_role may execute the credit functions', async () => {
      const { rows } = await db.query(
        `select r.rolname, bool_and(has_function_privilege(r.rolname, p.oid, 'execute')) as can_run,
                bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) as any_run
           from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
          where p.pronamespace = 'public'::regnamespace and p.proname like 'credit\\_%'
          group by r.rolname order by r.rolname`,
      );
      expect(rows).toEqual([
        { rolname: 'anon', can_run: false, any_run: false },
        { rolname: 'authenticated', can_run: false, any_run: false },
        { rolname: 'service_role', can_run: true, any_run: true },
      ]);
    });
  });
});
