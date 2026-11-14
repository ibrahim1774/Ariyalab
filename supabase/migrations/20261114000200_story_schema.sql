-- Story video maker: every table the story pipeline uses.
--
-- BEFORE APPLYING ON THE SHARED SUPABASE PROJECT, run:
--   select tablename from pg_tables where schemaname = 'public' and tablename like 'story\_%';
--   select proname from pg_proc
--     where pronamespace = 'public'::regnamespace and proname like 'story\_%';
-- and confirm both return nothing. This migration uses plain create table /
-- create function so a clash fails instead of reusing.
--
-- Shared project: new tables and functions only. No foreign key to
-- auth.users, profiles or any other existing table, and none to the credit_
-- tables (credit_holds ids are stored in story_jobs.hold_id without an FK).
-- auth.uid() is used only inside RLS policies.
--
-- Ownership: story_projects, story_assets, story_brand, story_voices,
-- story_jobs and story_usage carry user_id. Project children
-- (references, scripts, cast, shots, renders, chat) are owned through
-- project_id and are deleted with their project (on delete cascade).
-- story_projects.reference_id points at story_references without an FK
-- (the two would reference each other).
--
-- Access: the server uses the service role (bypasses RLS) and enforces
-- ownership in lib/story/*. Clients (authenticated) may select their own
-- rows in every table; they may insert and update only story_projects,
-- story_scripts and story_assets, and only the columns granted below
-- (billing and pipeline columns such as fee_charged, step, status are
-- server-only). Everything else is written by the server only. anon has no
-- access. Functions are executable by service_role only.

-- ---------------------------------------------------------------- tables

create table public.story_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null default 'Untitled video',
  purpose text check (purpose in ('product', 'app', 'coaching', 'service', 'personal_brand', 'story')),
  offer text,
  audience text,
  style text check (style in (
    '3d_family', '2d_cartoon', 'anime', 'clay', 'comic', 'flat_motion', 'watercolor', 'custom'
  )),
  style_custom text,
  seconds integer not null default 30 check (seconds between 15 and 75),
  aspect text not null default '9:16' check (aspect in ('9:16', '1:1', '16:9')),
  quality text not null default 'standard' check (quality in ('economy', 'standard', 'pro_narrated', 'pro_talking')),
  mode text not null default 'narrated' check (mode in ('narrated', 'talking')),
  step text not null default 'brief' check (step in (
    'brief', 'breakdown', 'script', 'cast', 'storyboard', 'audio', 'generate', 'review', 'done'
  )),
  status text not null default 'draft' check (status in ('draft', 'generating', 'finished', 'failed')),
  -- Voice, music and captions choices: { voice, music, captions, ... }.
  audio_plan jsonb not null default '{}'::jsonb,
  fee_charged boolean not null default false,
  rerolls_used integer not null default 0 check (rerolls_used >= 0),
  -- Included-allowance counters (spec 8): narration and music generations
  -- and chat messages used on this project.
  narrations_used integer not null default 0 check (narrations_used >= 0),
  music_used integer not null default 0 check (music_used >= 0),
  chat_used integer not null default 0 check (chat_used >= 0),
  reference_id uuid,
  thumbnail_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index story_projects_owner_idx on public.story_projects (user_id, updated_at desc);

-- Brand kit files and customer uploads. project_id tags an upload made for
-- one project; brand-kit assets have none. Assets outlive their project.
create table public.story_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid references public.story_projects (id) on delete set null,
  kind text not null check (kind in (
    'logo', 'product_photo', 'mascot', 'image', 'screen_recording', 'video_clip',
    'reference_video', 'voice_sample', 'voice_track', 'music', 'audio'
  )),
  name text,
  url text not null,
  storage_key text,
  mime text,
  bytes integer check (bytes >= 0),
  duration_seconds real check (duration_seconds >= 0),
  width integer,
  height integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index story_assets_owner_idx on public.story_assets (user_id, created_at desc);
create index story_assets_project_idx on public.story_assets (project_id) where project_id is not null;

-- A reference video and what was learned from it (spec 7.3 step 5).
create table public.story_references (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects (id) on delete cascade,
  source_type text not null check (source_type in ('upload', 'link')),
  source_url text,
  asset_id uuid references public.story_assets (id) on delete set null,
  platform text,
  file_url text,
  duration_seconds real check (duration_seconds >= 0),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  error text,
  cut_list jsonb not null default '[]'::jsonb,     -- [{ start, end }]
  transcript jsonb,                                -- { text, words:[{ w, start, end }] }
  beat_sheet jsonb not null default '[]'::jsonb,   -- Beat[]
  mood text,                                       -- suggested music mood
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index story_references_project_idx on public.story_references (project_id);

create table public.story_scripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects (id) on delete cascade,
  version integer not null check (version >= 1),
  scenes jsonb not null default '[]'::jsonb,       -- Scene[]
  -- What produced this version: 'brief' | 'reference' | 'revision' | 'edit'.
  source text,
  instruction text,
  created_at timestamptz not null default now(),
  constraint story_scripts_version_unique unique (project_id, version)
);

create table public.story_cast (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects (id) on delete cascade,
  ord integer not null default 0,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'pending', 'ready', 'failed', 'blocked')),
  candidates jsonb not null default '[]'::jsonb,   -- [{ url, prompt }]
  chosen_index integer,
  image_url text,                                  -- the picked image
  asset_id uuid references public.story_assets (id) on delete set null,  -- customer's own reference
  sheet jsonb not null default '{}'::jsonb,        -- { front, three_quarter, face }
  regens_used integer not null default 0 check (regens_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index story_cast_project_idx on public.story_cast (project_id, ord);

create table public.story_shots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects (id) on delete cascade,
  ord integer not null,
  scene_id text,
  description text,
  line text,
  seconds integer not null default 5 check (seconds > 0),
  quality text not null default 'standard' check (quality in ('economy', 'standard', 'pro_narrated', 'pro_talking')),
  source text not null default 'generated' check (source in ('generated', 'footage')),
  footage_asset_id uuid references public.story_assets (id) on delete set null,
  inset_asset_id uuid references public.story_assets (id) on delete set null,
  still_url text,
  clip_url text,
  status text not null default 'draft' check (status in (
    'draft', 'still_pending', 'still_ready', 'queued', 'generating', 'ready', 'failed', 'blocked'
  )),
  stale boolean not null default false,
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index story_shots_project_idx on public.story_shots (project_id, ord);

-- One row per owner.
create table public.story_brand (
  user_id uuid primary key,
  offer text,
  audience text,
  tone text,
  avoid text[] not null default '{}',
  colors jsonb not null default '[]'::jsonb,
  logo_asset_id uuid references public.story_assets (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.story_voices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  provider text not null,
  provider_voice_id text,
  sample_asset_id uuid references public.story_assets (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  -- Consent record (spec 7.6).
  consent_at timestamptz not null,
  consent_ip text,
  consent_statement text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index story_voices_owner_idx on public.story_voices (user_id);

-- project_id is null for account-level work (voice_clone).
create table public.story_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.story_projects (id) on delete cascade,
  user_id uuid not null,
  shot_id uuid references public.story_shots (id) on delete set null,
  kind text not null check (kind in (
    'analyze', 'script', 'cast_image', 'still', 'clip', 'narration', 'music', 'voice_clone', 'render'
  )),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  provider text,
  provider_task_id text,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'blocked')),
  attempts integer not null default 0 check (attempts >= 0),
  hold_id uuid,
  cost_credits integer check (cost_credits >= 0),
  error text,
  run_after timestamptz,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- story_claim_jobs reads queued jobs of one project, oldest first.
create index story_jobs_claim_idx on public.story_jobs (project_id, created_at) where status = 'queued';
-- Provider webhooks look a job up by its task id.
create index story_jobs_provider_task_idx on public.story_jobs (provider, provider_task_id)
  where provider_task_id is not null;
create index story_jobs_user_idx on public.story_jobs (user_id, created_at desc);
create index story_jobs_shot_idx on public.story_jobs (shot_id) where shot_id is not null;

create table public.story_renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects (id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  job_id uuid references public.story_jobs (id) on delete set null,
  file_url text,
  duration_seconds real,
  settings jsonb not null default '{}'::jsonb,     -- captions, music level, cut list used
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint story_renders_version_unique unique (project_id, version)
);

-- Chat history per project. content is the message content as sent to the
-- model (a string, or an array of content blocks).
create table public.story_chat (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index story_chat_project_idx on public.story_chat (project_id, created_at);

-- Daily per-user counters for free-tier limits (spec 8). Written through
-- story_usage_take only.
create table public.story_usage (
  user_id uuid not null,
  day date not null default current_date,
  action text not null check (action <> ''),
  count integer not null default 0 check (count >= 0),
  primary key (user_id, day, action)
);

-- ---------------------------------------------------------------- updated_at

create function public.story_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'story_projects', 'story_assets', 'story_references', 'story_cast', 'story_shots',
    'story_brand', 'story_voices', 'story_jobs', 'story_renders'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.story_touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------- RLS

alter table public.story_projects enable row level security;
alter table public.story_assets enable row level security;
alter table public.story_references enable row level security;
alter table public.story_scripts enable row level security;
alter table public.story_cast enable row level security;
alter table public.story_shots enable row level security;
alter table public.story_brand enable row level security;
alter table public.story_voices enable row level security;
alter table public.story_jobs enable row level security;
alter table public.story_renders enable row level security;
alter table public.story_chat enable row level security;
alter table public.story_usage enable row level security;

-- Owner reads on every table.
create policy story_projects_owner_select on public.story_projects
  for select to authenticated using (user_id = (select auth.uid()));
create policy story_assets_owner_select on public.story_assets
  for select to authenticated using (user_id = (select auth.uid()));
create policy story_brand_owner_select on public.story_brand
  for select to authenticated using (user_id = (select auth.uid()));
create policy story_voices_owner_select on public.story_voices
  for select to authenticated using (user_id = (select auth.uid()));
create policy story_jobs_owner_select on public.story_jobs
  for select to authenticated using (user_id = (select auth.uid()));
create policy story_usage_owner_select on public.story_usage
  for select to authenticated using (user_id = (select auth.uid()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'story_references', 'story_scripts', 'story_cast', 'story_shots', 'story_renders', 'story_chat'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (
         select 1 from public.story_projects p
          where p.id = project_id and p.user_id = (select auth.uid())))',
      t || '_owner_select', t
    );
  end loop;
end
$$;

-- Owner writes: story_projects, story_scripts, story_assets only.
create policy story_projects_owner_insert on public.story_projects
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy story_projects_owner_update on public.story_projects
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy story_scripts_owner_insert on public.story_scripts
  for insert to authenticated with check (exists (
    select 1 from public.story_projects p where p.id = project_id and p.user_id = (select auth.uid())));
create policy story_scripts_owner_update on public.story_scripts
  for update to authenticated
  using (exists (
    select 1 from public.story_projects p where p.id = project_id and p.user_id = (select auth.uid())))
  with check (exists (
    select 1 from public.story_projects p where p.id = project_id and p.user_id = (select auth.uid())));

create policy story_assets_owner_insert on public.story_assets
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from public.story_projects p where p.id = project_id and p.user_id = (select auth.uid()))));
create policy story_assets_owner_update on public.story_assets
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (project_id is null or exists (
      select 1 from public.story_projects p where p.id = project_id and p.user_id = (select auth.uid()))));

-- ---------------------------------------------------------------- functions

-- Claims up to p_limit due queued jobs of one project, oldest first:
-- status 'running', locked for two minutes, attempts + 1. Concurrent
-- callers never receive the same job (for update skip locked).
create function public.story_claim_jobs(p_project uuid, p_limit integer)
returns setof public.story_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select j.id
      from story_jobs j
     where j.project_id = p_project
       and j.status = 'queued'
       and (j.run_after is null or j.run_after <= now())
     order by j.created_at, j.id
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked
  )
  update story_jobs j
     set status = 'running',
         locked_until = now() + interval '2 minutes',
         attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.*;
$$;

-- Counts one use of p_action today for p_user if fewer than p_limit were
-- used. Returns true when counted, false at the limit. Atomic.
create function public.story_usage_take(
  p_user uuid,
  p_action text,
  p_limit integer,
  p_day date default current_date
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_user is null or coalesce(p_action, '') = '' then
    raise exception 'invalid_usage';
  end if;
  if coalesce(p_limit, 0) < 1 then
    return false;
  end if;
  insert into story_usage as u (user_id, day, action, count)
  values (p_user, p_day, p_action, 1)
  on conflict (user_id, day, action) do update
     set count = u.count + 1
   where u.count < p_limit
  returning u.count into v_count;
  return v_count is not null;
end
$$;

-- ---------------------------------------------------------------- privileges

-- Same pattern as the credit ledger migration: functions are executable by
-- service_role only; role statements are guarded so this runs where the
-- Supabase roles do not exist.
do $$
declare
  fn regprocedure;
  all_tables text := 'public.story_projects, public.story_assets, public.story_references, '
    'public.story_scripts, public.story_cast, public.story_shots, public.story_brand, '
    'public.story_voices, public.story_jobs, public.story_renders, public.story_chat, public.story_usage';
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any (array['story_touch_updated_at', 'story_claim_jobs', 'story_usage_take'])
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
    -- Reads, filtered to the owner's rows by the policies above.
    execute 'grant select on table ' || all_tables || ' to authenticated';
    -- Writes: only the customer-editable columns.
    grant insert (user_id, title, purpose, offer, audience, style, style_custom, seconds, aspect, quality, mode)
      on table public.story_projects to authenticated;
    grant update (title, purpose, offer, audience, style, style_custom, seconds, aspect, quality, mode)
      on table public.story_projects to authenticated;
    grant insert (project_id, version, scenes, source, instruction) on table public.story_scripts to authenticated;
    grant update (scenes) on table public.story_scripts to authenticated;
    grant insert (user_id, project_id, kind, name, url, storage_key, mime, bytes, duration_seconds, width, height, metadata)
      on table public.story_assets to authenticated;
    grant update (project_id, name, metadata) on table public.story_assets to authenticated;
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table ' || all_tables || ' to service_role';
  end if;
end
$$;
