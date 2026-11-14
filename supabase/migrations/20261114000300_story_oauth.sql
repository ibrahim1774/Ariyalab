-- Story video maker: the OAuth 2.1 authorization server behind the MCP
-- connector (spec 7.7, Task 25). lib/mcp/oauth.js is the only reader and
-- writer.
--
-- BEFORE APPLYING ON THE SHARED SUPABASE PROJECT, run:
--   select tablename from pg_tables where schemaname = 'public' and tablename like 'story\_oauth\_%';
--   select proname from pg_proc
--     where pronamespace = 'public'::regnamespace and proname like 'story\_oauth\_%';
-- and confirm both return nothing. Plain create table / create function, so
-- a clash fails instead of reusing.
--
-- Shared project: new tables and functions only, no foreign key to
-- auth.users or any existing table. user_id is the Supabase user id.
--
-- Secrets are never stored: authorization codes, consent request tokens,
-- access tokens and refresh tokens are kept as SHA-256 hashes
-- (base64url), looked up by hash.
--
-- Access: server-only. RLS is enabled with no policies at all, and anon and
-- authenticated have no privilege on any of these tables or functions. The
-- service role (API routes) is the only client.

-- ---------------------------------------------------------------- tables

-- One row per OAuth client. kind 'dynamic': registered through
-- /api/oauth/register (RFC 7591), client_id is random. kind
-- 'metadata_document': a Client ID Metadata Document client, client_id is
-- the https URL of its document; the row caches the fetched document and
-- metadata_fetched_at says when. Every client is public
-- (token_endpoint_auth_method 'none', PKCE required).
create table public.story_oauth_clients (
  client_id text primary key check (length(client_id) between 1 and 300),
  kind text not null check (kind in ('dynamic', 'metadata_document')),
  client_name text not null check (length(client_name) between 1 and 100),
  client_uri text check (length(client_uri) <= 300),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  token_endpoint_auth_method text not null default 'none' check (token_endpoint_auth_method = 'none'),
  metadata_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A consent page view: the validated authorization request, bound to the
-- signed-in user who saw it. token_hash is the hash of the single-use
-- request token the page posts back (the CSRF guard); used_at is set when
-- the user allows or denies.
create table public.story_oauth_requests (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null,
  resource text not null,
  state text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index story_oauth_requests_expires_idx on public.story_oauth_requests (expires_at);

-- Authorization codes: 60 seconds, single use, bound to client,
-- redirect_uri, PKCE challenge, user and resource. used_at marks the first
-- redemption; revoked_at marks a replayed code (its tokens are revoked).
create table public.story_oauth_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  client_id text not null,
  user_id uuid not null,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per issued access/refresh token pair. family_id is shared by
-- every pair descended from one authorization code through refresh
-- rotation. rotated_at: this pair's refresh token was exchanged (its
-- access token stays valid until access_expires_at). revoked_at: the pair
-- is dead (code replay, refresh reuse, or revokeTokensForUser).
create table public.story_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  code_id uuid,
  client_id text not null,
  user_id uuid not null,
  scope text not null,
  resource text not null,
  access_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_token_hash text not null unique,
  refresh_expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index story_oauth_tokens_family_idx on public.story_oauth_tokens (family_id);
create index story_oauth_tokens_code_idx on public.story_oauth_tokens (code_id) where code_id is not null;
create index story_oauth_tokens_user_idx on public.story_oauth_tokens (user_id) where revoked_at is null;

-- Daily dynamic-registration counter per client IP (stored hashed).
-- Written through story_oauth_registration_take only.
create table public.story_oauth_registrations (
  ip_hash text not null,
  day date not null default current_date,
  count integer not null default 0 check (count >= 0),
  primary key (ip_hash, day)
);

create trigger story_oauth_clients_touch before update on public.story_oauth_clients
  for each row execute function public.story_touch_updated_at();

-- ---------------------------------------------------------------- RLS

-- Enabled with no policies: only the service role (which bypasses RLS)
-- can read or write.
alter table public.story_oauth_clients enable row level security;
alter table public.story_oauth_requests enable row level security;
alter table public.story_oauth_codes enable row level security;
alter table public.story_oauth_tokens enable row level security;
alter table public.story_oauth_registrations enable row level security;

-- ---------------------------------------------------------------- functions

-- First step of redeeming an authorization code. Locks the code row.
-- Unused: marks it used and returns it with reused = false; the caller then
-- checks client, redirect_uri, resource, expiry and PKCE (a failed check
-- leaves the code burned) and calls story_oauth_issue_code_tokens.
-- Already used: marks the code revoked, revokes every token issued from it
-- and returns it with reused = true. Unknown hash: no row.
create function public.story_oauth_take_code(p_code_hash text)
returns table (
  id uuid,
  client_id text,
  user_id uuid,
  redirect_uri text,
  code_challenge text,
  scope text,
  resource text,
  expires_at timestamptz,
  reused boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_oauth_codes%rowtype;
begin
  select * into v from story_oauth_codes c where c.code_hash = p_code_hash for update;
  if not found then
    return;
  end if;
  if v.used_at is not null then
    update story_oauth_codes c set revoked_at = coalesce(c.revoked_at, now()) where c.id = v.id;
    update story_oauth_tokens t set revoked_at = now() where t.code_id = v.id and t.revoked_at is null;
    return query select v.id, v.client_id, v.user_id, v.redirect_uri, v.code_challenge, v.scope, v.resource, v.expires_at, true;
    return;
  end if;
  update story_oauth_codes c set used_at = now() where c.id = v.id;
  return query select v.id, v.client_id, v.user_id, v.redirect_uri, v.code_challenge, v.scope, v.resource, v.expires_at, false;
end
$$;

-- Second step: stores the first token pair of a redeemed code. Locks the
-- code row, so a replay that revoked the code either ran first (this raises
-- 'code_revoked' and nothing is stored) or runs after (and revokes this
-- pair). The family id is the code id.
create function public.story_oauth_issue_code_tokens(
  p_code_id uuid,
  p_access_hash text,
  p_access_expires timestamptz,
  p_refresh_hash text,
  p_refresh_expires timestamptz
)
returns setof public.story_oauth_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_oauth_codes%rowtype;
begin
  select * into v from story_oauth_codes c where c.id = p_code_id for update;
  if not found or v.used_at is null or v.revoked_at is not null then
    raise exception 'code_revoked';
  end if;
  if exists (select 1 from story_oauth_tokens t where t.code_id = v.id) then
    raise exception 'code_revoked';
  end if;
  return query
    insert into story_oauth_tokens (
      family_id, code_id, client_id, user_id, scope, resource,
      access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at
    ) values (
      v.id, v.id, v.client_id, v.user_id, v.scope, v.resource,
      p_access_hash, p_access_expires, p_refresh_hash, p_refresh_expires
    )
    returning *;
end
$$;

-- Refresh token rotation with reuse detection. Locks the presented pair and
-- returns one row: status and, when 'ok', the new pair.
--   'unknown'   no such refresh token
--   'reused'    the token was already rotated: the whole family is revoked
--   'revoked'   the pair was revoked earlier
--   'expired'   the refresh token is past refresh_expires_at
--   'wrong_client' / 'wrong_resource'  presented by another client, or for
--               another resource (p_resource null skips the resource check)
--   'ok'        the old pair is marked rotated and a new pair is stored in
--               the same family with the same user, client, scope, resource
create function public.story_oauth_rotate_refresh(
  p_refresh_hash text,
  p_client_id text,
  p_resource text,
  p_access_hash text,
  p_access_expires timestamptz,
  p_new_refresh_hash text,
  p_refresh_expires timestamptz
)
returns table (status text, token_id uuid, user_id uuid, scope text, resource text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_oauth_tokens%rowtype;
  v_new uuid;
begin
  select * into v from story_oauth_tokens t where t.refresh_token_hash = p_refresh_hash for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.rotated_at is not null then
    update story_oauth_tokens t set revoked_at = now() where t.family_id = v.family_id and t.revoked_at is null;
    return query select 'reused'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.revoked_at is not null then
    return query select 'revoked'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.refresh_expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.client_id <> p_client_id then
    return query select 'wrong_client'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if p_resource is not null and v.resource <> p_resource then
    return query select 'wrong_resource'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  update story_oauth_tokens t set rotated_at = now() where t.id = v.id;
  insert into story_oauth_tokens (
    family_id, code_id, client_id, user_id, scope, resource,
    access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at
  ) values (
    v.family_id, v.code_id, v.client_id, v.user_id, v.scope, v.resource,
    p_access_hash, p_access_expires, p_new_refresh_hash, p_refresh_expires
  )
  returning id into v_new;
  return query select 'ok'::text, v_new, v.user_id, v.scope, v.resource;
end
$$;

-- Counts one dynamic registration today for p_ip_hash if fewer than
-- p_limit were made. Returns true when counted, false at the limit. Atomic.
create function public.story_oauth_registration_take(p_ip_hash text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if coalesce(p_ip_hash, '') = '' then
    raise exception 'invalid_usage';
  end if;
  if coalesce(p_limit, 0) < 1 then
    return false;
  end if;
  insert into story_oauth_registrations as r (ip_hash, day, count)
  values (p_ip_hash, current_date, 1)
  on conflict (ip_hash, day) do update
     set count = r.count + 1
   where r.count < p_limit
  returning r.count into v_count;
  return v_count is not null;
end
$$;

-- ---------------------------------------------------------------- privileges

-- Same pattern as the story schema migration: guarded role statements, so
-- this runs where the Supabase roles do not exist. Nothing for anon or
-- authenticated; service_role only.
do $$
declare
  fn regprocedure;
  all_tables text := 'public.story_oauth_clients, public.story_oauth_requests, public.story_oauth_codes, '
    'public.story_oauth_tokens, public.story_oauth_registrations';
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any (array[
          'story_oauth_take_code', 'story_oauth_issue_code_tokens', 'story_oauth_rotate_refresh',
          'story_oauth_registration_take'
        ])
  loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table ' || all_tables || ' from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table ' || all_tables || ' from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table ' || all_tables || ' to service_role';
  end if;
end
$$;
