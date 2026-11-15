// supabase/migrations/20261114000500_profiles_policy.sql: signed-in users
// (and anon) can no longer write profiles.stripe_customer_id from the
// browser; every other column keeps the privileges it had; the service-role
// link function still links. PGlite only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb, migrationFiles } from '../helpers/db.js';

const DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const POLICY = '20261114000500_profiles_policy.sql';

// Like Supabase: a profiles table with more columns, and table-level
// SELECT / INSERT / UPDATE for authenticated (and SELECT for anon).
const SUPABASE_LIKE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
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

let db;
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SUPABASE_LIKE);
  for (const name of migrationFiles()) await db.exec(readFileSync(join(DIR, name), 'utf8'));
}, 60_000);
afterAll(async () => db?.close());

async function as(role, sql, params) {
  await db.exec(`set role ${role}`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
  }
}

describe('profiles policy migration', () => {
  it('is in the migration list', () => {
    expect(migrationFiles()).toContain(POLICY);
  });

  it('authenticated can no longer update or insert stripe_customer_id', async () => {
    const id = randomUUID();
    await db.query("insert into public.profiles (id, stripe_customer_id) values ($1, 'cus_real')", [id]);
    await expect(as('authenticated', "update public.profiles set stripe_customer_id = 'cus_evil' where id = $1", [id]))
      .rejects.toThrow(/permission denied/);
    await expect(
      as('authenticated', "insert into public.profiles (id, stripe_customer_id) values ($1, 'cus_evil')", [randomUUID()])
    ).rejects.toThrow(/permission denied/);
    const { rows } = await db.query('select stripe_customer_id from public.profiles where id = $1', [id]);
    expect(rows[0].stripe_customer_id).toBe('cus_real');
  });

  it('every other column keeps its privileges, and reads are unchanged', async () => {
    const id = randomUUID();
    await as('authenticated', 'insert into public.profiles (id, display_name) values ($1, $2)', [id, 'Ana']);
    await as('authenticated', "update public.profiles set display_name = 'Ana B' where id = $1", [id]);
    const { rows } = await as('authenticated', 'select id, stripe_customer_id, display_name from public.profiles where id = $1', [id]);
    expect(rows[0]).toMatchObject({ display_name: 'Ana B', stripe_customer_id: null });
    expect((await as('anon', 'select stripe_customer_id from public.profiles limit 1')).rows).toBeDefined();
  });

  it('does not widen anything: anon had no UPDATE and still has none', async () => {
    await expect(as('anon', "update public.profiles set display_name = 'x'")).rejects.toThrow(/permission denied/);
  });

  it('the server-side link function still links', async () => {
    const id = randomUUID();
    const { rows } = await db.query("select public.credit_link_customer($1, 'cus_srv', false, null) as r", [id]);
    expect(rows[0].r).toBe('linked');
  });

  it('is a no-op on the minimal test stub (applies cleanly with every other migration)', async () => {
    const stub = await createTestDb();
    try {
      const id = randomUUID();
      const { rows } = await stub.query("select public.credit_link_customer($1, 'cus_x', false, null) as r", [id]);
      expect(rows[0].r).toBe('linked');
    } finally {
      await stub.close();
    }
  });

  it('applies twice without error', async () => {
    await db.exec(readFileSync(join(DIR, POLICY), 'utf8'));
  });
});
