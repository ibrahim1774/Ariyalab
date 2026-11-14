-- Credit ledger for the story video maker (billing v2).
--
-- BEFORE APPLYING ON THE SHARED SUPABASE PROJECT, run:
--   select proname from pg_proc
--     where pronamespace = 'public'::regnamespace and proname like 'credit_%';
-- and confirm it returns nothing, and that no public.stripe_events or
-- public.pricing_config table exists yet. This migration uses plain
-- create table / create function so a clash fails instead of reusing.
--
-- Replaces the single overwritten integer in Stripe customer metadata.
-- Every balance change goes through one of the credit_* functions below,
-- which lock the account row (select ... for update) before reading it, and
-- writes an append-only credit_ledger row. Holds reserve credits for
-- in-flight work; they are not ledger rows until settled.
--
-- Shared project: this migration creates new tables and functions only. It
-- references no existing table (no FK to auth.users or profiles) and relies
-- on auth.uid() only inside RLS policies.
--
-- Error convention (lib/credits.js parses these):
--   message 'insufficient_credits', detail '{"needed": <requested amount>, "available": <available now>}'
--   message 'ref_conflict': a (reason, ref) already used by a different operation
--   other messages: invalid_amount, invalid_bucket, invalid_currency,
--   invalid_user, invalid_ref, hold_not_found, hold_closed, hold_exceeded,
--   account_lock_failed.
--
-- Balance results are jsonb: { plan, topup, held, available }, where
-- available = plan + topup - held. credit_ledger.balance_after is
-- plan + topup after the change.
--
-- Idempotency: each operation is keyed on (user, currency, reason, ref).
-- A replay of the same operation returns without changing anything; a
-- different operation under an already used (reason, ref) raises ref_conflict.

-- ---------------------------------------------------------------- tables

create table public.credit_accounts (
  user_id uuid not null,
  currency text not null check (currency in ('video', 'image')),
  plan_balance integer not null default 0 check (plan_balance >= 0),
  topup_balance integer not null default 0 check (topup_balance >= 0),
  held integer not null default 0 check (held >= 0),
  -- Clawback that could not be taken because the credits were on hold.
  -- Collected when those credits are released; written down when settled.
  clawback_owed integer not null default 0 check (clawback_owed >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, currency),
  -- Backstop for the row lock: a concurrent UPDATE re-checks this against
  -- the newest row version, so held credits can never exceed the balance.
  constraint credit_accounts_held_covered check (held <= plan_balance + topup_balance),
  constraint credit_accounts_owed_within_held check (clawback_owed <= held)
);

create table public.credit_ledger (
  id bigserial primary key,
  user_id uuid not null,
  currency text not null,
  delta integer not null,
  plan_delta integer not null default 0,
  topup_delta integer not null default 0,
  bucket text not null check (bucket in ('plan', 'topup', 'mixed')),
  reason text not null check (reason <> ''),
  ref text not null check (ref <> ''),
  -- What produced the row, the amount the caller asked for, and the hold it
  -- belongs to: compared on replay so a reused ref cannot pass as a retry.
  op text not null check (op in (
    'grant', 'renew', 'expire', 'spend', 'settle', 'release', 'clawback', 'clawback_deferred'
  )),
  amount integer not null check (amount >= 0),
  hold_id uuid,
  -- clawback only: the part of the request deferred to clawback_owed.
  deferred integer not null default 0 check (deferred >= 0),
  project_id uuid,
  balance_after integer not null check (balance_after >= 0),
  created_at timestamptz not null default now(),
  foreign key (user_id, currency) references public.credit_accounts (user_id, currency),
  constraint credit_ledger_delta_split check (delta = plan_delta + topup_delta),
  -- Partial releases are recorded for idempotency and change no balance.
  constraint credit_ledger_release_zero check (op <> 'release' or delta = 0),
  constraint credit_ledger_idempotency unique (user_id, currency, reason, ref)
);

create index credit_ledger_history_idx on public.credit_ledger (user_id, currency, created_at desc);
create index credit_ledger_project_idx on public.credit_ledger (project_id) where project_id is not null;
create index credit_ledger_hold_idx on public.credit_ledger (hold_id) where hold_id is not null;

