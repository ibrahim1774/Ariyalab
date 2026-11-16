-- Task 23 (brand kit, product references, the customer's own footage). Applies after 20261116000200_story_mcp_draft_versions.sql.
-- Additive: one function, no table or column changes. story_assets / story_brand / story_project_assets already hold everything.
--
-- story_asset_delete(user, asset) -> null            when the asset is not the user's (or does not exist)
--                                 -> { deleted: false, projects: [{ id, title }], voices: [{ id, name }] }
--                                                    when it is in use; nothing is deleted
--                                 -> { deleted: true, row: <the story_assets row> }
--
-- "In use" means a project of this user keeps pointing at it: a shot's footage, picture-in-picture or reference
-- picture, a character's own image, a reference video, or the audio plan (voiceTrackAssetId, music.assetId; those two
-- live in jsonb, so no foreign key covers them). A voice clone's sample counts too. A link in story_project_assets
-- (the product pictures a video draws from) and the brand logo are not "use": the first goes with the file, the second
-- is cleared by its foreign key. The asset row is locked first, so a shot that is being pointed at the file at this
-- moment either commits before the check (and is seen) or fails its foreign key after the delete.
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

-- Same pattern as the earlier story functions: executable by service_role only; role statements are guarded so this
-- runs where the Supabase roles do not exist.
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
