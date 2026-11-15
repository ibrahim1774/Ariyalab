-- Task 19 (narration, music, audio plan). Applies after 20261114000800_story_storyboard.sql.
-- Touches only public.story_projects (a story_ table) and adds two functions.
--
-- narration_segments : where each narrator line sits in the narration track,
--                      [{ sceneId, lineIndex, text, start, end }] in seconds
--                      (lib/story/audio.js). The render and captions read it.
-- narration_seconds  : length of the narration track.
-- audio_claims       : { narration?: claim, music?: claim }. A claim is
--                      { id, hold_id, counted, at }: the start of a generation
--                      that is being queued. It is set under the project row
--                      lock, so two requests never start two generations, and
--                      cleared once the job is queued. A claim older than 30 s
--                      with no job was left by a request that died, and
--                      lib/story/audio.js gives its hold back and un-counts it.
--
-- story_audio_claim(project, kind, claim, hold, counted, now, used) -> the project row,
--   or no row when the project is missing, a claim is open, a job of that
--   kind is queued, running or finished but not yet applied, or `used` is given
--   and is no longer the kind's counter (the price was worked out from it).
--   When counted, the counter (narrations_used or music_used) goes up in the
--   same step.
-- story_audio_unclaim(project, kind, claim, uncount) -> true when that claim
--   was open and is now cleared (and, when uncount, un-counted).

alter table public.story_projects
  add column narration_segments jsonb,
  add column narration_seconds real check (narration_seconds >= 0),
  add column audio_claims jsonb not null default '{}'::jsonb;

create function public.story_audio_claim(
  p_project uuid,
  p_kind text,
  p_claim uuid,
  p_hold uuid,
  p_counted boolean,
  p_now timestamptz default now(),
  p_used integer default null
)
returns setof public.story_projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_projects%rowtype;
  v_used integer;
begin
  if p_kind not in ('narration', 'music') then
    raise exception 'bad_kind';
  end if;
  select * into v from story_projects where id = p_project for update;
  if not found then
    return;
  end if;
  if (v.audio_claims -> p_kind) is not null then
    return;
  end if;
  v_used := case when p_kind = 'narration' then v.narrations_used else v.music_used end;
  if p_used is not null and p_used <> v_used then
    return;
  end if;
  if exists (
    select 1 from story_jobs
     where project_id = p_project and kind = p_kind
       and (status in ('queued', 'running') or (status = 'done' and applied_at is null))
  ) then
    return;
  end if;
  return query
    update story_projects
       set audio_claims = audio_claims || jsonb_build_object(
             p_kind, jsonb_build_object('id', p_claim, 'hold_id', p_hold, 'counted', coalesce(p_counted, false), 'at', p_now)),
           narrations_used = narrations_used + case when p_kind = 'narration' and p_counted then 1 else 0 end,
           music_used = music_used + case when p_kind = 'music' and p_counted then 1 else 0 end
     where id = p_project
    returning *;
end
$$;

create function public.story_audio_unclaim(
  p_project uuid,
  p_kind text,
  p_claim uuid,
  p_uncount boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v story_projects%rowtype;
  v_counted boolean;
begin
  if p_kind not in ('narration', 'music') then
    raise exception 'bad_kind';
  end if;
  select * into v from story_projects where id = p_project for update;
  if not found or (v.audio_claims -> p_kind ->> 'id') is distinct from p_claim::text then
    return false;
  end if;
  v_counted := coalesce((v.audio_claims -> p_kind ->> 'counted')::boolean, false);
  update story_projects
     set audio_claims = audio_claims - p_kind,
         narrations_used = greatest(0, narrations_used - case when p_kind = 'narration' and p_uncount and v_counted then 1 else 0 end),
         music_used = greatest(0, music_used - case when p_kind = 'music' and p_uncount and v_counted then 1 else 0 end)
   where id = p_project;
  return true;
end
$$;

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('story_audio_claim', 'story_audio_unclaim')
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
