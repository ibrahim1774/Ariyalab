-- Task 16 (quote, generate, re-roll). Applies after 20261114000900_story_audio.sql.
-- Touches public.story_shots and public.story_projects (story_ tables), adds
-- one function and replaces story_delete_project.
--
-- story_shots.clip_round : which clip attempt the row is waiting for. Every
--                          start (generate, retry, re-roll) moves it up by one;
--                          a clip job carries the round it was made for and
--                          never writes to a row that has moved on. It never
--                          moves backwards.
-- story_shots.clip_prev  : { status, error } to put back when a start is
--                          undone (lib/story/shots.js).
--
-- story_projects.gen_claim_id / gen_hold_id / gen_claimed_at / gen_shots /
-- gen_rerolls: a start of clips that is being queued (one at a time per
-- project). Set by story_clip_claim under the project row lock, cleared by
-- the request once every job is queued. A claim older than 30 s was left by a
-- request that died: lib/story/shots.js takes it off the row, gives back the
-- part of its hold no queued job carries and puts the shots without a job
-- back. gen_shots = [{ id, round, status }] as claimed; gen_rerolls = free
-- re-rolls the claim counted (given back when the start is undone).
--
-- story_shots.clip_mismatch (from 20261114000800) is now also set by a
-- quality change on a shot with a clip, and cleared when the quality goes back
-- to the one the clip was made at (lib/story/storyboard.js updateShot).
--
-- story_projects.status_ticked_at: when GET /status last ran a runner tick for
-- the project (at most one every 3 s per project; lib/story/status.js).
--
-- story_clip_claim(project, claim, hold, shots, rerolls_used, rerolls_add, now)
--   claims every shot in p_shots ([{ id, round, status }]) or none: each must
--   still have that clip_round and status, a still, source 'generated', and no
--   clip job in flight or waiting to be applied; the project must have no other
--   claim and, when p_rerolls_used is given, that many free re-rolls used.
--   Sets the shots 'queued' (clip_round + 1, clip_prev) and records the claim.
--   The update repeats the round and status checks and raises 'shots_changed'
--   (rolling the claim back) if it does not touch every shot.
--   -> the claimed rows, or no row.
--
-- story_delete_project now also refuses ('project_busy') while a job's hold
-- share is not settled or released yet (applied_at null with a hold; the
-- runner always ends that state, marking the row applied even when it gives
-- up), or a still, cast round or clip start claimed in the last 2 minutes is
-- still being queued (its hold is in flight).

alter table public.story_shots
  add column clip_round integer not null default 0 check (clip_round >= 0),
  add column clip_prev jsonb;

alter table public.story_projects
  add column gen_claim_id uuid,
  add column gen_hold_id uuid,
  add column gen_claimed_at timestamptz,
  add column gen_shots jsonb,
  add column gen_rerolls integer not null default 0 check (gen_rerolls >= 0),
  add column status_ticked_at timestamptz;

-- The status tick stamp is bookkeeping like the cron's rotation stamp: it must not move updated_at.
drop trigger story_projects_touch on public.story_projects;
create trigger story_projects_touch before update on public.story_projects
  for each row
  when ((to_jsonb(old) - 'runner_ticked_at' - 'status_ticked_at' - 'updated_at')
        is distinct from (to_jsonb(new) - 'runner_ticked_at' - 'status_ticked_at' - 'updated_at'))
  execute function public.story_touch_updated_at();

create function public.story_clip_claim(
  p_project uuid,
  p_claim uuid,
  p_hold uuid,
  p_shots jsonb,
  p_rerolls_used integer default null,
  p_rerolls_add integer default 0,
  p_now timestamptz default now()
)
returns setof public.story_shots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project story_projects;
  v_want integer;
  v_found integer;
begin
  select * into v_project from story_projects where id = p_project for update;
  if not found then
    return;
  end if;
  if v_project.gen_claim_id is not null then
    return;
  end if;
  if p_rerolls_used is not null and v_project.rerolls_used <> p_rerolls_used then
    return;
  end if;
  v_want := coalesce(jsonb_array_length(p_shots), 0);
  if v_want = 0 then
    return;
  end if;
  select count(*) into v_found
    from story_shots s
    join jsonb_to_recordset(p_shots) as x(id uuid, round integer, status text) on s.id = x.id
   where s.project_id = p_project
     and s.clip_round = x.round
     and s.status = x.status
     and s.still_url is not null
     and s.source = 'generated';
  if v_found <> v_want then
    return;
  end if;
  if exists (
    select 1 from story_jobs j
     where j.project_id = p_project
       and j.kind = 'clip'
       and j.shot_id in (select x.id from jsonb_to_recordset(p_shots) as x(id uuid))
       and (j.status in ('queued', 'running') or (j.applied_at is null and j.status in ('done', 'failed', 'blocked')))
  ) then
    return;
  end if;
  update story_projects
     set gen_claim_id = p_claim,
         gen_hold_id = p_hold,
         gen_claimed_at = p_now,
         gen_shots = p_shots,
         gen_rerolls = coalesce(p_rerolls_add, 0),
         rerolls_used = rerolls_used + coalesce(p_rerolls_add, 0)
   where id = p_project;
  update story_shots s
     set status = 'queued',
         clip_round = s.clip_round + 1,
         clip_prev = jsonb_build_object('status', s.status, 'error', s.error),
         error = null
    from jsonb_to_recordset(p_shots) as x(id uuid, round integer, status text)
   where s.id = x.id and s.project_id = p_project and s.clip_round = x.round and s.status = x.status;
  get diagnostics v_found = row_count;
  if v_found <> v_want then
    raise exception 'shots_changed';
  end if;
  return query
    select s.* from story_shots s
     where s.project_id = p_project and s.id in (select x.id from jsonb_to_recordset(p_shots) as x(id uuid));
end
$$;

create or replace function public.story_delete_project(p_user uuid, p_project uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from story_projects where id = p_project and user_id = p_user for update;
  if not found then
    return false;
  end if;
  if exists (select 1 from story_jobs where project_id = p_project and status in ('queued', 'running')) then
    raise exception 'project_busy';
  end if;
  -- A finished job whose hold share the runner has not settled or released yet.
  if exists (
    select 1 from story_jobs
     where project_id = p_project and applied_at is null and hold_id is not null and coalesce(cost_credits, 0) > 0
  ) then
    raise exception 'project_busy';
  end if;
  -- A start whose hold is in flight (claimed in the last 2 minutes, not queued yet). Older claims were
  -- left by requests that died: deleteProject (lib/story/projects.js) runs the stall recoveries first, which
  -- give their holds back; a dead cast round's hold is left to the stale-hold sweeper.
  if exists (select 1 from story_projects where id = p_project and gen_claim_id is not null and gen_claimed_at > now() - interval '2 minutes')
     or exists (select 1 from story_shots where project_id = p_project and still_hold_id is not null and still_claimed_at > now() - interval '2 minutes')
     or exists (select 1 from story_cast where project_id = p_project and hold_id is not null and updated_at > now() - interval '2 minutes') then
    raise exception 'project_busy';
  end if;
  delete from story_projects where id = p_project;
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
     where n.nspname = 'public' and p.proname in ('story_clip_claim', 'story_delete_project')
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
