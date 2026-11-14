-- Story video maker: the OAuth 2.1 authorization server behind the MCP
-- connector (spec 7.7, Task 25). lib/mcp/oauth.js is the only reader and
-- writer.
--
-- This file replaces any earlier draft of itself (an earlier draft named
-- the rate-limit table story_oauth_registrations). It was never applied to
-- a hosted database before this version.
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
-- Depends on public.story_touch_updated_at() from 20261114000200_story_schema.sql
-- (applied before this file).
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
  -- When the cached document must be fetched again (its Cache-Control
  -- max-age clamped to 5 minutes .. 24 hours). A failed refetch keeps
  -- serving the cached row.
  metadata_expires_at timestamptz,
  -- The document URL answered 404 or 410: the client is withdrawn (no
  -- longer honoured) until a later fetch succeeds.
  metadata_withdrawn_at timestamptz,
  -- The latest end (family_expires_at) of any grant this client got. The
  -- sweep keeps the client until 90 days after it.
  last_grant_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Negative cache for Client ID Metadata Document fetches: no new fetch of
-- client_id before retry_after.
create table public.story_oauth_cimd_failures (
  client_id text primary key check (length(client_id) between 1 and 300),
  retry_after timestamptz not null,
  created_at timestamptz not null default now()
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

create index story_oauth_codes_user_idx on public.story_oauth_codes (user_id);

-- One row per issued access/refresh token pair. family_id is shared by
-- every pair descended from one authorization code through refresh
-- rotation; family_expires_at (90 days after the authorization) caps every
-- pair of the family. rotated_at: this pair's refresh token was exchanged
-- (its access token stays valid until access_expires_at); replaced_by is
-- the pair it was exchanged for. access_used_at: first use of the access
-- token at the MCP endpoint. revoked_at: the pair is dead (code replay,
-- refresh reuse, revocation, disconnect, revokeTokensForUser).
create table public.story_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  code_id uuid,
  client_id text not null,
  user_id uuid not null,
  scope text not null,
  resource text not null,
  -- The redirect URI used at authorization (names the grant on the
  -- Connected apps page) and when that authorization happened.
  redirect_uri text not null,
  family_created_at timestamptz not null,
  access_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_token_hash text not null unique,
  refresh_expires_at timestamptz not null,
  family_expires_at timestamptz not null,
  replaced_by uuid,
  access_used_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index story_oauth_tokens_family_idx on public.story_oauth_tokens (family_id, created_at);
create index story_oauth_tokens_code_idx on public.story_oauth_tokens (code_id) where code_id is not null;
create index story_oauth_tokens_user_idx on public.story_oauth_tokens (user_id) where revoked_at is null;

-- Daily counters for rate limits, written through story_oauth_rate_take
-- only. bucket is '<kind>:<hashed client IP key>', for example
-- 'register:…' (dynamic registrations and first-time metadata document
-- fetches) or 'token:…' (token and revocation endpoint requests).
create table public.story_oauth_rate_limits (
  bucket text not null check (length(bucket) between 1 and 200),
  day date not null default current_date,
  count integer not null default 0 check (count >= 0),
  primary key (bucket, day)
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
alter table public.story_oauth_rate_limits enable row level security;
alter table public.story_oauth_cimd_failures enable row level security;

-- ---------------------------------------------------------------- functions

-- First step of redeeming an authorization code. Locks the code row.
-- Unused: marks it used and returns it with reused = false; the caller then
-- checks client, redirect_uri, resource, expiry and PKCE (a failed check
-- leaves the code burned) and calls story_oauth_issue_code_tokens.
-- Already used: returns it with reused = true. If the first redemption was
-- less than 10 minutes ago this is treated as a replay: the code is marked
-- revoked and every token issued from it is revoked. Older replays (a code
-- found in a log months later) are refused without touching the grant.
-- Unknown hash: no row.
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
    if v.used_at > now() - interval '10 minutes' then
      update story_oauth_codes c set revoked_at = coalesce(c.revoked_at, now()) where c.id = v.id;
      update story_oauth_tokens t set revoked_at = now() where t.code_id = v.id and t.revoked_at is null;
    end if;
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
-- pair). The family id is the code id; the family ends p_family_seconds
-- from now, and no expiry of the pair passes it.
create function public.story_oauth_issue_code_tokens(
  p_code_id uuid,
  p_access_hash text,
  p_access_expires timestamptz,
  p_refresh_hash text,
  p_refresh_expires timestamptz,
  p_family_seconds integer default 7776000
)
returns setof public.story_oauth_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_oauth_codes%rowtype;
  v_family_end timestamptz := now() + make_interval(secs => p_family_seconds);
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
      family_id, code_id, client_id, user_id, scope, resource, redirect_uri, family_created_at,
      access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, family_expires_at
    ) values (
      v.id, v.id, v.client_id, v.user_id, v.scope, v.resource, v.redirect_uri, now(),
      p_access_hash, least(p_access_expires, v_family_end), p_refresh_hash, least(p_refresh_expires, v_family_end), v_family_end
    )
    returning *;
  update story_oauth_clients k
     set last_grant_ends_at = greatest(coalesce(k.last_grant_ends_at, v_family_end), v_family_end)
   where k.client_id = v.client_id;
