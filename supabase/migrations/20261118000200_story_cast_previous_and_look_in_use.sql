-- Two additive changes for "Make them look like a picture" (e2e-4 review round 1).
--
-- story_cast.previous : the character's picture as it was when a new round of pictures was claimed (candidates, pick, own picture,
--   sheet, free redraws used, style mark). If the round ends with no picture (failed or blocked) the server puts it back instead of
--   leaving the character empty (lib/story/cast.js restorePreviousPicture); after that it holds { restored: true } so the screen can
--   say the character kept its picture. null for a character that had no picture (a first draw).
-- story_asset_delete : a picture is also "in use" while a character that is being drawn from it (status draft or pending) points at
--   it, so it cannot be deleted from under the provider. A finished character does not hold it (there is no way to take it out).
alter table public.story_cast add column if not exists previous jsonb;

create or replace function public.story_asset_delete(p_user uuid, p_asset uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.story_assets;
  v_projects jsonb;
  v_voices jsonb;
begin
  select * into v_row from public.story_assets where id = p_asset and user_id = p_user for update;
  if not found then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title) order by p.title, p.id), '[]'::jsonb)
    into v_projects
    from public.story_projects p
   where p.user_id = p_user
     and (
       exists (select 1 from public.story_shots s
                where s.project_id = p.id
                  and (s.footage_asset_id = p_asset or s.inset_asset_id = p_asset or p_asset = any (s.ref_asset_ids)))
       or exists (select 1 from public.story_cast c where c.project_id = p.id and c.asset_id = p_asset)
       or exists (select 1 from public.story_cast c where c.project_id = p.id and c.look_asset_id = p_asset and c.status in ('draft', 'pending'))
       or exists (select 1 from public.story_references r where r.project_id = p.id and r.asset_id = p_asset)
       or p.audio_plan ->> 'voiceTrackAssetId' = p_asset::text
       or p.audio_plan #>> '{music,assetId}' = p_asset::text
     );
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name) order by v.name, v.id), '[]'::jsonb)
    into v_voices
    from public.story_voices v
   where v.user_id = p_user and v.sample_asset_id = p_asset;
  if jsonb_array_length(v_projects) > 0 or jsonb_array_length(v_voices) > 0 then
    return jsonb_build_object('deleted', false, 'projects', v_projects, 'voices', v_voices);
  end if;
  delete from public.story_assets where id = p_asset;
  return jsonb_build_object('deleted', true, 'row', to_jsonb(v_row));
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
     where n.nspname = 'public' and p.proname = 'story_asset_delete'
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
