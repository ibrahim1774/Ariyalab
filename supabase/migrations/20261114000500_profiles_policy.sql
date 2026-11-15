-- ============================================================================
-- OPERATOR NOTE: IBRAHIM MUST REVIEW THIS BEFORE APPLYING IT.
-- The profiles table is SHARED with haelabs.live.
-- ============================================================================
--
-- WHAT IT CHANGES (additive: one function, one trigger, no grant changes)
--   A BEFORE INSERT OR UPDATE trigger on public.profiles refuses any change
--   of stripe_customer_id made by the browser roles (`anon`,
--   `authenticated`): setting it on insert, or changing it on update (to
--   another value or to null). It raises SQLSTATE 42501 with a message
--   naming stripe_customer_id. Today a signed-in user can point their own
--   profile at someone else's Stripe customer with the public anon key.
--
--   Not affected: every other column; whole-row saves and upserts that send
--   stripe_customer_id unchanged; inserts with it null; reads; RLS policies;
--   grants (none are added or removed); the service role; the table owner;
--   and this app's server-side link function credit_link_customer
--   (20261114000150_grants.sql), which runs as its owner.
--
-- CHECK FIRST (Supabase SQL editor; keep the output):
--   select tgname, tgenabled from pg_trigger
--    where tgrelid = 'public.profiles'::regclass and not tgisinternal;
--   select policyname, cmd, roles from pg_policies
--    where schemaname = 'public' and tablename = 'profiles';
--
-- BEFORE APPLYING, the owner must confirm that haelabs.live NEVER sets or
-- changes stripe_customer_id from the browser (with the anon key and a user
-- session). If it does, that write fails after this migration; it must move
-- to its server (service role) first. Search the haelabs.live code for
-- `stripe_customer_id` in any client-side `.update(` / `.upsert(` /
-- `.insert(` call. Saving a whole profile row with the value unchanged is fine.
--
-- AFTER APPLYING (and again before turning billing_v2 on):
--   select tgenabled from pg_trigger
--    where tgrelid = 'public.profiles'::regclass and tgname = 'ariyalab_profiles_customer_guard';
--   must return one row with 'O' (or 'A'). 'D' means disabled: re-apply this file.
--
-- The migration ends with a hard check that the trigger exists and is
-- enabled, and a self-test as `authenticated` (when the applying role may
-- SET ROLE to it): if a change by `authenticated` would not be refused, the
-- whole migration is rolled back.
--
-- ROLL BACK:
--   drop trigger if exists ariyalab_profiles_customer_guard on public.profiles;
--   drop function if exists public.ariyalab_profiles_customer_guard();
--   drop function if exists public.ariyalab_profiles_customer_check(text, text, text);
--   drop function if exists public.ariyalab_profiles_customer_unchanged(uuid, text);
--
-- Safe to re-run; does nothing when public.profiles or the column is missing.
-- ============================================================================

-- The rule, as a plain function so it can be self-tested. Runs as the caller
-- (not security definer): current_user is the browser role under PostgREST.
create or replace function public.ariyalab_profiles_customer_check(p_op text, p_old text, p_new text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if (p_op = 'INSERT' and p_new is not null)
       or (p_op = 'UPDATE' and p_new is distinct from p_old) then
      raise exception 'profiles.stripe_customer_id can only be changed by the server'
        using errcode = '42501';
    end if;
  end if;
end
$$;

-- An upsert of the caller's OWN existing row that sends stripe_customer_id
-- unchanged is an insert attempt first (Postgres runs BEFORE INSERT before
-- it finds the conflict). This answers "is that the stored value?" only for
-- the caller's own row (auth.uid(), where Supabase's auth schema exists), so
-- it is no oracle for other accounts.
do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute $f$
      create or replace function public.ariyalab_profiles_customer_unchanged(p_id uuid, p_customer text)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public, pg_temp
      as $q$
        select exists (
          select 1 from public.profiles
           where id = p_id and p_id = auth.uid() and stripe_customer_id is not distinct from p_customer
        )
      $q$
    $f$;
  else
    execute $f$
      create or replace function public.ariyalab_profiles_customer_unchanged(p_id uuid, p_customer text)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public, pg_temp
      as $q$
        select exists (
          select 1 from public.profiles where id = p_id and stripe_customer_id is not distinct from p_customer
        )
      $q$
    $f$;
  end if;
end
$$;

create or replace function public.ariyalab_profiles_customer_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.stripe_customer_id is not null
       and current_user in ('anon', 'authenticated')
       and public.ariyalab_profiles_customer_unchanged(new.id, new.stripe_customer_id) then
      return new; -- an upsert of the caller's own row, value unchanged
    end if;
    perform public.ariyalab_profiles_customer_check('INSERT', null, new.stripe_customer_id);
  else
    perform public.ariyalab_profiles_customer_check('UPDATE', old.stripe_customer_id, new.stripe_customer_id);
  end if;
  return new;
end
$$;

do $$
declare
  v_rel oid := to_regclass('public.profiles');
  v_enabled "char";
begin
  if v_rel is null or not exists (
    select 1 from pg_attribute
     where attrelid = v_rel and attname = 'stripe_customer_id' and attnum > 0 and not attisdropped
  ) then
    raise notice 'public.profiles.stripe_customer_id not found; guard not installed';
    return;
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'ariyalab_profiles_customer_guard') then
    create trigger ariyalab_profiles_customer_guard
      before insert or update on public.profiles
      for each row execute function public.ariyalab_profiles_customer_guard();
  end if;
  -- Re-applying turns a disabled guard back on (that needs the table owner).
  if exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'ariyalab_profiles_customer_guard' and tgenabled = 'D') then
    alter table public.profiles enable trigger ariyalab_profiles_customer_guard;
  end if;

  -- Hard check: the trigger exists and fires for ordinary sessions.
  select tgenabled into v_enabled from pg_trigger
   where tgrelid = v_rel and tgname = 'ariyalab_profiles_customer_guard';
  if v_enabled is null or v_enabled not in ('O', 'A') then
    raise exception 'ariyalab_profiles_customer_guard is missing or disabled (tgenabled=%)', v_enabled;
  end if;

  -- Self-test as authenticated, where the applying role may become it.
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    begin
      execute 'set local role authenticated';
    exception when insufficient_privilege then
      raise notice 'self-test as authenticated skipped: this role cannot SET ROLE authenticated';
      return;
    end;
    begin
      perform public.ariyalab_profiles_customer_check('UPDATE', 'cus_self_test_a', 'cus_self_test_b');
      raise exception 'self-test failed: authenticated could change stripe_customer_id';
    exception when insufficient_privilege then
      null; -- refused, as it must be
    end;
    begin
      perform public.ariyalab_profiles_customer_check('UPDATE', 'cus_same', 'cus_same');
    exception when insufficient_privilege then
      raise exception 'self-test failed: an unchanged stripe_customer_id was refused';
    end;
    execute 'reset role';
  end if;
end
$$;
