-- Story video maker: job runner support (Task 12, lib/story/runner.js).
--
-- 1. story_jobs.started_at: when the current try was claimed. The sweeper
--    fails a job that has been 'running' for more than 10 minutes, and
--    locked_until cannot carry that because the runner moves it forward on
--    every poll.
-- 2. story_claim_jobs takes the clock as p_now (default now()), so the
--    runner and its tests decide what "due" means with one clock. It also
--    claims account-level jobs (project_id null, e.g. voice_clone) when
--    p_project is null, and stamps started_at.
--
-- The function is dropped and recreated rather than replaced: adding a
-- defaulted argument with create or replace would leave an overload, and
-- two-argument calls would become ambiguous.

alter table public.story_jobs add column started_at timestamptz;

drop function public.story_claim_jobs(uuid, integer);

-- Claims up to p_limit due queued jobs of one project (or the account-level
-- jobs when p_project is null), oldest first. Due: run_after null or not
-- after p_now. Each claimed job becomes 'running' with attempts + 1 (the
-- try number), started_at = p_now and locked_until = p_now + 2 minutes.
-- for update skip locked makes concurrent claims exclusive.
create function public.story_claim_jobs(p_project uuid, p_limit integer, p_now timestamptz default now())
returns setof public.story_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select j.id
      from story_jobs j
     where j.project_id is not distinct from p_project
       and j.status = 'queued'
       and (j.run_after is null or j.run_after <= coalesce(p_now, now()))
     order by j.created_at, j.id
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked
  )
  update story_jobs j
     set status = 'running',
         started_at = coalesce(p_now, now()),
         locked_until = coalesce(p_now, now()) + interval '2 minutes',
         attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.*;
$$;

do $$
begin
  execute 'revoke all on function public.story_claim_jobs(uuid, integer, timestamptz) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.story_claim_jobs(uuid, integer, timestamptz) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.story_claim_jobs(uuid, integer, timestamptz) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.story_claim_jobs(uuid, integer, timestamptz) to service_role';
  end if;
end $$;

-- The cron tick looks up projects with queued or running jobs.
create index story_jobs_active_idx on public.story_jobs (project_id)
  where status in ('queued', 'running');
