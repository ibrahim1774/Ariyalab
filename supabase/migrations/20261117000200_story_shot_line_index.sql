-- Which line of its scene a shot carries (0 based), set when the shot plan is made. The speaker of a shot is the speaker
-- of that script line (lib/story/speakers.js). Null for shots planned before this existed (matched by position instead).
-- Additive: one nullable column, and story_shots_replace (same signature, so its grants stay) also writes it.
alter table public.story_shots add column if not exists line_index integer check (line_index is null or line_index >= 0);

create or replace function public.story_shots_replace(
  p_project uuid,
  p_shots jsonb,
  p_confirm integer default 0,
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
  kept_li integer[] := '{}';
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
      kept_li := kept_li || null::integer;
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
      kept_li := kept_li || (e ->> 'lineIndex')::integer;
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
  if v_lost > coalesce(p_confirm, 0) then
    raise exception 'rebuild_loses_clips:%', v_lost;
  end if;

  delete from story_shots where project_id = p_project and id <> all (kept);

  for k in 1 .. coalesce(array_length(kept, 1), 0) loop
    update story_shots
       set ord = kept_ord[k],
           cast_ids = case when kept_cast[k] is null then cast_ids
                           else array(select jsonb_array_elements_text(kept_cast[k])::uuid) end,
           scene_sig = coalesce(kept_sig[k], scene_sig),
           line_index = case when kept_li[k] is null then line_index else kept_li[k] end
     where id = kept[k];
  end loop;

  for k in 1 .. coalesce(array_length(fresh, 1), 0) loop
    insert into story_shots (project_id, ord, scene_id, scene_sig, description, line, line_index, seconds, quality, cast_ids, free_still)
    values (
      p_project,
      fresh_ord[k],
      fresh[k] ->> 'sceneId',
      fresh[k] ->> 'sceneSig',
      fresh[k] ->> 'description',
      fresh[k] ->> 'line',
      (fresh[k] ->> 'lineIndex')::integer,
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

