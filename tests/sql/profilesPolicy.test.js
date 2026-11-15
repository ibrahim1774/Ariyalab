// supabase/migrations/20261114000500_profiles_policy.sql: a guard trigger
// (no grant changes) refuses any change of profiles.stripe_customer_id made
// by the browser roles (anon, authenticated). Everything else about the
// shared table is unchanged; the service role and the server-side link
// function still link. The round-1 policy probe's table shapes are cases
// here. PGlite only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb, migrationFiles } from '../helpers/db.js';

const DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const POLICY_FILE = '20261114000500_profiles_policy.sql';
const POLICY = readFileSync(join(DIR, POLICY_FILE), 'utf8');

const ROLES = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
`;
// Like Supabase: a profiles table with more columns, and table-level
// SELECT / INSERT / UPDATE for authenticated (SELECT for anon).
const SUPABASE_LIKE = `
  ${ROLES}
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, stripe_customer_id text, display_name text);
  grant select, insert, update on public.profiles to authenticated;
  grant select on public.profiles to anon;
  grant all on public.profiles to service_role;
`;

async function as(db, role, sql, params) {
  await db.exec(`set role ${role}`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
  }
}
const privileges = async (db) =>
  (
    await db.query(`select
      has_column_privilege('authenticated','public.profiles','stripe_customer_id','UPDATE') as upd,
      has_column_privilege('authenticated','public.profiles','stripe_customer_id','INSERT') as ins,
      has_column_privilege('authenticated','public.profiles','display_name','UPDATE') as other`)
  ).rows[0];

describe('profiles guard trigger on a Supabase-like table', () => {
  let db;
  let before;
  const ID = '00000000-0000-0000-0000-000000000001';
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(SUPABASE_LIKE);
    before = await privileges(db);
    for (const name of migrationFiles()) await db.exec(readFileSync(join(DIR, name), 'utf8'));
    await db.query(`insert into public.profiles values ($1, 'cus_real', 'Ana')`, [ID]);
  }, 60_000);
  afterAll(async () => db?.close());

  it('is in the migration list and changes no privilege', async () => {
    expect(migrationFiles()).toContain(POLICY_FILE);
    expect(await privileges(db)).toEqual(before);
  });

  it('authenticated cannot change, set or insert stripe_customer_id', async () => {
    await expect(as(db, 'authenticated', `update public.profiles set stripe_customer_id = 'cus_evil' where id = $1`, [ID]))
      .rejects.toThrow(/stripe_customer_id/);
    await expect(as(db, 'authenticated', `update public.profiles set stripe_customer_id = null where id = $1`, [ID]))
      .rejects.toThrow(/stripe_customer_id/);
    await expect(
      as(db, 'authenticated', `insert into public.profiles (id, stripe_customer_id) values ($1, 'cus_evil')`, [randomUUID()])
    ).rejects.toThrow(/stripe_customer_id/);
    const { rows } = await db.query('select stripe_customer_id from public.profiles where id = $1', [ID]);
    expect(rows[0].stripe_customer_id).toBe('cus_real');
  });

  it('whole-row saves and upserts with the value unchanged still work (haelabs.live style)', async () => {
    await as(db, 'authenticated', `update public.profiles set display_name = 'Ana B', stripe_customer_id = 'cus_real' where id = $1`, [ID]);
    const upsert = `insert into public.profiles (id, stripe_customer_id, display_name) values ($1, $2, 'Ana C')
       on conflict (id) do update set display_name = excluded.display_name, stripe_customer_id = excluded.stripe_customer_id`;
    // Signed in as the row's owner (auth.uid() = id): an unchanged value passes.
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ID]);
    try {
      await as(db, 'authenticated', upsert, [ID, 'cus_real']);
      await expect(as(db, 'authenticated', upsert, [ID, 'cus_evil'])).rejects.toThrow(/stripe_customer_id/);
      // Someone else's row, even with its real value: refused (no oracle).
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [randomUUID()]);
      await expect(as(db, 'authenticated', upsert, [ID, 'cus_real'])).rejects.toThrow(/stripe_customer_id/);
    } finally {
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
    await as(db, 'authenticated', `insert into public.profiles (id, stripe_customer_id, display_name) values ($1, null, 'New')`, [randomUUID()]);
    await as(db, 'authenticated', `update public.profiles set display_name = 'ok' where id = $1`, [ID]);
    const { rows } = await db.query('select display_name, stripe_customer_id from public.profiles where id = $1', [ID]);
    expect(rows[0]).toEqual({ display_name: 'ok', stripe_customer_id: 'cus_real' });
  });

  it('a column added later stays writable (no grant was changed)', async () => {
    await db.exec('alter table public.profiles add column avatar_url text');
    await as(db, 'authenticated', `update public.profiles set avatar_url = 'x' where id = $1`, [ID]);
  });

  it('the service role, the owner and the link function can still change it', async () => {
    await as(db, 'service_role', `update public.profiles set stripe_customer_id = 'cus_srv' where id = $1`, [ID]);
    await db.query(`update public.profiles set stripe_customer_id = 'cus_owner' where id = $1`, [ID]);
    const { rows } = await db.query(`select public.credit_link_customer($1, 'cus_linked', false, null) as r`, [randomUUID()]);
    expect(rows[0].r).toBe('linked');
  });

  it('round 2: the guard sorts last among BEFORE triggers and its helpers are executable by the browser roles', async () => {
    const { rows } = await db.query(
      `select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal order by tgname`
    );
    expect(rows.map((r) => r.tgname).at(-1)).toBe('zz_ariyalab_profiles_customer_guard');
    const { rows: priv } = await db.query(
      `select r.rolname, bool_and(has_function_privilege(r.rolname, p.oid, 'execute')) as ok
         from pg_proc p cross join (values ('anon'), ('authenticated')) r(rolname)
        where p.pronamespace = 'public'::regnamespace and p.proname like 'ariyalab\\_profiles\\_%'
        group by r.rolname order by r.rolname`
    );
    expect(priv).toEqual([{ rolname: 'anon', ok: true }, { rolname: 'authenticated', ok: true }]);
  });

  it('anon gained nothing', async () => {
    await expect(as(db, 'anon', `update public.profiles set display_name = 'x'`)).rejects.toThrow(/permission denied/);
  });

  it('applies twice without error', async () => {
    await db.exec(POLICY);
  });
});

// The shapes that defeated the grant-based version (round-1 policy probe).
describe('the guard holds whatever the grants look like', () => {
  const BASE = `
    ${ROLES}
    create role supabase_admin nologin; create role mig nologin; create role dashboard_user nologin;
    grant usage, create on schema public to supabase_admin, mig, dashboard_user;
  `;
  const TABLE = 'create table public.profiles (id uuid primary key, stripe_customer_id text, display_name text);';
  const cases = {
    'table owned by supabase_admin, migration run by a non-owner holding ALL': {
      setup: `set role supabase_admin; ${TABLE}
              grant select, insert, update on public.profiles to authenticated; grant all on public.profiles to mig; reset role;`,
      runAs: 'mig',
    },
    'authenticated also holds UPDATE from a second grantor': {
      setup: `${TABLE} grant select, insert, update on public.profiles to authenticated;
              grant update on public.profiles to dashboard_user with grant option;
              set role dashboard_user; grant update on public.profiles to authenticated; reset role;`,
    },
    'UPDATE granted to PUBLIC': {
      setup: `${TABLE} grant select, insert, update on public.profiles to authenticated; grant update on public.profiles to public;`,
    },
    'authenticated inherits UPDATE through membership in another role': {
      setup: `create role app_users nologin; grant app_users to authenticated; ${TABLE}
              grant select, insert, update on public.profiles to app_users;`,
    },
  };
  for (const [label, { setup, runAs }] of Object.entries(cases)) {
    it(label, async () => {
      const db = await PGlite.create();
      try {
        await db.exec(BASE);
        await db.exec(setup);
        const id = randomUUID();
        await db.query(`insert into public.profiles values ($1, 'cus_real', 'Ana')`, [id]);
        if (runAs) await db.exec(`set role ${runAs}`);
        await db.exec(POLICY);
        await db.exec('reset role');
        await expect(as(db, 'authenticated', `update public.profiles set stripe_customer_id = 'cus_evil' where id = $1`, [id]))
          .rejects.toThrow(/stripe_customer_id/);
        await as(db, 'authenticated', `update public.profiles set display_name = 'ok' where id = $1`, [id]);
      } finally {
        await db.close();
      }
    });
  }

  it('a migration whose guard is disabled afterwards would be caught by the runbook check query', async () => {
    const db = await PGlite.create();
    try {
      await db.exec(BASE);
      await db.exec(`${TABLE} grant select, insert, update on public.profiles to authenticated;`);
      await db.exec(POLICY);
      const check = `select tgenabled from pg_trigger
                      where tgrelid = 'public.profiles'::regclass and tgname = 'zz_ariyalab_profiles_customer_guard'`;
      expect((await db.query(check)).rows[0].tgenabled).toBe('O');
      await db.exec('alter table public.profiles disable trigger zz_ariyalab_profiles_customer_guard');
      expect((await db.query(check)).rows[0].tgenabled).toBe('D');
      // Re-applying the migration turns it back on.
      await db.exec(POLICY);
      expect((await db.query(check)).rows[0].tgenabled).toBe('O');
    } finally {
      await db.close();
    }
  });
});

describe('on the minimal test stub', () => {
  it('applies cleanly with every other migration', async () => {
    const stub = await createTestDb();
    try {
      const { rows } = await stub.query("select public.credit_link_customer($1, 'cus_x', false, null) as r", [randomUUID()]);
      expect(rows[0].r).toBe('linked');
    } finally {
      await stub.close();
    }
  });
});