end
$$;

-- Refresh token rotation with reuse detection. Locks the presented pair
-- (and, in the grace window, its successor) and returns one row: status
-- and, when 'ok', the new pair.
--   'unknown'   no such refresh token
--   'reused'    the token was already rotated: the whole family is revoked,
--               except in the grace window below
--   'revoked'   the pair was revoked earlier
--   'expired'   the refresh token or its family is past its end
--   'wrong_client' / 'wrong_resource'  presented by another client, or for
--               another resource (p_resource null skips the resource check)
--   'rate_limited'  the family already got p_family_limit pairs in 24 hours
--   'ok'        the old pair is marked rotated and a new pair is stored in
--               the same family with the same user, client, scope, resource
-- Grace window: a token rotated less than 60 seconds ago whose successor
-- is unused (not rotated, not revoked, its access token never presented)
-- is treated as a retry after a lost response: the successor is revoked
-- and a new pair issued, without revoking the family.
create function public.story_oauth_rotate_refresh(
  p_refresh_hash text,
  p_client_id text,
  p_resource text,
  p_access_hash text,
  p_access_expires timestamptz,
  p_new_refresh_hash text,
  p_refresh_expires timestamptz,
  p_family_limit integer default 200
)
returns table (status text, token_id uuid, user_id uuid, scope text, resource text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_oauth_tokens%rowtype;
  s story_oauth_tokens%rowtype;
  v_new uuid;
  v_grace boolean := false;
begin
  select * into v from story_oauth_tokens t where t.refresh_token_hash = p_refresh_hash for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.revoked_at is not null then
    return query select 'revoked'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.rotated_at is not null then
    if v.rotated_at > now() - interval '60 seconds' and v.replaced_by is not null then
      select * into s from story_oauth_tokens t where t.id = v.replaced_by for update;
      v_grace := found and s.revoked_at is null and s.rotated_at is null and s.access_used_at is null;
    end if;
    if not v_grace then
      update story_oauth_tokens t set revoked_at = now() where t.family_id = v.family_id and t.revoked_at is null;
      return query select 'reused'::text, null::uuid, null::uuid, null::text, null::text;
      return;
    end if;
  end if;
  if v.client_id <> p_client_id then
    return query select 'wrong_client'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if p_resource is not null and v.resource <> p_resource then
    return query select 'wrong_resource'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v.refresh_expires_at <= now() or v.family_expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if (select count(*) from story_oauth_tokens t
       where t.family_id = v.family_id and t.created_at > now() - interval '1 day') >= coalesce(p_family_limit, 0) then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if v_grace then
    update story_oauth_tokens t set revoked_at = now() where t.id = s.id;
  end if;
  insert into story_oauth_tokens (
    family_id, code_id, client_id, user_id, scope, resource, redirect_uri, family_created_at,
    access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, family_expires_at
  ) values (
    v.family_id, v.code_id, v.client_id, v.user_id, v.scope, v.resource, v.redirect_uri, v.family_created_at,
    p_access_hash, least(p_access_expires, v.family_expires_at),
    p_new_refresh_hash, least(p_refresh_expires, v.family_expires_at), v.family_expires_at
  )
  returning id into v_new;
  update story_oauth_tokens t set rotated_at = coalesce(t.rotated_at, now()), replaced_by = v_new where t.id = v.id;
  return query select 'ok'::text, v_new, v.user_id, v.scope, v.resource;
end
$$;

-- Looks up an access token by hash for verifyAccessToken and marks its
-- first use (only while the pair is valid: not revoked, not expired), in
-- one statement: the conditional update takes the row lock,
-- so it serializes with story_oauth_rotate_refresh's lock on a successor
-- (either the use is marked first and the grace window is closed, or the
-- grace retry revoked the pair first and the returned row shows it).
-- Returns the row (marked or not), or no row for an unknown hash.
create function public.story_oauth_use_access_token(p_access_hash text)
returns setof public.story_oauth_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    update story_oauth_tokens t set access_used_at = now()
     where t.access_token_hash = p_access_hash and t.access_used_at is null
       and t.revoked_at is null and t.access_expires_at > now()
    returning *;
  if not found then
    return query select * from story_oauth_tokens t where t.access_token_hash = p_access_hash;
  end if;
end
$$;

-- Counts one use of p_bucket today if fewer than p_limit were counted.
-- Returns true when counted, false at the limit. Atomic.
create function public.story_oauth_rate_take(p_bucket text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if coalesce(p_bucket, '') = '' then
    raise exception 'invalid_usage';
  end if;
  if coalesce(p_limit, 0) < 1 then
    return false;
  end if;
  insert into story_oauth_rate_limits as r (bucket, day, count)
  values (p_bucket, current_date, 1)
  on conflict (bucket, day) do update
     set count = r.count + 1
   where r.count < p_limit
  returning r.count into v_count;
  return v_count is not null;
end
$$;

-- Daily sweep (pages/api/cron/oauth-cleanup.js). Deletes:
--   consent requests and codes a day past expiry;
--   token pairs revoked more than a day ago, and pairs whose refresh token
--   or family ended more than a day ago (rotated pairs of a live family are
--   kept, so presenting an old rotated refresh token still revokes the
--   family, however long the real client was away);
--   rate-limit rows older than yesterday and expired fetch failures;
--   clients older than 7 days with no consent request, code or token left
--   whose last grant (if any) ended more than 90 days ago.
-- Returns the counts as jsonb.
create function public.story_oauth_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n_requests integer;
  n_codes integer;
  n_tokens integer;
  n_limits integer;
  n_failures integer;
  n_clients integer;
begin
  delete from story_oauth_requests r where r.expires_at < now() - interval '1 day';
  get diagnostics n_requests = row_count;
  delete from story_oauth_codes c where c.expires_at < now() - interval '1 day';
  get diagnostics n_codes = row_count;
  delete from story_oauth_tokens t
   where t.revoked_at < now() - interval '1 day'
      or t.refresh_expires_at < now() - interval '1 day'
      or t.family_expires_at < now() - interval '1 day';
  get diagnostics n_tokens = row_count;
  delete from story_oauth_rate_limits l where l.day < current_date - 1;
  get diagnostics n_limits = row_count;
  delete from story_oauth_cimd_failures f where f.retry_after < now() - interval '1 day';
  get diagnostics n_failures = row_count;
  delete from story_oauth_clients c
   where c.created_at < now() - interval '7 days'
     and (c.last_grant_ends_at is null or c.last_grant_ends_at < now() - interval '90 days')
     and not exists (select 1 from story_oauth_tokens t where t.client_id = c.client_id)
     and not exists (select 1 from story_oauth_codes k where k.client_id = c.client_id)
     and not exists (select 1 from story_oauth_requests r where r.client_id = c.client_id);
  get diagnostics n_clients = row_count;
  return jsonb_build_object(
    'requests', n_requests, 'codes', n_codes, 'tokens', n_tokens,
    'rate_limits', n_limits, 'cimd_failures', n_failures, 'clients', n_clients
  );
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
    'public.story_oauth_tokens, public.story_oauth_rate_limits, public.story_oauth_cimd_failures';
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any (array[
          'story_oauth_take_code', 'story_oauth_issue_code_tokens', 'story_oauth_rotate_refresh',
          'story_oauth_rate_take', 'story_oauth_cleanup', 'story_oauth_use_access_token'
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
