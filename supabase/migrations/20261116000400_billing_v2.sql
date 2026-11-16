-- Task 27 (billing v2 plans, yearly grants, billing hardening). Applies after 20261116000300_story_assets.sql.
-- Additive: one new credit_ table, one new function, and a replacement body for credit_charge_closed_hold
-- (same signature, same privileges). Touches no shared (haelabs) table.
--
-- credit_yearly_subs: one row per yearly billing-v2 subscription (lib/grants.js). Written when its invoice is paid
--   and on customer.subscription.* events; read by the yearly cron (pages/api/cron/grant-yearly.js), which grants
--   months 1..11 of the current period under ref yearly:<sub_id>:<YYYY-MM>. Month 0 is the invoice's own grant.
--   status: the Stripe subscription status, or 'canceled' (deleted), 'refunded' (the period's invoice was refunded or
--   disputed: no more months), 'switched' (moved to a monthly price).
--
-- credit_yearly_record(sub, customer, plan, credits, period_start, period_end, status): upsert. The period and plan
--   move only forward (an older event never rewinds them); a 'refunded' period stays refunded until a new period.
--
-- credit_charge_closed_hold: now returns at once (charging nothing) when, under the account lock, the hold already
--   has a settle or spend row: closes the race where a late success and the reconciler both charge a closed hold.

create table public.credit_yearly_subs (
  sub_id text primary key,
  customer_id text not null,
  plan text not null,
  credits integer not null check (credits > 0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index credit_yearly_subs_due_idx on public.credit_yearly_subs (last_run_at nulls first, sub_id)
  where status in ('active', 'trialing');

alter table public.credit_yearly_subs enable row level security;

create function public.credit_yearly_record(
  p_sub text, p_customer text, p_plan text, p_credits integer,
  p_period_start timestamptz, p_period_end timestamptz, p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into credit_yearly_subs as y (sub_id, customer_id, plan, credits, period_start, period_end, status)
  values (p_sub, p_customer, p_plan, p_credits, p_period_start, p_period_end, p_status)
  on conflict (sub_id) do update
    set plan = case when excluded.period_start >= y.period_start then excluded.plan else y.plan end,
        credits = case when excluded.period_start >= y.period_start then excluded.credits else y.credits end,
        customer_id = excluded.customer_id,
        period_start = greatest(y.period_start, excluded.period_start),
        period_end = case when excluded.period_start >= y.period_start then excluded.period_end else y.period_end end,
        status = case
          when y.status = 'refunded' and excluded.period_start <= y.period_start then y.status
          when excluded.period_start < y.period_start then y.status
          else excluded.status
        end,
        updated_at = now();
end
$$;

create or replace function public.credit_charge_closed_hold(
  p_hold uuid, p_user uuid, p_currency text, p_amount integer, p_reason text, p_ref text
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
  -- Under the account lock (every settle and spend of this hold takes it too): a hold that was settled, or charged
  -- directly, under any ref is never charged again. A replay of this same spend lands here as well.
  if exists (select 1 from credit_ledger where hold_id = p_hold and op in ('settle', 'spend')) then
    return credit_to_json(a);
  end if;
  r := credit_replay(p_user, p_currency, p_reason, p_ref, 'spend', p_amount, p_hold);
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
    p_reason, p_ref, null, 'spend', p_amount, p_hold
  );
end
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
        and p.proname = any (array['credit_yearly_record', 'credit_charge_closed_hold'])
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
    revoke all on table public.credit_yearly_subs from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.credit_yearly_subs from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.credit_yearly_subs from service_role;
    grant select, update on table public.credit_yearly_subs to service_role;
  end if;
end
$$;
