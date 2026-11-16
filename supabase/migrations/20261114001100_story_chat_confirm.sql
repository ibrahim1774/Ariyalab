-- Task 18 round 1: chat confirm cards are used once.
--
-- story_chat.used_confirms lists the confirm card ids of an assistant message
-- that have been pressed (lib/story/chat.js confirmChat).
--
-- story_chat_confirm_take(project, chat, confirm) marks one card used in one
-- statement: true when this call took it, false when it was already used (or
-- the row is not that project's assistant message). Two presses at once:
-- exactly one gets true.
-- story_chat_confirm_give_back(project, chat, confirm) unmarks it when the
-- action behind the card failed and nothing was done, so it can be pressed
-- again. -> true when it was marked.

alter table public.story_chat
  add column used_confirms text[] not null default '{}';

create function public.story_chat_confirm_take(p_project uuid, p_chat uuid, p_confirm text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update story_chat
     set used_confirms = array_append(used_confirms, p_confirm)
   where id = p_chat
     and project_id = p_project
     and role = 'assistant'
     and not (p_confirm = any (used_confirms));
  return found;
end
$$;

create function public.story_chat_confirm_give_back(p_project uuid, p_chat uuid, p_confirm text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update story_chat
     set used_confirms = array_remove(used_confirms, p_confirm)
   where id = p_chat
     and project_id = p_project
     and p_confirm = any (used_confirms);
  return found;
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
     where n.nspname = 'public' and p.proname in ('story_chat_confirm_take', 'story_chat_confirm_give_back')
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
