-- Story video maker: job runner support (Task 12, lib/story/runner.js).
--
-- Columns the runner keeps on story_jobs (all written by the service role):
--   started_at          when the current try was claimed; names the try (every
--                       transition out of 'running' matches on it)
--   submitted_at        set just BEFORE the provider is called: a running job
--                       with submitted_at and no provider_task_id has an unknown
--                       submit outcome and is failed, never re-submitted; also
--                       the start of the per-kind hard cap for slow tasks
--   applied_at          set once the job's side effects ran (onDone, or the
--                       hold release + onFail); null on a finished job means the
--                       sweeper must re-apply them
--   apply_tries         failed side-effect runs
--   mirror_tries        failed copies of a finished result into our storage
--   poll_errors         provider errors in a row while polling
--   no_handler_rounds   claims that found no registered handler
--   rate_limited_since  first rate limit of the current wait
--
-- story_claim_jobs takes the clock as p_now (rounded to milliseconds, so the
-- returned started_at round-trips through JavaScript exactly), can be limited
-- to some kinds or skip some kinds, claims account-level jobs (project_id
-- null) when p_project is null, and can claim from any project (worker
-- routes). It is dropped and recreated: create or replace with extra
-- defaulted arguments would leave an overload and make calls ambiguous.

alter table public.story_jobs
  add column started_at timestamptz,
  add column submitted_at timestamptz,
  add column applied_at timestamptz,
  add column apply_tries integer not null default 0 check (apply_tries >= 0),
  add column mirror_tries integer not null default 0 check (mirror_tries >= 0),
  add column poll_errors integer not null default 0 check (poll_errors >= 0),
  add column no_handler_rounds integer not null default 0 check (no_handler_rounds >= 0),
  add column rate_limited_since timestamptz;

-- One job per provider task: a callback or poll can only ever match one row.
drop index public.story_jobs_provider_task_idx;
create unique index story_jobs_provider_task_idx on public.story_jobs (provider, provider_task_id)
  where provider_task_id is not null;

-- The cron and sweeper read these.
create index story_jobs_active_idx on public.story_jobs (project_id)
  where status in ('queued', 'running');
create index story_jobs_unapplied_idx on public.story_jobs (status)
  where applied_at is null and status in ('done', 'failed', 'blocked');

drop function public.story_claim_jobs(uuid, integer);

-- Claims up to p_limit due queued jobs, oldest first: of p_project, of the
-- account (project_id null) when p_project is null, or of every project when
-- p_any_project. Due: run_after null or not after p_now. p_kinds limits the
-- kinds, p_skip_kinds excludes kinds. Each claimed job becomes 'running' with
-- attempts + 1 (the try number), started_at = p_now and locked_until =
-- p_now + 2 minutes. for update skip locked makes concurrent claims exclusive.
create function public.story_claim_jobs(
  p_project uuid,
  p_limit integer,
  p_now timestamptz default now(),
  p_kinds text[] default null,
  p_skip_kinds text[] default null,
  p_any_project boolean default false
)
returns setof public.story_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := date_trunc('milliseconds', coalesce(p_now, now()));
  v_limit integer := greatest(coalesce(p_limit, 0), 0);
  v_ids uuid[];
begin
  if coalesce(p_any_project, false) then
    select array_agg(s.id) into v_ids from (
      select j.id from story_jobs j
       where j.status = 'queued'
         and (j.run_after is null or j.run_after <= v_now)
         and (p_kinds is null or j.kind = any (p_kinds))
         and (p_skip_kinds is null or not (j.kind = any (p_skip_kinds)))
       order by j.created_at, j.id
       limit v_limit
       for update skip locked
    ) s;
  elsif p_project is null then
    select array_agg(s.id) into v_ids from (
      select j.id from story_jobs j
       where j.project_id is null
         and j.status = 'queued'
         and (j.run_after is null or j.run_after <= v_now)
         and (p_kinds is null or j.kind = any (p_kinds))
         and (p_skip_kinds is null or not (j.kind = any (p_skip_kinds)))
       order by j.created_at, j.id
       limit v_limit
       for update skip locked
    ) s;
  else
    -- Uses story_jobs_claim_idx (project_id, created_at) where status = 'queued'.
    select array_agg(s.id) into v_ids from (
      select j.id from story_jobs j
       where j.project_id = p_project
         and j.status = 'queued'
         and (j.run_after is null or j.run_after <= v_now)
         and (p_kinds is null or j.kind = any (p_kinds))
         and (p_skip_kinds is null or not (j.kind = any (p_skip_kinds)))
       order by j.created_at, j.id
       limit v_limit
       for update skip locked
    ) s;
  end if;

  return query
    update story_jobs j
       set status = 'running',
           started_at = v_now,
           locked_until = v_now + interval '2 minutes',
           attempts = j.attempts + 1
     where j.id = any (coalesce(v_ids, '{}'::uuid[]))
    returning j.*;
end;
$$;

-- Distinct project ids (null = account-level jobs) with work the cron should
-- tick: a due queued job or a running job. Oldest work first.
create function public.story_pending_projects(p_now timestamptz default now(), p_limit integer default 200)
returns table (project_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.project_id from (
    select j.project_id, min(j.created_at) as first_at
      from story_jobs j
     where j.status = 'running'
        or (j.status = 'queued' and (j.run_after is null or j.run_after <= coalesce(p_now, now())))
     group by j.project_id
  ) t
  order by t.first_at
  limit greatest(coalesce(p_limit, 0), 0);
$$;

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (array['story_claim_jobs', 'story_pending_projects'])
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
end $$;
