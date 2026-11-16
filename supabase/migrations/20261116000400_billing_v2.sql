-- Task 27 (billing v2 plans, yearly grants, billing hardening). Applies after 20261116000300_story_assets.sql.
-- Additive: three new credit_ tables, one new column (credit_accounts.plan_debt), eleven new functions, and a replacement
-- body for credit_charge_closed_hold
-- (same signature, same privileges). Touches no shared (haelabs) table.
--
-- credit_yearly_subs: one row per yearly billing-v2 subscription (lib/grants.js). Written when its invoice is paid
--   and on customer.subscription.* events; read by the yearly cron (pages/api/cron/grant-yearly.js), which grants
--   months 1..11 of the current period under ref yearly:<sub_id>:<YYYY-MM>. Month 0 is the invoice's own grant.
--   credits: the monthly level the cron releases (bounded by the period's entitlement, credit_yearly_periods).
--   status: the Stripe subscription status, or 'canceled' (deleted), 'refunded' (the period's invoice was refunded or
--   disputed: no more months), 'switched' (moved to a monthly price).
--
-- credit_yearly_record(sub, customer, plan, credits, period_start, period_end, status, invoice): upsert from a PAID
--   invoice (the period's own invoice, or a monthly->yearly switch). The period, plan and the invoice that paid it
--   (period_invoice_id) move only forward; a 'refunded' period stays refunded until a new period.
-- credit_yearly_sync(sub, status, credits): customer.subscription.* events: status, and credits only LOWERED.
-- credit_yearly_raise(sub, plan, credits): a PAID change to a dearer yearly price: credits only raised.
--
-- Plan changes are credited by MONEY (lib/grants.js grantForInvoice):
-- credit_plan_lines: every priced line of ours on a paid subscription invoice (idempotent on the line). A proration
--   charge is worth floor(amount x rate), a proration credit (unused time given back) -ceil(|amount| x rate), with
--   rate = the price's credits for one period / its amount; a period line (non-proration) is the price's allotment.
--   kind 'month' (monthly v2 or legacy price: credited at once) or 'year' (a yearly v2 price: counts toward the yearly
--   period named by the line's period end, recorded even before that period's row exists, so delivery order never
--   changes a period's entitlement). starts_at: the line's period start for unused time given back on a yearly period
--   (an invoice with only such lines on a period left it then).
-- credit_yearly_periods: one row per yearly period of a v2 subscription, keyed by (sub_id, period_end). What the
--   period may give (its entitlement) is the sum of its year lines less the refunded share of each invoice's part;
--   the cron releases it month by month and never past it, and anything given above it is clawed back at once.
-- credit_period_state(user, customer, refs, prefix): what a period gave so far (its month refs, plus refs under
--   <prefix>: for catch-ups and clawbacks; parked grants count too).
-- credit_accounts.plan_debt (new column): what a plan change's clawback could not take because the credits were
--   already spent (money for that time went back to the customer's balance). credit_plan_clawback records it;
--   credit_collect_plan_debt takes it from the next plan grants (ref <grant ref>:debt, reason plan_debt). Only reason
--   plan_change can create debt (credit_plan_clawback refuses any other); refund, dispute and the cron's settlement
--   (plan_adjustment) clawbacks never do.
-- credit_renew_plan_capped(user, allotment, ref, cap): a monthly allotment paid by an invoice that also moves between
--   plans, with the rollover cap at the largest of the invoice's monthly levels.
-- credit_period_apply(...): one grant or clawback for a period under a per-period advisory lock, applied only when
--   the period still stands at the total the caller computed from (else 'stale': re-read and retry), so the cron, a
--   webhook and a retry of either can never both act on the same state.

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
  period_invoice_id text,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index credit_yearly_subs_due_idx on public.credit_yearly_subs (last_run_at nulls first, sub_id)
  where status in ('active', 'trialing');

alter table public.credit_yearly_subs enable row level security;

create function public.credit_yearly_record(
  p_sub text, p_customer text, p_plan text, p_credits integer,
  p_period_start timestamptz, p_period_end timestamptz, p_status text, p_invoice text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into credit_yearly_subs as y (sub_id, customer_id, plan, credits, period_start, period_end, status, period_invoice_id)
  values (p_sub, p_customer, p_plan, p_credits, p_period_start, p_period_end, p_status, p_invoice)
  on conflict (sub_id) do update
    set period_invoice_id = case when excluded.period_start >= y.period_start
                                 then coalesce(excluded.period_invoice_id, y.period_invoice_id) else y.period_invoice_id end,
        plan = case when excluded.period_start >= y.period_start then excluded.plan else y.plan end,
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

create function public.credit_yearly_sync(p_sub text, p_status text, p_credits integer default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_yearly_subs
     set status = case when status = 'refunded' then status else p_status end,
         credits = case when p_credits is null then credits else least(credits, p_credits) end,
         updated_at = now()
   where sub_id = p_sub;
$$;

create function public.credit_yearly_raise(p_sub text, p_plan text, p_credits integer)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_yearly_subs set plan = p_plan, credits = greatest(credits, p_credits), updated_at = now()
   where sub_id = p_sub;
$$;

create table public.credit_yearly_periods (
  sub_id text not null,
  period_end timestamptz not null,
  period_start timestamptz not null,
  customer_id text not null,
  invoice_id text not null,
  month0_ref text not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (sub_id, period_end)
);

create index credit_yearly_periods_invoice_idx on public.credit_yearly_periods (invoice_id);

alter table public.credit_yearly_periods enable row level security;

create table public.credit_plan_lines (
  line_key text primary key,
  invoice_id text not null,
  sub_id text not null,
  kind text not null check (kind in ('month', 'year')),
  period_end timestamptz,
  amount_cents integer not null,
  credits integer not null,
  starts_at timestamptz,
  created_at timestamptz not null default now(),
  check (kind = 'month' or period_end is not null)
);

create index credit_plan_lines_invoice_idx on public.credit_plan_lines (invoice_id);
create index credit_plan_lines_period_idx on public.credit_plan_lines (sub_id, period_end) where kind = 'year';

alter table public.credit_plan_lines enable row level security;

create function public.credit_yearly_period_record(
  p_sub text, p_end timestamptz, p_start timestamptz, p_customer text, p_invoice text, p_month0_ref text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into credit_yearly_periods (sub_id, period_end, period_start, customer_id, invoice_id, month0_ref)
  values (p_sub, p_end, p_start, p_customer, p_invoice, p_month0_ref)
  on conflict (sub_id, period_end) do nothing;
$$;

-- A period left before its end (switched to monthly, or to a new yearly period): no month starting after p_at.
create function public.credit_yearly_period_end(p_sub text, p_end timestamptz, p_at timestamptz)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update credit_yearly_periods set ended_at = least(coalesce(ended_at, p_at), p_at)
   where sub_id = p_sub and period_end = p_end;
$$;

create function public.credit_plan_line_record(
  p_key text, p_invoice text, p_sub text, p_kind text, p_period_end timestamptz, p_amount integer, p_credits integer,
  p_starts_at timestamptz default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into credit_plan_lines (line_key, invoice_id, sub_id, kind, period_end, amount_cents, credits, starts_at)
  values (p_key, p_invoice, p_sub, p_kind, p_period_end, p_amount, p_credits, p_starts_at)
  on conflict (line_key) do nothing;
$$;

-- A monthly allotment paid by an invoice that also moves between plans: granted like credit_renew_plan, but the
-- rollover cap is p_cap (the largest monthly level among the invoice's plans) instead of the new allotment, so the
-- switch never expires the old plan's credits for the time just used. The rollover rule applies again at the next
-- renewal.
create function public.credit_renew_plan_capped(p_user uuid, p_allotment integer, p_ref text, p_cap integer)
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
  a := credit_lock_account(p_user, 'video');
  r := credit_replay(p_user, 'video', 'plan_renewal', p_ref, 'renew', p_allotment, null);
  if r.id is not null then
    return credit_to_json(a);
  end if;
  v_target := greatest(least(a.plan_balance, greatest(coalesce(p_cap, p_allotment), p_allotment)) + p_allotment,
                       a.held - a.topup_balance);
  v_result := credit_apply(p_user, 'video', p_allotment, 0, 0, 'plan_renewal', p_ref, null, 'renew', p_allotment);
  if a.plan_balance + p_allotment > v_target then
    v_result := credit_apply(
      p_user, 'video', v_target - (a.plan_balance + p_allotment), 0, 0,
      'plan_expiry', p_ref, null, 'expire', a.plan_balance + p_allotment - v_target
    );
  end if;
  return v_result;
end
$$;

alter table public.credit_accounts add column plan_debt integer not null default 0 check (plan_debt >= 0);

-- A plan change's clawback (reason plan_change): what it cannot take now (spent, not on hold) becomes plan_debt.
-- A replay of the same ref adds nothing. Any other reason is refused: only the clawback of a plan-change invoice's own
-- unused-time lines may create debt (a refund, a dispute or the cron's settlement takes what is there and owes nothing).
create function public.credit_plan_clawback(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  r jsonb;
  v_lost integer;
begin
  if p_reason is distinct from 'plan_change' then
    raise exception 'plan_debt_reason';
  end if;
  a := credit_lock_account(p_user, 'video');
  if exists (select 1 from credit_ledger
              where user_id = p_user and currency = 'video' and reason = p_reason and ref = p_ref) then
    return credit_clawback(p_user, 'video', p_amount, p_reason, p_ref, 'plan') || jsonb_build_object('debt', 0);
  end if;
  r := credit_clawback(p_user, 'video', p_amount, p_reason, p_ref, 'plan');
  v_lost := p_amount - coalesce((r->>'taken')::integer, 0) - coalesce((r->>'owed')::integer, 0);
  if v_lost > 0 then
    update credit_accounts set plan_debt = plan_debt + v_lost, updated_at = now()
     where user_id = p_user and currency = 'video';
  end if;
  return r || jsonb_build_object('debt', greatest(v_lost, 0));
end
$$;

-- Right after a plan grant (p_ref): takes up to plan_debt from the plan credits available, once per grant
-- (ref <p_ref>:debt). Returns what it took.
create function public.credit_collect_plan_debt(p_user uuid, p_ref text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a credit_accounts;
  v integer;
  v_ref text;
begin
  if p_user is null or coalesce(p_ref, '') = '' then
    raise exception 'invalid_ref';
  end if;
  v_ref := p_ref || ':debt';
  a := credit_lock_account(p_user, 'video');
  if a.plan_debt <= 0 then
    return 0;
  end if;
  if exists (select 1 from credit_ledger
              where user_id = p_user and currency = 'video' and reason = 'plan_debt' and ref = v_ref) then
    return 0;
  end if;
  v := least(a.plan_debt, a.plan_balance, greatest(0, a.plan_balance + a.topup_balance - a.held));
  if v <= 0 then
    return 0;
  end if;
  perform credit_clawback(p_user, 'video', v, 'plan_debt', v_ref, 'plan');
  update credit_accounts set plan_debt = plan_debt - v, updated_at = now()
   where user_id = p_user and currency = 'video';
  return v;
end
$$;

create function public.credit_period_state(p_user uuid, p_customer text, p_refs text[], p_prefix text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_granted integer;
  v_present text[];
  v_claws integer;
  v_ups integer;
  v_parked integer;
  v_parked_refs text[];
  v_parked_ups integer;
begin
  select coalesce(sum(case when op = 'clawback' then -amount else amount end), 0)::integer,
         coalesce(array_agg(distinct ref) filter (where op <> 'clawback' and ref = any(p_refs)), '{}'),
         (count(*) filter (where op = 'clawback'))::integer,
         (count(*) filter (where op <> 'clawback' and left(ref, length(p_prefix) + 4) = p_prefix || ':up:'))::integer
    into v_granted, v_present, v_claws, v_ups
    from credit_ledger
   where p_user is not null and user_id = p_user and currency = 'video'
     and ((op in ('grant', 'renew') and reason in ('plan_renewal', 'plan_upgrade')
           and (ref = any(p_refs) or left(ref, length(p_prefix) + 1) = p_prefix || ':'))
       or (op = 'clawback' and reason <> 'plan_debt' and left(ref, length(p_prefix) + 1) = p_prefix || ':'));
  select coalesce(sum(amount), 0)::integer,
         coalesce(array_agg(ref) filter (where ref = any(p_refs)), '{}'),
         (count(*) filter (where left(ref, length(p_prefix) + 4) = p_prefix || ':up:'))::integer
    into v_parked, v_parked_refs, v_parked_ups
    from credit_pending_grants
   where stripe_customer_id = p_customer and claimed_by is null and reason in ('plan_renewal', 'plan_upgrade')
     and (ref = any(p_refs) or left(ref, length(p_prefix) + 1) = p_prefix || ':');
  return jsonb_build_object(
    'granted', v_granted + v_parked,
    'present', to_jsonb(v_present || v_parked_refs),
    'claws', v_claws,
    'ups', v_ups + v_parked_ups
  );
end
$$;

-- p_kind: 'claw' (ref <prefix>:claw:<n>), 'up' (a catch-up grant: p_ref <prefix>:up:<invoice> for the invoice that
-- paid it, so its refund can reverse it; else <prefix>:up:<n>) or 'month' (p_ref, one of
-- p_refs: granted like credit_renew_plan, but the rollover cap is the plan's monthly allotment p_cap, so a smaller
-- month never expires more than one month of plan credits). Returns {status: 'applied'|'stale'|'present', granted}.
create function public.credit_period_apply(
  p_user uuid, p_customer text, p_refs text[], p_prefix text, p_expect integer,
  p_kind text, p_amount integer, p_reason text, p_ref text default null, p_cap integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb;
  a credit_accounts;
  v_ref text;
  v_target integer;
  v_granted integer;
begin
  if p_user is null or p_amount is null or p_amount <= 0 or coalesce(p_prefix, '') = ''
     or p_kind is null or p_kind not in ('claw', 'up', 'month') then
    raise exception 'invalid_period_apply';
  end if;
  perform pg_advisory_xact_lock(hashtext('credit_period:' || p_prefix));
  s := credit_period_state(p_user, p_customer, p_refs, p_prefix);
  v_granted := (s->>'granted')::integer;
  if p_kind = 'month' and (p_ref is null or not (p_ref = any(p_refs))) then
    raise exception 'invalid_period_apply';
  end if;
  if p_kind = 'month' and (s->'present') ? p_ref then
    return jsonb_build_object('status', 'present', 'granted', v_granted);
  end if;
  if v_granted <> p_expect then
    return jsonb_build_object('status', 'stale', 'granted', v_granted);
  end if;
  if p_kind = 'claw' then
    v_ref := p_prefix || ':claw:' || ((s->>'claws')::integer + 1);
    if p_reason = 'plan_change' then
      perform credit_plan_clawback(p_user, p_amount, p_reason, v_ref);
    else
      perform credit_clawback(p_user, 'video', p_amount, p_reason, v_ref, 'plan');
    end if;
    return jsonb_build_object('status', 'applied', 'granted', v_granted - p_amount, 'ref', v_ref);
  end if;
  if p_kind = 'up' then
    v_ref := coalesce(p_ref, p_prefix || ':up:' || ((s->>'ups')::integer + 1));
    if left(v_ref, length(p_prefix) + 4) <> p_prefix || ':up:' then
      raise exception 'invalid_period_apply';
    end if;
    if exists (select 1 from credit_ledger
                where user_id = p_user and currency = 'video' and reason = 'plan_upgrade' and ref = v_ref) then
      return jsonb_build_object('status', 'present', 'granted', v_granted);
    end if;
    perform credit_grant(p_user, 'video', p_amount, 'plan', 'plan_upgrade', v_ref);
    perform credit_collect_plan_debt(p_user, v_ref);
    return jsonb_build_object('status', 'applied', 'granted', v_granted + p_amount, 'ref', v_ref);
  end if;
  a := credit_lock_account(p_user, 'video');
  v_target := greatest(least(a.plan_balance, greatest(coalesce(p_cap, p_amount), p_amount)) + p_amount, a.held - a.topup_balance);
  perform credit_apply(p_user, 'video', p_amount, 0, 0, 'plan_renewal', p_ref, null, 'renew', p_amount);
  if a.plan_balance + p_amount > v_target then
    perform credit_apply(
      p_user, 'video', v_target - (a.plan_balance + p_amount), 0, 0,
      'plan_expiry', p_ref, null, 'expire', a.plan_balance + p_amount - v_target
    );
  end if;
  perform credit_collect_plan_debt(p_user, p_ref);
  return jsonb_build_object('status', 'applied', 'granted', v_granted + p_amount, 'ref', p_ref);
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
        and p.proname = any (array[
          'credit_yearly_record', 'credit_yearly_sync', 'credit_yearly_raise', 'credit_yearly_period_record',
          'credit_yearly_period_end', 'credit_plan_line_record', 'credit_period_state', 'credit_period_apply',
          'credit_plan_clawback', 'credit_collect_plan_debt', 'credit_renew_plan_capped',
          'credit_charge_closed_hold'
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
    revoke all on table public.credit_yearly_subs, public.credit_yearly_periods, public.credit_plan_lines from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.credit_yearly_subs, public.credit_yearly_periods, public.credit_plan_lines from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.credit_yearly_subs, public.credit_yearly_periods, public.credit_plan_lines from service_role;
    grant select, update on table public.credit_yearly_subs to service_role;
    grant select on table public.credit_yearly_periods, public.credit_plan_lines, public.credit_legacy_migrations to service_role;
  end if;
end
$$;
