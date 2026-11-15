-- Ledger support for the old tools under billing_v2 and for the one-time
-- legacy credit migration. Applies after 20261114000100 and 000150.
-- Creates three tables and nine functions; touches no shared table.
--
--   credit_legacy_holds      one row per paid job of an old tool: which hold
--                            pays for it, which provider job it waits on, and
--                            whether it still needs settling or releasing.
--                            The reconciler (pages/api/cron/legacy-holds.js)
--                            ends holds a request could not end itself.
--   credit_swap_uses         the face-swap replay guard under billing_v2 (one
--                            paid frame = at most N motion jobs), per user.
--   credit_legacy_migrations one row per Stripe customer and currency moved by
--                            scripts/migrate-legacy-credits.mjs: written in the
--                            same transaction as the grant, so a re-run never
--                            grants again whatever changed since (plan, link).
--
-- MUST be applied before the code that reads it is deployed: with it
-- missing, the old tools' legacy spend path fails closed (it checks
-- credit_legacy_migrations) and billing_v2 jobs cannot be recorded.

create table public.credit_legacy_holds (
  hold_id uuid primary key,
  user_id uuid not null,
  currency text not null check (currency in ('video', 'image')),
  amount integer not null check (amount > 0),
  route text not null check (route <> ''),
  provider text,
  job_id text,
  -- 'reserving': recorded before the ledger hold is taken (the hold may not
  -- exist yet); 'open': held, waiting on the job.
  status text not null default 'open'
    check (status in ('reserving', 'open', 'settle_retry', 'release_retry', 'settled', 'released')),
  last_error text,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credit_legacy_holds_due_idx on public.credit_legacy_holds (last_attempt_at nulls first, created_at)
  where status in ('reserving', 'open', 'settle_retry', 'release_retry');

create table public.credit_swap_uses (
  user_id uuid not null,
  frame_id text not null check (frame_id <> ''),
  swap_id text,
  count integer not null check (count > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, frame_id)
);

create table public.credit_legacy_migrations (
  customer_id text not null check (customer_id <> ''),
  currency text not null check (currency in ('video', 'image')),
  user_id uuid,
  plan integer not null check (plan >= 0),
  topup integer not null check (topup >= 0),
  parked boolean not null,
  created_at timestamptz not null default now(),
  primary key (customer_id, currency)
);

alter table public.credit_legacy_holds enable row level security;
alter table public.credit_swap_uses enable row level security;
alter table public.credit_legacy_migrations enable row level security;

-- ---------------------------------------------------------------- legacy holds

create function public.credit_legacy_hold_open(
  p_hold uuid, p_user uuid, p_currency text, p_amount integer, p_route text, p_status text default 'open'
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into credit_legacy_holds (hold_id, user_id, currency, amount, route, status)
  values (p_hold, p_user, p_currency, p_amount, p_route, p_status)
  on conflict (hold_id) do nothing;
$$;

-- A reconciler look that did not end the hold: counts it and moves the row to
-- the back of the queue (credit_legacy_holds_due orders by last_attempt_at).
create function public.credit_legacy_hold_touch(p_hold uuid, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_legacy_holds
     set attempts = attempts + 1, last_attempt_at = now(), last_error = coalesce(p_error, last_error), updated_at = now()
   where hold_id = p_hold;
$$;

-- A 'reserving' record whose ledger hold never happened.
create function public.credit_legacy_hold_forget(p_hold uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from credit_legacy_holds where hold_id = p_hold and status = 'reserving';
$$;

-- 'none' (no such ledger hold), 'active' or 'closed'.
create function public.credit_legacy_hold_ledger_state(p_hold uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select status from credit_holds where id = p_hold), 'none');
$$;

create function public.credit_legacy_hold_attach(p_hold uuid, p_provider text, p_job text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_legacy_holds
     set provider = p_provider, job_id = p_job, updated_at = now()
   where hold_id = p_hold;
$$;

-- Terminal states ('settled', 'released') are never left.
create function public.credit_legacy_hold_mark(p_hold uuid, p_status text, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_legacy_holds
     set status = p_status,
         last_error = p_error,
         attempts = attempts + case when p_status in ('settle_retry', 'release_retry') then 1 else 0 end,
         last_attempt_at = case when p_status in ('settle_retry', 'release_retry') then now() else last_attempt_at end,
         updated_at = now()
   where hold_id = p_hold and status not in ('settled', 'released');
$$;

create function public.credit_legacy_holds_due(p_older_than_minutes integer, p_limit integer)
returns setof public.credit_legacy_holds
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from credit_legacy_holds
   where status in ('reserving', 'open', 'settle_retry', 'release_retry')
     and created_at < now() - make_interval(mins => p_older_than_minutes)
   order by last_attempt_at nulls first, created_at
   limit p_limit;
$$;

-- ---------------------------------------------------------------- swap uses

create function public.credit_swap_use(p_user uuid, p_frame text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('swap_id', swap_id, 'count', count,
                            'stale', swap_id is null and updated_at < now() - interval '2 minutes')
    from credit_swap_uses where user_id = p_user and frame_id = p_frame;
$$;

-- Compare-and-set: takes use number p_expected + 1 for this frame, only when
-- the frame has exactly p_expected uses and fewer than p_max. Returns the new
-- count, or null when another call took it first or the frame is used up.
create function public.credit_claim_swap_use(p_user uuid, p_frame text, p_expected integer, p_max integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v integer;
begin
  if p_expected >= p_max then
    return null;
  end if;
  if p_expected = 0 then
    insert into credit_swap_uses (user_id, frame_id, count) values (p_user, p_frame, 1)
      on conflict do nothing
      returning count into v;
    return v;
  end if;
  update credit_swap_uses
     set count = count + 1, swap_id = null, updated_at = now()
   where user_id = p_user and frame_id = p_frame and count = p_expected
   returning count into v;
  return v;
end
$$;

-- Undoes claim number p_count when its job never started (still no job id).
create function public.credit_unclaim_swap_use(p_user uuid, p_frame text, p_count integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_count = 1 then
    delete from credit_swap_uses
     where user_id = p_user and frame_id = p_frame and count = 1 and swap_id is null;
  else
    update credit_swap_uses set count = count - 1, updated_at = now()
     where user_id = p_user and frame_id = p_frame and count = p_count and swap_id is null;
  end if;
end
$$;

create function public.credit_record_swap(p_user uuid, p_frame text, p_swap text, p_count integer)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_swap_uses set swap_id = p_swap, updated_at = now()
   where user_id = p_user and frame_id = p_frame and count = p_count;
$$;

-- ---------------------------------------------------------------- plan reset

-- Sets the plan bucket to exactly p_allotment (never below what holds need),
-- once per ref. Used for the monthly image credits, which do not roll over.
create function public.credit_reset_plan(p_user uuid, p_currency text, p_allotment integer, p_ref text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  r credit_ledger;
  v_target integer;
begin
  perform credit_check_args(p_allotment, 'plan_reset', p_ref);
  a := credit_lock_account(p_user, p_currency);
  r := credit_replay(p_user, p_currency, 'plan_reset', p_ref, 'renew', p_allotment, null);
  if r.id is not null then
    return credit_to_json(a);
  end if;
  v_target := greatest(p_allotment, a.held - a.topup_balance);
  return credit_apply(
    p_user, p_currency, v_target - a.plan_balance, 0, 0, 'plan_reset', p_ref, null, 'renew', p_allotment
  );
end
$$;

-- True when the user's video ledger has a plan renewal since p_since.
create function public.credit_has_plan_renewal_since(p_user uuid, p_since timestamptz)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from credit_ledger
     where user_id = p_user and currency = 'video' and reason = 'plan_renewal' and created_at >= p_since
  );
$$;

-- True when a plan renewal for this Stripe customer was parked since p_since
-- (claimed or not): the v2 webhook already granted that period.
create function public.credit_has_pending_renewal_since(p_customer text, p_since timestamptz)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from credit_pending_grants
     where stripe_customer_id = p_customer and currency = 'video' and reason = 'plan_renewal' and created_at >= p_since
  );
$$;

-- ---------------------------------------------------------------- migration

-- Moves one customer's legacy balance in one currency, once. The marker row
-- is inserted first; on conflict nothing is granted and the first run's
-- record is returned ('already'). Otherwise the grants (linked user) or the
-- pending rows (no user) follow in the same transaction: any error rolls the
-- marker back with them.
create function public.credit_migrate_legacy(
  p_customer text, p_currency text, p_user uuid, p_plan integer, p_topup integer, p_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m credit_legacy_migrations;
  v_plan_reason text := case when p_currency = 'image' then 'legacy_migration_image_plan' else 'legacy_migration_plan' end;
  v_topup_reason text := case when p_currency = 'image' then 'legacy_migration_image_topup' else 'legacy_migration_topup' end;
begin
  if p_plan is null or p_topup is null or p_plan < 0 or p_topup < 0 or p_plan + p_topup <= 0 then
    raise exception 'invalid_amount';
  end if;
  if coalesce(p_customer, '') = '' or coalesce(p_ref, '') = '' then
    raise exception 'invalid_ref';
  end if;
  insert into credit_legacy_migrations (customer_id, currency, user_id, plan, topup, parked)
    values (p_customer, p_currency, p_user, p_plan, p_topup, p_user is null)
    on conflict do nothing
    returning * into m;
  if m.customer_id is null then
    select * into m from credit_legacy_migrations where customer_id = p_customer and currency = p_currency;
    return jsonb_build_object('status', 'already', 'user_id', m.user_id, 'plan', m.plan,
                              'topup', m.topup, 'parked', m.parked);
  end if;
  if p_user is not null then
    if p_plan > 0 then perform credit_grant(p_user, p_currency, p_plan, 'plan', v_plan_reason, p_ref); end if;
    if p_topup > 0 then perform credit_grant(p_user, p_currency, p_topup, 'topup', v_topup_reason, p_ref); end if;
    return jsonb_build_object('status', 'migrated', 'user_id', p_user, 'plan', p_plan, 'topup', p_topup, 'parked', false);
  end if;
  if p_plan > 0 then
    insert into credit_pending_grants (stripe_customer_id, currency, amount, original_amount, bucket, reason, ref)
      values (p_customer, p_currency, p_plan, p_plan, 'plan', v_plan_reason, p_ref)
      on conflict (reason, ref) do nothing;
  end if;
  if p_topup > 0 then
    insert into credit_pending_grants (stripe_customer_id, currency, amount, original_amount, bucket, reason, ref)
      values (p_customer, p_currency, p_topup, p_topup, 'topup', v_topup_reason, p_ref)
      on conflict (reason, ref) do nothing;
  end if;
  return jsonb_build_object('status', 'parked', 'user_id', null, 'plan', p_plan, 'topup', p_topup, 'parked', true);
end
$$;

create function public.credit_legacy_migrated(p_customer text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from credit_legacy_migrations where customer_id = p_customer);
$$;

create function public.credit_legacy_migration_of(p_customer text, p_currency text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('user_id', user_id, 'plan', plan, 'topup', topup, 'parked', parked)
    from credit_legacy_migrations where customer_id = p_customer and currency = p_currency;
$$;

-- ---------------------------------------------------------------- privileges

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any (array[
          'credit_legacy_hold_open', 'credit_legacy_hold_attach', 'credit_legacy_hold_mark',
          'credit_legacy_hold_touch', 'credit_legacy_hold_forget', 'credit_legacy_hold_ledger_state',
          'credit_unclaim_swap_use', 'credit_has_pending_renewal_since',
          'credit_legacy_holds_due', 'credit_swap_use', 'credit_claim_swap_use', 'credit_record_swap',
          'credit_reset_plan', 'credit_has_plan_renewal_since', 'credit_migrate_legacy',
          'credit_legacy_migrated', 'credit_legacy_migration_of'
        ])
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

  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.credit_legacy_holds, public.credit_swap_uses, public.credit_legacy_migrations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.credit_legacy_holds, public.credit_swap_uses, public.credit_legacy_migrations from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.credit_legacy_holds, public.credit_swap_uses, public.credit_legacy_migrations from service_role;
    grant select on table public.credit_legacy_holds, public.credit_swap_uses, public.credit_legacy_migrations to service_role;
  end if;
end
$$;
