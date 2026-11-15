-- Task 15 (storyboard). Applies after 20261114000700_story_cast.sql. Touches
-- only public.story_shots (a story_ table) and adds two functions.
--
-- still_round      : which still attempt the row is waiting for. Starting a
--                    still (first, re-roll or retry) and changing the
--                    description each move it up by one; a still job carries
--                    the round it was made for and never writes to a row that
--                    has moved on.
-- still_hold_id    : the hold of a still attempt that is being started (set by
--   still_claimed_at the claim, cleared once its job is queued), and when the
--   still_prev       claim was made, with the status, stale and error to go
--                    back to. A claim older than 30 s with no job of its round
--                    was left by a request that died: its hold is released and
--                    the row put back (lib/story/storyboard.js).
-- still_delivered  : a still has been delivered for this row (set by the still
--                    job when its picture lands).
-- free_still       : the row's first still is free. False for shots that
--                    replace shots of a scene which already had a still (or
--                    already had paid-only shots), so rebuilding a scene does
--                    not hand out new free stills.
-- scene_sig        : the scene (title, visual, lines, mention) the row was
--                    planned from; a rebuild keeps every row of a scene whose
--                    sig is unchanged, and markStale uses the same sig.
-- still_base_round : the still_round of the last description change. A failed
--                    still job from before it cannot be retried.
-- clip_mismatch    : the clip no longer matches the shot's own description or
--                    still (a description edit, or a new still, on a shot with
--                    a clip). Such a shot stays stale through rebuilds; making
--                    a new clip (Task 16) clears it with stale.
-- still_round never moves backwards: a start that is put back keeps its round,
-- so a job of the aborted start can never land on a later attempt.
--
-- story_shot_claim(project, shot, round, status, description, hold, now)
--   starts a still attempt under the project row lock (so it cannot interleave
--   with story_shots_replace): only while the row still has that round, status
--   and description. -> the claimed row, or no row.
--
-- story_shots_replace(project, shots, confirm, min, max) swaps in a new shot
-- list in one statement under the project row lock.
--   shots, in order: { id } keeps that row as it is (only ord changes);
--   otherwise { sceneId, sceneSig, description, line, seconds, quality,
--   castIds }, which keeps the first unused row with the same (scene_id,
--   description, line), or is inserted as a draft. Rows that match nothing are
--   deleted. Kept rows stay stale only while their clip no longer matches
--   their own description or still (clip_mismatch).
--   Raises 'shots_busy' while a still or clip job of the project is queued or
--   running or a shot is waiting for one; 'rebuild_loses_clips:<n>' when rows
--   with a clip would be deleted and confirm is false; 'shots_changed' when a
--   kept id is not the project's or the seconds no longer add up to min..max;
--   'not_found' for no project. Returns the project's shots, by ord.

alter table public.story_shots
  add column still_round integer not null default 0 check (still_round >= 0),
  add column still_hold_id uuid,
  add column still_claimed_at timestamptz,
  add column still_prev jsonb,
  add column still_delivered boolean not null default false,
  add column free_still boolean not null default true,
  add column scene_sig text,
  add column still_base_round integer not null default 0 check (still_base_round >= 0),
  add column clip_mismatch boolean not null default false;

create function public.story_shot_claim(
  p_project uuid,
  p_shot uuid,
  p_round integer,
  p_status text,
  p_description text,
  p_hold uuid default null,
  p_now timestamptz default now()
)
returns setof public.story_shots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from story_projects where id = p_project for update;
  if not found then
    return;
  end if;
  return query
    update story_shots
       set status = 'still_pending',
           still_round = p_round + 1,
           still_hold_id = p_hold,
           still_claimed_at = p_now,
           still_prev = jsonb_build_object('status', status, 'stale', stale, 'error', error, 'clip_mismatch', clip_mismatch),
           stale = case when clip_url is not null then true else stale end,
           clip_mismatch = case when clip_url is not null then true else clip_mismatch end,
           error = null
     where id = p_shot
       and project_id = p_project
       and still_round = p_round
       and status = p_status
       and description is not distinct from p_description
    returning *;
end
$$;

create function public.story_shots_replace(
  p_project uuid,
  p_shots jsonb,
  p_confirm boolean default false,
  p_min integer default null,
  p_max integer default null
)
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
  kept_sig text[] := '{}';
  fresh jsonb[] := '{}';
  fresh_ord integer[] := '{}';
  fresh_free boolean[] := '{}';
  k integer;
  v_lost integer;
  v_sum integer;
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
    v_id := null;
    if e ? 'id' then
      select s.id into v_id from story_shots s
       where s.id = (e ->> 'id')::uuid and s.project_id = p_project and s.id <> all (kept);
      if v_id is null then
        raise exception 'shots_changed';
      end if;
      kept := kept || v_id;
      kept_ord := kept_ord || i;
      kept_cast := kept_cast || null::jsonb;
      kept_sig := kept_sig || null::text;
      continue;
    end if;

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
      kept_sig := kept_sig || (e ->> 'sceneSig');
    else
      fresh := fresh || e;
      fresh_ord := fresh_ord || i;
      -- Free first stills only for a scene that never had a still (or paid-only shots) before.
      fresh_free := fresh_free || not exists (
        select 1 from story_shots s
         where s.project_id = p_project
           and s.scene_id is not distinct from (e ->> 'sceneId')
           and (s.still_delivered or not s.free_still)
      );
    end if;
  end loop;

  select count(*) into v_lost from story_shots
   where project_id = p_project and id <> all (kept) and clip_url is not null;
  if v_lost > 0 and not coalesce(p_confirm, false) then
    raise exception 'rebuild_loses_clips:%', v_lost;
  end if;

  delete from story_shots where project_id = p_project and id <> all (kept);

  for k in 1 .. coalesce(array_length(kept, 1), 0) loop
    update story_shots
       set ord = kept_ord[k],
           cast_ids = case when kept_cast[k] is null then cast_ids
                           else array(select jsonb_array_elements_text(kept_cast[k])::uuid) end,
           scene_sig = coalesce(kept_sig[k], scene_sig),
           stale = stale and clip_url is not null and clip_mismatch
     where id = kept[k];
  end loop;

  for k in 1 .. coalesce(array_length(fresh, 1), 0) loop
    insert into story_shots (project_id, ord, scene_id, scene_sig, description, line, seconds, quality, cast_ids, free_still)
    values (
      p_project,
      fresh_ord[k],
      fresh[k] ->> 'sceneId',
      fresh[k] ->> 'sceneSig',
      fresh[k] ->> 'description',
      fresh[k] ->> 'line',
      (fresh[k] ->> 'seconds')::integer,
      coalesce(fresh[k] ->> 'quality', 'standard'),
      array(select jsonb_array_elements_text(coalesce(fresh[k] -> 'castIds', '[]'::jsonb))::uuid),
      fresh_free[k]
    );
  end loop;

  select coalesce(sum(seconds), 0) into v_sum from story_shots where project_id = p_project;
  if (p_min is not null and v_sum < p_min) or (p_max is not null and v_sum > p_max) then
    raise exception 'shots_changed';
  end if;

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
     where n.nspname = 'public' and p.proname in ('story_shots_replace', 'story_shot_claim')
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