create table public.credit_holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  currency text not null,
  amount integer not null check (amount > 0),
  remaining integer not null check (remaining >= 0 and remaining <= amount),
  project_id uuid,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (user_id, currency) references public.credit_accounts (user_id, currency),
  constraint credit_holds_closed_when_empty check ((status = 'closed') = (remaining = 0))
);

create index credit_holds_active_idx on public.credit_holds (user_id, currency) where status = 'active';
create index credit_holds_project_idx on public.credit_holds (project_id) where project_id is not null;

-- Grants for a Stripe customer not yet linked to a user. Claimed once by
-- credit_claim_pending when the customer is linked.
create table public.credit_pending_grants (
  id bigserial primary key,
  stripe_customer_id text not null,
  currency text not null default 'video' check (currency in ('video', 'image')),
  amount integer not null check (amount > 0),
  bucket text not null check (bucket in ('plan', 'topup')),
  reason text not null check (reason <> ''),
  ref text not null check (ref <> ''),
  claimed_by uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint credit_pending_grants_idempotency unique (reason, ref)
);

create index credit_pending_grants_unclaimed_idx
  on public.credit_pending_grants (stripe_customer_id) where claimed_by is null;

-- Stripe webhook / object ids already processed (dedupe).
create table public.stripe_events (
  id text primary key,
  received_at timestamptz not null default now()
);

-- Admin-editable pricing overrides, merged over lib/pricing.js defaults.
create table public.pricing_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS

alter table public.credit_accounts enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.credit_holds enable row level security;
alter table public.credit_pending_grants enable row level security;
alter table public.stripe_events enable row level security;
alter table public.pricing_config enable row level security;

-- Owners may read their own rows. No client write policies exist, and the
-- last three tables have no policies at all (server only).
create policy credit_accounts_owner_select on public.credit_accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy credit_ledger_owner_select on public.credit_ledger
  for select to authenticated using (user_id = (select auth.uid()));
create policy credit_holds_owner_select on public.credit_holds
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- internal helpers

create function public.credit_to_json(a public.credit_accounts)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'plan', a.plan_balance,
    'topup', a.topup_balance,
    'held', a.held,
    'available', a.plan_balance + a.topup_balance - a.held
  )
$$;

create function public.credit_check_args(p_amount integer, p_reason text, p_ref text)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  if coalesce(p_reason, '') = '' or coalesce(p_ref, '') = '' then
    raise exception 'invalid_ref';
  end if;
end
$$;

-- Creates the account row if missing and returns it locked for update.
create function public.credit_lock_account(p_user uuid, p_currency text)
returns public.credit_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
begin
  if p_user is null then
    raise exception 'invalid_user';
  end if;
  if p_currency is null or p_currency not in ('video', 'image') then
    raise exception 'invalid_currency';
  end if;
  insert into credit_accounts (user_id, currency) values (p_user, p_currency)
    on conflict do nothing;
  select * into a from credit_accounts
    where user_id = p_user and currency = p_currency
    for update;
  if not found then
    raise exception 'account_lock_failed';
  end if;
  return a;
end
$$;

-- Idempotency check, called with the account locked. Returns the existing
-- ledger row for (user, currency, reason, ref), or null when there is none.
-- Raises ref_conflict when that row was written by a different operation:
-- another op, another hold, or (when p_match_amount) another amount.
create function public.credit_replay(
  p_user uuid, p_currency text, p_reason text, p_ref text,
  p_op text, p_amount integer, p_hold uuid, p_match_amount boolean default true
)
returns public.credit_ledger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r credit_ledger;
begin
  select * into r from credit_ledger
    where user_id = p_user and currency = p_currency and reason = p_reason and ref = p_ref;
  if not found then
    return null;
  end if;
  if r.op <> p_op
     or r.hold_id is distinct from p_hold
     or (p_match_amount and r.amount <> p_amount) then
    raise exception 'ref_conflict'
      using detail = jsonb_build_object('reason', p_reason, 'ref', p_ref, 'existing_op', r.op)::text;
  end if;
  return r;
end
$$;

