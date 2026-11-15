-- Task 15 (storyboard). Applies after 20261114000700_story_cast.sql. Touches
-- only public.story_shots (a story_ table) and adds one function.
--
-- still_round : which still attempt the row is waiting for. Starting a still
--               (first, re-roll or retry) and changing the description each
--               move it up by one; a still job carries the round it was made
--               for and never writes to a row that has moved on.
--
-- story_shots_replace(project, shots) swaps in a new shot list in one
-- statement under the project row lock, so a rebuild that dies halfway or two
-- rebuilds at the same moment cannot lose or duplicate shots.
--   shots: [{ sceneId, description, line, seconds, quality, castIds }] in order.
--   Each incoming shot keeps the first unused existing row with the same
--   (scene_id, description, line): that row keeps its id, still, clip,
--   quality, seconds, source and counters; only ord and cast_ids change, and
--   stale is cleared when the row has no clip (nothing left to update).
--   Incoming shots with no match are inserted as drafts; existing rows that
--   matched nothing are deleted.
--   Raises 'shots_busy' while a still or clip job of the project is queued or
--   running, or a shot is waiting for one, and 'not_found' for no project.
--   Returns the project's shots, by ord.

alter table public.story_shots
  add column still_round integer not null default 0 check (still_round >= 0);

create function public.story_shots_replace(p_project uuid, p_shots jsonb)
returns setof public.story_shots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e jsonb;
  i integer;
  v_id uuid;
  kept uuid[] := '{}';
  kept_ord integer[] := '{}';
  kept_cast jsonb[] := '{}';
  fresh jsonb[] := '{}';
  fresh_ord integer[] := '{}';
  k integer;
begin
  perform 1 from story_projects where id = p_project for update;
  if not found then
    raise exception 'not_found';
  end if;

  if exists (
    select 1 from story_jobs
     where project_id = p_project and kind in ('still', 'clip') and status in ('queued', 'running')
  ) or exists (
    select 1 from story_shots
     where project_id = p_project and status in ('still_pending', 'queued', 'generating')
  ) then
    raise exception 'shots_busy';
  end if;

  for e, i in
    select t.e, (t.ord - 1)::integer from jsonb_array_elements(coalesce(p_shots, '[]'::jsonb)) with ordinality as t(e, ord)
  loop
    select s.id into v_id
      from story_shots s
     where s.project_id = p_project
       and s.scene_id is not distinct from (e ->> 'sceneId')
       and s.description is not distinct from (e ->> 'description')
       and s.line is not distinct from (e ->> 'line')
       and s.id <> all (kept)
     order by s.ord, s.created_at
     limit 1;
    if v_id is not null then
      kept := kept || v_id;
      kept_ord := kept_ord || i;
      kept_cast := kept_cast || coalesce(e -> 'castIds', '[]'::jsonb);
    else
      fresh := fresh || e;
      fresh_ord := fresh_ord || i;
    end if;
  end loop;

  delete from story_shots where project_id = p_project and id <> all (kept);

  for k in 1 .. coalesce(array_length(kept, 1), 0) loop
    update story_shots
       set ord = kept_ord[k],
           cast_ids = array(select jsonb_array_elements_text(kept_cast[k])::uuid),
           stale = stale and clip_url is not null
     where id = kept[k];
  end loop;

  for k in 1 .. coalesce(array_length(fresh, 1), 0) loop
    insert into story_shots (project_id, ord, scene_id, description, line, seconds, quality, cast_ids)
    values (
      p_project,
      fresh_ord[k],
      fresh[k] ->> 'sceneId',
      fresh[k] ->> 'description',
      fresh[k] ->> 'line',
      (fresh[k] ->> 'seconds')::integer,
      coalesce(fresh[k] ->> 'quality', 'standard'),
      array(select jsonb_array_elements_text(coalesce(fresh[k] -> 'castIds', '[]'::jsonb))::uuid)
    );
  end loop;

  return query select * from story_shots where project_id = p_project order by ord;
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
     where n.nspname = 'public' and p.proname = 'story_shots_replace'
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
