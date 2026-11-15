-- ============================================================================
-- OPERATOR NOTE: IBRAHIM MUST REVIEW THIS BEFORE APPLYING IT.
-- The profiles table is SHARED with haelabs.live.
-- ============================================================================
--
-- WHAT IT CHANGES
--   Signed-in users (role `authenticated`) and visitors (role `anon`) can no
--   longer write profiles.stripe_customer_id from the browser (UPDATE or
--   INSERT of that column). Today a signed-in user could point their own
--   profile at someone else's Stripe customer with the public anon key. This
--   app links customers only on the server, through the service-role
--   function credit_link_customer (20261114000150_grants.sql), which keeps
--   working.
--
--   How: Postgres ignores a column-level REVOKE while the role still holds
--   the table-level privilege (Supabase grants table-level UPDATE and INSERT
--   to `authenticated` by default). So, for each of `authenticated` and
--   `anon`, and for each of UPDATE and INSERT, ONLY IF the role holds that
--   privilege on the table directly today:
--     1. revoke the table-level privilege, and
--     2. grant the same privilege again on every OTHER column, one by one.
--   A role that did not have the privilege gets nothing new. SELECT,
--   DELETE, row-level security policies, triggers and the service role are
--   not touched. Reads (by this app and by haelabs.live) are unchanged.
--
--   Side effect to know about: a column ADDED to profiles later will not be
--   writable by `authenticated` / `anon` until it is granted explicitly
--   (`grant update (new_col), insert (new_col) on public.profiles to authenticated;`).
--   Whoever adds columns for haelabs.live must know this.
--
-- CHECK FIRST (run in the Supabase SQL editor and keep the output):
--   select grantee, privilege_type, column_name
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--    order by grantee, privilege_type, column_name;
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'profiles';
--   select policyname, cmd, roles, qual, with_check
--     from pg_policies where schemaname = 'public' and tablename = 'profiles';
--
-- BEFORE APPLYING, the owner must confirm that haelabs.live NEVER updates or
-- inserts stripe_customer_id from the browser (with the anon key and a user
-- session). If it does, its checkout linking breaks after this migration;
-- it must move that write to its server (service role) first. Search the
-- haelabs.live code for `stripe_customer_id` in any client-side
-- `.update(` / `.upsert(` / `.insert(` call.
--
-- ROLL BACK (restores the table-level privileges this removed):
--   grant insert, update on public.profiles to authenticated;
--   -- and for anon only if the check above showed anon had them.
--
-- Safe to re-run; a no-op where profiles, the column or the roles are missing.
-- ============================================================================

do $$
declare
  v_role text;
  v_priv text;
  v_col text;
  v_role_oid oid;
  v_has boolean;
  v_rel oid := to_regclass('public.profiles');
begin
  if v_rel is null then
    return;
  end if;
  if not exists (
    select 1 from pg_attribute
     where attrelid = v_rel and attname = 'stripe_customer_id' and attnum > 0 and not attisdropped
  ) then
    return;
  end if;

  -- A PUBLIC grant would keep the column writable; it is not Supabase's
  -- default, so only warn (revoking it could affect other roles).
  if exists (
    select 1 from pg_class c, aclexplode(c.relacl) a
     where c.oid = v_rel and a.grantee = 0 and a.privilege_type in ('UPDATE', 'INSERT')
  ) then
    raise warning 'public.profiles grants UPDATE or INSERT to PUBLIC; stripe_customer_id stays writable through it';
  end if;

  foreach v_role in array array['authenticated', 'anon'] loop
    select oid into v_role_oid from pg_roles where rolname = v_role;
    if v_role_oid is null then
      continue;
    end if;
    foreach v_priv in array array['UPDATE', 'INSERT'] loop
      select exists (
        select 1 from pg_class c, aclexplode(c.relacl) a
         where c.oid = v_rel and a.grantee = v_role_oid and a.privilege_type = v_priv
      ) into v_has;
      if v_has then
        execute format('revoke %s on table public.profiles from %I', v_priv, v_role);
        for v_col in
          select attname from pg_attribute
           where attrelid = v_rel and attnum > 0 and not attisdropped and attname <> 'stripe_customer_id'
           order by attnum
        loop
          execute format('grant %s (%I) on table public.profiles to %I', v_priv, v_col, v_role);
        end loop;
      end if;
      execute format('revoke %s (stripe_customer_id) on table public.profiles from %I', v_priv, v_role);
    end loop;
  end loop;
end
$$;