-- Applies a change to a locked account and records it. Callers must hold
-- the account lock and have checked idempotency.
create function public.credit_apply(
  p_user uuid, p_currency text,
  p_plan_delta integer, p_topup_delta integer, p_held_delta integer,
  p_reason text, p_ref text, p_project uuid,
  p_op text, p_amount integer, p_hold uuid default null, p_deferred integer default 0,
  p_owed_delta integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
begin
  update credit_accounts
    set plan_balance = plan_balance + p_plan_delta,
        topup_balance = topup_balance + p_topup_delta,
        held = held + p_held_delta,
        clawback_owed = clawback_owed + p_owed_delta,
        updated_at = now()
    where user_id = p_user and currency = p_currency
    returning * into a;

  insert into credit_ledger (
    user_id, currency, delta, plan_delta, topup_delta, bucket, reason, ref,
    op, amount, hold_id, deferred, project_id, balance_after
  ) values (
    p_user, p_currency, p_plan_delta + p_topup_delta, p_plan_delta, p_topup_delta,
    case
      when p_plan_delta <> 0 and p_topup_delta <> 0 then 'mixed'
      when p_topup_delta <> 0 then 'topup'
      else 'plan'
    end,
    p_reason, p_ref, p_op, p_amount, p_hold, p_deferred, p_project, a.plan_balance + a.topup_balance
  );

  return credit_to_json(a);
end
$$;

create function public.credit_raise_insufficient(p_needed integer, p_available integer)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'insufficient_credits'
    using detail = jsonb_build_object('needed', p_needed, 'available', p_available)::text;
end
$$;

-- Removes credits from a hold (settle or release) on a locked account and
-- adjusts clawback_owed. Returns the account after the change.
create function public.credit_take_from_hold(
  p_hold uuid, p_amount integer, p_settled boolean, a public.credit_accounts
)
returns public.credit_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owed_after integer;
begin
  update credit_holds
    set remaining = remaining - p_amount,
        status = case when remaining - p_amount = 0 then 'closed' else 'active' end,
        closed_at = case when remaining - p_amount = 0 then now() else null end
    where id = p_hold;
  -- Settled credits are consumed, so any debt beyond the new held is written
  -- down. Released credits pay the debt (by the caller) up to the amount released.
  if p_settled then
    v_owed_after := least(a.clawback_owed, a.held - p_amount);
  else
    v_owed_after := a.clawback_owed - least(a.clawback_owed, p_amount);
  end if;
  update credit_accounts
    set held = held - p_amount, clawback_owed = v_owed_after, updated_at = now()
    where user_id = a.user_id and currency = a.currency
    returning * into a;
  return a;
end
$$;

-- ---------------------------------------------------------------- public API (service role only)

-- getBalance: reads without locking; zeros when the account does not exist.
create function public.credit_balance(p_user uuid, p_currency text default 'video')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
begin
  if p_currency is null or p_currency not in ('video', 'image') then
    raise exception 'invalid_currency';
  end if;
  select * into a from credit_accounts where user_id = p_user and currency = p_currency;
  if not found then
    return jsonb_build_object('plan', 0, 'topup', 0, 'held', 0, 'available', 0);
  end if;
  return credit_to_json(a);
end
$$;

-- grantCredits: idempotent on (user, currency, reason, ref).
create function public.credit_grant(
  p_user uuid, p_currency text, p_amount integer, p_bucket text, p_reason text, p_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  r credit_ledger;
begin
  perform credit_check_args(p_amount, p_reason, p_ref);
  if p_bucket is null or p_bucket not in ('plan', 'topup') then
    raise exception 'invalid_bucket';
  end if;
  a := credit_lock_account(p_user, p_currency);
  r := credit_replay(p_user, p_currency, p_reason, p_ref, 'grant', p_amount, null);
  if r.id is not null then
    if r.bucket <> p_bucket then
      raise exception 'ref_conflict'
        using detail = jsonb_build_object('reason', p_reason, 'ref', p_ref, 'existing_op', r.op)::text;
    end if;
    return credit_to_json(a);
  end if;
  return credit_apply(
    p_user, p_currency,
    case when p_bucket = 'plan' then p_amount else 0 end,
    case when p_bucket = 'topup' then p_amount else 0 end,
    0, p_reason, p_ref, null, 'grant', p_amount
  );
end
$$;

-- renewPlanCredits: plan = min(plan, allotment) + allotment, idempotent on ref.
-- The allotment is granted first (reason 'plan_renewal'), then plan credits
-- above the target expire (reason 'plan_expiry', same ref). Expiry never
-- takes plan + topup below what is held.
create function public.credit_renew_plan(
  p_user uuid, p_allotment integer, p_ref text, p_currency text default 'video'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  r credit_ledger;
  v_target integer;
  v_result jsonb;
begin
  perform credit_check_args(p_allotment, 'plan_renewal', p_ref);
  a := credit_lock_account(p_user, p_currency);
  r := credit_replay(p_user, p_currency, 'plan_renewal', p_ref, 'renew', p_allotment, null);
  if r.id is not null then
    return credit_to_json(a);
  end if;
  v_target := greatest(least(a.plan_balance, p_allotment) + p_allotment, a.held - a.topup_balance);
  v_result := credit_apply(p_user, p_currency, p_allotment, 0, 0, 'plan_renewal', p_ref, null, 'renew', p_allotment);
  if a.plan_balance + p_allotment > v_target then
    v_result := credit_apply(
      p_user, p_currency, v_target - (a.plan_balance + p_allotment), 0, 0,
      'plan_expiry', p_ref, null, 'expire', a.plan_balance + p_allotment - v_target
    );
  end if;
  return v_result;
end
$$;

-- spendCredits: plan first, then topup; idempotent on (reason, ref).
create function public.credit_spend(
  p_user uuid, p_currency text, p_amount integer, p_reason text, p_ref text, p_project uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  r credit_ledger;
  v_available integer;
  v_from_plan integer;
begin
  perform credit_check_args(p_amount, p_reason, p_ref);
  a := credit_lock_account(p_user, p_currency);
  r := credit_replay(p_user, p_currency, p_reason, p_ref, 'spend', p_amount, null);
  if r.id is not null then
    return credit_to_json(a);
  end if;
  v_available := a.plan_balance + a.topup_balance - a.held;
  if p_amount > v_available then
    perform credit_raise_insufficient(p_amount, v_available);
  end if;
  v_from_plan := least(a.plan_balance, p_amount);
  return credit_apply(
    p_user, p_currency, -v_from_plan, -(p_amount - v_from_plan), 0,
    p_reason, p_ref, p_project, 'spend', p_amount
  );
end
$$;

-- holdCredits: reserves credits (reduces available, not plan); returns hold id.
-- p_hold_id is an optional caller-chosen id that makes the call retry-safe:
-- if that hold already exists for this user and currency it is returned as is.
create function public.credit_hold(
  p_user uuid, p_currency text, p_amount integer, p_project uuid, p_hold_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  h credit_holds;
  v_available integer;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  a := credit_lock_account(p_user, p_currency);
  if p_hold_id is not null then
    select * into h from credit_holds where id = p_hold_id;
    if found then
      if h.user_id <> p_user or h.currency <> p_currency or h.amount <> p_amount
         or h.project_id is distinct from p_project then
        raise exception 'ref_conflict'
          using detail = jsonb_build_object('hold_id', p_hold_id)::text;
      end if;
      return h.id;
    end if;
  end if;
  v_available := a.plan_balance + a.topup_balance - a.held;
  if p_amount > v_available then
    perform credit_raise_insufficient(p_amount, v_available);
  end if;
  update credit_accounts
    set held = held + p_amount, updated_at = now()
    where user_id = p_user and currency = p_currency;
  insert into credit_holds (id, user_id, currency, amount, remaining, project_id)
    values (coalesce(p_hold_id, gen_random_uuid()), p_user, p_currency, p_amount, p_amount, p_project)
    returning id into v_id;
  return v_id;
end
$$;

-- settleHold: moves amount from the hold to spent (plan first, then topup).
-- Idempotent on (reason, ref) for the same hold and amount: a retry returns
-- the balance even after the hold has closed. Lock order is account row,
-- then hold row.
create function public.credit_settle(p_hold uuid, p_amount integer, p_reason text, p_ref text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  h credit_holds;
  r credit_ledger;
  v_user uuid;
  v_currency text;
  v_from_plan integer;
begin
  perform credit_check_args(p_amount, p_reason, p_ref);
  select user_id, currency into v_user, v_currency from credit_holds where id = p_hold;
  if not found then
    raise exception 'hold_not_found';
  end if;
  a := credit_lock_account(v_user, v_currency);
  r := credit_replay(v_user, v_currency, p_reason, p_ref, 'settle', p_amount, p_hold);
  if r.id is not null then
    return credit_to_json(a);
  end if;
  select * into h from credit_holds where id = p_hold for update;
  if h.status = 'closed' then
    raise exception 'hold_closed';
  end if;
  if p_amount > h.remaining then
    raise exception 'hold_exceeded'
      using detail = jsonb_build_object('requested', p_amount, 'remaining', h.remaining)::text;
  end if;
  a := credit_take_from_hold(p_hold, p_amount, true, a);
  v_from_plan := least(a.plan_balance, p_amount);
  return credit_apply(
    v_user, v_currency, -v_from_plan, -(p_amount - v_from_plan), 0,
    p_reason, p_ref, h.project_id, 'settle', p_amount, p_hold
  );
end
$$;

-- releaseHold: returns held credits to available.
--   p_amount null: release the rest (a no-op on a closed hold).
--   p_amount given: partial release; p_ref is required and the call is
--   idempotent on (hold, ref). It is recorded as a zero-delta ledger row
--   (reason 'hold_release', ref '<hold id>:<p_ref>').
-- Any clawback_owed is collected from the released credits (reason
-- 'clawback_deferred', ref '<hold id>:<remaining before release>').
create function public.credit_release(p_hold uuid, p_amount integer default null, p_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  h credit_holds;
  r credit_ledger;
  v_user uuid;
  v_currency text;
  v_amount integer;
  v_collect integer;
  v_from_plan integer;
  v_release_ref text;
begin
  if p_amount is not null then
    perform credit_check_args(p_amount, 'hold_release', p_ref);
  end if;
  select user_id, currency into v_user, v_currency from credit_holds where id = p_hold;
  if not found then
    raise exception 'hold_not_found';
  end if;
  a := credit_lock_account(v_user, v_currency);
  if p_amount is not null then
    v_release_ref := p_hold::text || ':' || p_ref;
    r := credit_replay(v_user, v_currency, 'hold_release', v_release_ref, 'release', p_amount, p_hold);
    if r.id is not null then
      return credit_to_json(a);
    end if;
  end if;
  select * into h from credit_holds where id = p_hold for update;
  if p_amount is null then
    v_amount := h.remaining;
    if v_amount = 0 then
      return credit_to_json(a);
    end if;
  else
    if h.status = 'closed' then
      raise exception 'hold_closed';
    end if;
    if p_amount > h.remaining then
      raise exception 'hold_exceeded'
        using detail = jsonb_build_object('requested', p_amount, 'remaining', h.remaining)::text;
    end if;
    v_amount := p_amount;
  end if;

  v_collect := least(a.clawback_owed, v_amount);
  a := credit_take_from_hold(p_hold, v_amount, false, a);

  if p_amount is not null then
    perform credit_apply(
      v_user, v_currency, 0, 0, 0, 'hold_release', v_release_ref, h.project_id, 'release', v_amount, p_hold
    );
  end if;

  if v_collect > 0 then
    v_from_plan := least(a.plan_balance, v_collect);
    perform credit_apply(
      v_user, v_currency, -v_from_plan, -(v_collect - v_from_plan), 0,
      'clawback_deferred', p_hold::text || ':' || h.remaining, h.project_id,
      'clawback_deferred', v_collect, p_hold
    );
  end if;

  select * into a from credit_accounts where user_id = v_user and currency = v_currency;
  return credit_to_json(a);
end
$$;

-- clawback (refunds, disputes): takes up to p_amount from what is available,
-- never below 0. The part that is on hold is added to clawback_owed and
-- collected when those credits are released. p_first_bucket picks which
-- bucket is taken first (default plan). Idempotent on (reason, ref); a
-- replay returns the same taken/owed. Result: balance plus
--   taken: credits removed now, owed: credits deferred to clawback_owed.
-- p_amount - taken - owed is uncollectable (the user had nothing left).
create function public.credit_clawback(
  p_user uuid, p_currency text, p_amount integer, p_reason text, p_ref text,
  p_first_bucket text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  r credit_ledger;
  v_take integer;
  v_owe integer;
  v_plan integer;
  v_topup integer;
begin
  perform credit_check_args(p_amount, p_reason, p_ref);
  if p_first_bucket is not null and p_first_bucket not in ('plan', 'topup') then
    raise exception 'invalid_bucket';
  end if;
  a := credit_lock_account(p_user, p_currency);
  r := credit_replay(p_user, p_currency, p_reason, p_ref, 'clawback', p_amount, null, false);
  if r.id is not null then
    return credit_to_json(a) || jsonb_build_object('taken', -r.delta, 'owed', r.deferred);
  end if;
  v_take := greatest(0, least(p_amount, a.plan_balance + a.topup_balance - a.held));
  v_owe := least(p_amount - v_take, a.held - a.clawback_owed);
  if p_first_bucket = 'topup' then
    v_topup := least(a.topup_balance, v_take);
    v_plan := v_take - v_topup;
  else
    v_plan := least(a.plan_balance, v_take);
    v_topup := v_take - v_plan;
  end if;
  return credit_apply(
    p_user, p_currency, -v_plan, -v_topup, 0, p_reason, p_ref, null,
    'clawback', p_amount, null, v_owe, v_owe
  ) || jsonb_build_object('taken', v_take, 'owed', v_owe);
end
$$;

-- Grants every unclaimed pending grant for a Stripe customer to p_user,
-- once. Returns how many were claimed.
create function public.credit_claim_pending(p_customer text, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r credit_pending_grants;
  v_count integer := 0;
begin
  if p_user is null then
    raise exception 'invalid_user';
  end if;
  for r in
    select * from credit_pending_grants
      where stripe_customer_id = p_customer and claimed_by is null
      order by id
      for update
  loop
    update credit_pending_grants set claimed_by = p_user, claimed_at = now() where id = r.id;
    perform credit_grant(p_user, r.currency, r.amount, r.bucket, r.reason, r.ref);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------- privileges

-- Functions get EXECUTE through PUBLIC by default, and Supabase's default
-- privileges also grant it to anon and authenticated. Revoke all three and
-- allow only service_role. Role statements are guarded so this runs where
-- the Supabase roles do not exist.
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
          'credit_to_json', 'credit_check_args', 'credit_lock_account', 'credit_replay',
          'credit_apply', 'credit_raise_insufficient', 'credit_take_from_hold', 'credit_balance',
          'credit_grant', 'credit_renew_plan', 'credit_spend', 'credit_hold', 'credit_settle',
          'credit_release', 'credit_clawback', 'credit_claim_pending'
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
    revoke all on table public.credit_accounts, public.credit_ledger, public.credit_holds,
      public.credit_pending_grants, public.stripe_events, public.pricing_config from anon;
    revoke all on sequence public.credit_ledger_id_seq, public.credit_pending_grants_id_seq from anon;
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.credit_accounts, public.credit_ledger, public.credit_holds,
      public.credit_pending_grants, public.stripe_events, public.pricing_config from authenticated;
    revoke all on sequence public.credit_ledger_id_seq, public.credit_pending_grants_id_seq from authenticated;
    -- Read-only, filtered to the owner's rows by the RLS policies above.
    grant select on table public.credit_accounts, public.credit_ledger, public.credit_holds to authenticated;
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Balances, ledger and holds change only through the security definer
    -- functions above, so the service role may only read them directly.
    revoke all on table public.credit_accounts, public.credit_ledger, public.credit_holds from service_role;
    revoke insert, update, delete, truncate on table
      public.credit_accounts, public.credit_ledger, public.credit_holds from service_role;
    grant select on table public.credit_accounts, public.credit_ledger, public.credit_holds to service_role;
    revoke all on sequence public.credit_ledger_id_seq from service_role;
    grant all on table public.credit_pending_grants, public.stripe_events, public.pricing_config to service_role;
    grant usage, select on sequence public.credit_pending_grants_id_seq to service_role;
  end if;
end
$$;
