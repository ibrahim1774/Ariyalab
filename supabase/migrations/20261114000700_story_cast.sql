-- Task 14 (cast). Applies after 20261114000200_story_schema.sql. Touches only
-- public.story_cast (a story_ table) and adds one function.
--
-- voice_note : the model's note on how the character sounds (used when the
--              audio step picks or clones a voice).
-- round      : which batch of pictures the row is waiting for. A start, a
--              regeneration or a retry each begin a new round; a job from an
--              older round never writes to the row.
-- sheet      : is now ONE flat image, { url, key, from_key } ({} until it is made):
--              front, three quarter and close up in a single picture made from
--              the picked candidate (from_key is that candidate's key). The
--              { front, three_quarter, face } shape in the 000200 comment is
--              not used. candidates is [{ slot, url, key, prompt }], by slot.
-- (project_id, ord) is unique, so two requests starting the cast at the same
-- moment cannot both insert the characters.
--
-- story_cast_apply(cast, round, slot, url, key, prompt) records one finished
-- picture (url null: a picture that failed) and recomputes the row's status
-- from its jobs, all under a row lock, so three pictures finishing at the same
-- moment cannot overwrite each other. Calling it again with the same
-- arguments changes nothing more. Returns the new status, or null when the
-- row is gone or the job belongs to an older round.

alter table public.story_cast
  add column voice_note text,
  add column round integer not null default 1 check (round >= 1);

drop index public.story_cast_project_idx;
create unique index story_cast_project_ord_idx on public.story_cast (project_id, ord);

create function public.story_cast_apply(
  p_cast uuid,
  p_round integer,
  p_slot integer,
  p_url text default null,
  p_key text default null,
  p_prompt text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.story_cast%rowtype;
  merged jsonb;
  v_active integer;
  v_blocked integer;
  v_status text;
  v_chosen integer;
begin
  select * into c from story_cast where id = p_cast for update;
  if not found or c.round <> p_round then
    return null;
  end if;

  merged := c.candidates;
  if p_url is not null and p_key is not null then
    select coalesce(jsonb_agg(x.e order by (x.e ->> 'slot')::integer), '[]'::jsonb)
      into merged
      from (
        select t.e from jsonb_array_elements(c.candidates) as t(e)
         where (t.e ->> 'slot')::integer is distinct from p_slot
        union all
        select jsonb_build_object('slot', p_slot, 'url', p_url, 'key', p_key, 'prompt', p_prompt)
      ) as x(e);
  end if;

  -- Jobs still working on this round. A job that is done but whose result is
  -- not applied yet counts as finished: it applies itself a moment later.
  select count(*) filter (where j.status in ('queued', 'running')),
         count(*) filter (where j.status = 'blocked')
    into v_active, v_blocked
    from story_jobs j
   where j.project_id = c.project_id
     and j.kind = 'cast_image'
     and j.payload ->> 'castId' = c.id::text
     and j.payload ->> 'stage' = 'candidate'
     and (j.payload ->> 'round')::integer = p_round;

  if v_active > 0 then
    v_status := 'pending';
  elsif jsonb_array_length(merged) > 0 then
    v_status := 'ready';
  elsif v_blocked > 0 then
    v_status := 'blocked';
  else
    v_status := 'failed';
  end if;

  -- The pick follows its picture when the list changes order.
  v_chosen := c.chosen_index;
  if c.image_key is not null then
    select (w.ord - 1)::integer into v_chosen
      from jsonb_array_elements(merged) with ordinality as w(e, ord)
     where w.e ->> 'key' = c.image_key
     limit 1;
  end if;

  update story_cast
     set candidates = merged,
         status = v_status,
         chosen_index = v_chosen
   where id = c.id;
  return v_status;
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
     where n.nspname = 'public' and p.proname = 'story_cast_apply'
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
