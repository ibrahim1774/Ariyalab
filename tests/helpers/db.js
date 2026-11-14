// In-memory Postgres (PGlite) with the app's credit/story migrations applied.
// Stubs the pieces Supabase provides so migrations run unchanged:
// roles anon/authenticated/service_role, schema auth with auth.uid() and
// auth.users, and a minimal public.profiles (a shared table later migrations
// add policies to). auth.uid() reads the `request.jwt.claim.sub` setting.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const MIGRATION_PATTERN = /^2026111.*\.sql$/;

const SUPABASE_STUBS = `
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;

  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  create table if not exists public.profiles (id uuid primary key, stripe_customer_id text);
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort();
}

export async function createTestDb() {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUBS);
  for (const name of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }
  return {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}
