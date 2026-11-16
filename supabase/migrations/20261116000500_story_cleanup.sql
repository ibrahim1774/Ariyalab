-- Task 27 (stale-hold sweeper, retention cleanup). Applies after 20261116000400_billing_v2.sql.
-- Additive: functions only, no table or column changes. Reads credit_ and story_ tables; touches no shared table.
--
-- story_release_orphan_hold(hold, min_age_minutes) -> credits released (0 when nothing was done).
--   The backstop for story holds nothing will end (lib/story/holdSweeper.js, cron /api/cron/story-holds). Under the
--   account lock and the hold row lock it releases what is left of an ACTIVE hold of a PROJECT when the hold is older
--   than max(min_age_minutes, 30) and nothing can still settle or release it:
--     - no story job carries it that is queued or running, or finished with its share not yet applied (applied_at
--       null): such a job settles or releases its own share;
--     - no open clip claim (gen_hold_id with gen_claim_id), still claim (story_shots.still_hold_id), cast round
--       (story_cast.hold_id) or audio claim (audio_claims.<kind>.hold_id) of the project points at it: their own
--       stall recoveries end those (the sweeper runs them first);
--     - it is not an old-tools hold (credit_legacy_holds, ended by /api/cron/legacy-holds) or a voice hold
--       (story_voices.hold_id).
--   Holds without a project (old tools, voice clones) are never touched here. A repeat is harmless (a closed hold or
--   an empty remainder gives 0).
--
-- story_retention_due(limit) -> projects whose files_expire_at has passed, not yet 'expired', with no queued or
--   running job, oldest expiry first.
-- story_project_file_keys(project) -> every storage key the project's rows name: narration/music/thumbnail, shot
--   stills and clips, cast pictures (image_key and every "key" in candidates and sheet), renders, the project's
--   references (storage_key and frames) and any "key" in its jobs' results.
-- story_keys_in_use(keys, project) -> the keys of `keys` that must NOT be deleted: any story_assets.storage_key (or the
--   object an asset's url points at when it has no storage_key) (brand
--   kit and own files never expire with a project; own-picture cast rows reuse that key as image_key), or a key named
--   by a project other than `project` whose status is not 'expired' (duplicates share keys: refcount).
-- story_expire_project(project) -> true when the project was marked expired now.

create or replace function public.story_release_orphan_hold(p_hold uuid, p_min_age_minutes integer default 30)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  h credit_holds;
  v_left integer;
begin
  select * into h from credit_holds where id = p_hold;
  if not found or h.status <> 'active' or h.project_id is null
     or h.created_at > now() - make_interval(mins => greatest(coalesce(p_min_age_minutes, 30), 30)) then
    return 0;
  end if;
  -- Same lock order as every credit_* function: the account, then the hold.
  perform credit_lock_account(h.user_id, h.currency);
  select * into h from credit_holds where id = p_hold for update;
  if h.status <> 'active' or h.remaining = 0 then
    return 0;
  end if;
  if exists (
       select 1 from story_jobs j
        where j.project_id = h.project_id and j.hold_id = h.id
          and (j.status in ('queued', 'running') or (j.applied_at is null and coalesce(j.cost_credits, 0) > 0))
     )
     or exists (select 1 from story_jobs j where j.project_id is null and j.hold_id = h.id and j.status in ('queued', 'running'))
     or exists (select 1 from story_projects p where p.id = h.project_id and p.gen_hold_id = h.id and p.gen_claim_id is not null)
     or exists (
       select 1 from story_projects p
        where p.id = h.project_id
          and (p.audio_claims -> 'narration' ->> 'hold_id' = h.id::text or p.audio_claims -> 'music' ->> 'hold_id' = h.id::text)
     )
     or exists (select 1 from story_shots s where s.project_id = h.project_id and s.still_hold_id = h.id)
     or exists (select 1 from story_cast c where c.project_id = h.project_id and c.hold_id = h.id)
     or exists (select 1 from story_voices v where v.hold_id = h.id)
     or exists (select 1 from credit_legacy_holds l where l.hold_id = h.id) then
    return 0;
  end if;
  v_left := h.remaining;
  perform credit_release(p_hold);
  return v_left;
end
$$;

create or replace function public.story_retention_due(p_limit integer)
returns setof public.story_projects
language sql
security definer
set search_path = public, pg_temp
as $$
  select p.* from story_projects p
   where p.files_expire_at is not null and p.files_expire_at < now() and p.status <> 'expired'
     and not exists (select 1 from story_jobs j where j.project_id = p.id and j.status in ('queued', 'running'))
   order by p.files_expire_at, p.id
   limit greatest(coalesce(p_limit, 0), 0);
$$;

-- Every string "key" member anywhere in a jsonb value.
create or replace function public.story_json_keys(p_value jsonb)
returns setof text
language sql
immutable
set search_path = public, pg_temp
as $$
  select k #>> '{}' from jsonb_path_query(coalesce(p_value, 'null'::jsonb), 'lax $.**.key') as k
   where jsonb_typeof(k) = 'string';
$$;

create or replace function public.story_project_file_keys(p_project uuid)
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct k from (
    select unnest(array[p.narration_key, p.music_key, p.thumbnail_key]) as k from story_projects p where p.id = p_project
    union all select s.still_key from story_shots s where s.project_id = p_project
    union all select s.clip_key from story_shots s where s.project_id = p_project
    union all select c.image_key from story_cast c where c.project_id = p_project
    union all select story_json_keys(c.candidates) from story_cast c where c.project_id = p_project
    union all select story_json_keys(c.sheet) from story_cast c where c.project_id = p_project
    union all select r.storage_key from story_renders r where r.project_id = p_project
    union all select f.storage_key from story_references f where f.project_id = p_project
    union all select story_json_keys(f.frames) from story_references f where f.project_id = p_project
    union all select story_json_keys(j.result) from story_jobs j where j.project_id = p_project
  ) t
  where k is not null and k <> '';
$$;

create or replace function public.story_keys_in_use(p_keys text[], p_project uuid)
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with wanted as (select distinct unnest(p_keys) as k),
  live as (select id from story_projects where status <> 'expired' and id is distinct from p_project),
  used as (
    select a.storage_key as k from story_assets a where a.storage_key = any (p_keys)
    -- An asset row with no storage_key still owns the object its url points at.
    union all select w.k from wanted w
      where exists (select 1 from story_assets a where a.storage_key is null and right(a.url, length(w.k) + 1) = '/' || w.k)
    union all select unnest(array[p.narration_key, p.music_key, p.thumbnail_key]) from story_projects p
      join live on live.id = p.id
      where p.narration_key = any (p_keys) or p.music_key = any (p_keys) or p.thumbnail_key = any (p_keys)
    union all select s.still_key from story_shots s join live on live.id = s.project_id where s.still_key = any (p_keys)
    union all select s.clip_key from story_shots s join live on live.id = s.project_id where s.clip_key = any (p_keys)
    union all select c.image_key from story_cast c join live on live.id = c.project_id where c.image_key = any (p_keys)
    union all select story_json_keys(c.candidates) from story_cast c join live on live.id = c.project_id
    union all select story_json_keys(c.sheet) from story_cast c join live on live.id = c.project_id
    union all select r.storage_key from story_renders r join live on live.id = r.project_id where r.storage_key = any (p_keys)
    union all select f.storage_key from story_references f join live on live.id = f.project_id where f.storage_key = any (p_keys)
    union all select story_json_keys(f.frames) from story_references f join live on live.id = f.project_id
    union all select story_json_keys(j.result) from story_jobs j join live on live.id = j.project_id
  )
  select distinct w.k from wanted w join used u on u.k = w.k;
$$;

create or replace function public.story_expire_project(p_project uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update story_projects set status = 'expired', updated_at = now()
   where id = p_project and status <> 'expired' and files_expire_at is not null and files_expire_at < now();
  return found;
end
$$;

-- ---------------------------------------------------------------- privileges

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any (array[
          'story_release_orphan_hold', 'story_retention_due', 'story_json_keys', 'story_project_file_keys',
          'story_keys_in_use', 'story_expire_project'
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
end
$$;
