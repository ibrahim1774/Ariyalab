-- Stripe grant bookkeeping (lib/grants.js). Applies after
-- 20261114000100_credit_ledger.sql. Creates one table (credit_reversals),
-- adds one column (credit_pending_grants.original_amount) and creates four
-- functions (credit_record_reversal, credit_link_customer,
-- credit_reverse_grant, credit_lower_pending).
-- No shared table's schema changes; credit_link_customer writes
-- profiles.stripe_customer_id, the same column the app already writes.
--
-- credit_reversals: a refund or dispute that arrived before the purchase it
-- reverses was granted (the webhook for the refund beat the grant). The grant
-- reads it and is skipped (fully reversed) or immediately clawed back by the
-- reversed share. `covered` only ever grows (cumulative money returned, in
-- the charge's minor units, out of `total`). `reason` / `ref` name the
-- clawback that applies it, so a later redelivery of the same refund or
-- dispute is a no-op.

create table public.credit_reversals (
  source_ref text primary key check (source_ref <> ''),
  covered integer not null check (covered >= 0),
  total integer not null check (total > 0),
  reason text not null check (reason in ('stripe_refund', 'stripe_dispute')),
  ref text not null check (ref <> ''),
  updated_at timestamptz not null default now(),
  constraint credit_reversals_covered_within_total check (covered <= total)
);

alter table public.credit_reversals enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.credit_reversals from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.credit_reversals from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.credit_reversals to service_role;
  end if;
end
$$;

-- Records money returned before the grant in one statement. `covered` only
-- ever rises (a smaller or equal value is ignored).
create function public.credit_record_reversal(
  p_source text, p_covered integer, p_total integer, p_reason text, p_ref text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into credit_reversals (source_ref, covered, total, reason, ref)
  values (p_source, p_covered, p_total, p_reason, p_ref)
  on conflict (source_ref) do update
    set covered = excluded.covered, total = excluded.total, reason = excluded.reason,
        ref = excluded.ref, updated_at = now()
    where credit_reversals.covered < excluded.covered;
$$;

-- Links a Stripe customer to a user's profile, keeping customer -> user
-- one-to-one. Serialized per customer and per user with transaction-scoped
-- advisory locks (customer first, then user), so two users linking the same
-- customer, or two customers being linked to one user, cannot both win.
-- Replacing an existing, different link is a compare-and-swap: it needs
-- p_allow_replace AND p_expected_old equal to the customer the profile
-- points at now (the one the caller checked and moved state away from).
-- Returns:
--   'linked'            the profile now points at p_customer
--   'linked_elsewhere'  another profile holds p_customer (nothing written)
--   'user_has_other'    the profile points at a different customer and
--                       p_allow_replace is false (nothing written)
--   'conflict'          a replacement was allowed, but the profile no longer
--                       points at p_expected_old (nothing written)
-- Writes the same row and column lib/entitlement.js linkStripeCustomerToProfile
-- always upserted ({ id, stripe_customer_id }); profiles' schema is unchanged.
create function public.credit_link_customer(
  p_user uuid, p_customer text, p_allow_replace boolean default false, p_expected_old text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current text;
begin
  if p_user is null or p_customer is null or p_customer = '' then
    raise exception 'invalid_link';
  end if;
  -- Always customer, then user: two links touching the same customer or the
  -- same profile are serialized, and the reads below happen inside the locks.
  perform pg_advisory_xact_lock(hashtext('stripe_customer:' || p_customer));
  perform pg_advisory_xact_lock(hashtext('stripe_user:' || p_user::text));
  if exists (select 1 from profiles where stripe_customer_id = p_customer and id <> p_user) then
    return 'linked_elsewhere';
  end if;
  select stripe_customer_id into v_current from profiles where id = p_user;
  if v_current is not null and v_current <> p_customer then
    if not p_allow_replace then
      return 'user_has_other';
    end if;
    if p_expected_old is null or v_current <> p_expected_old then
      return 'conflict';
    end if;
  end if;
  insert into profiles (id, stripe_customer_id) values (p_user, p_customer)
    on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id;
  return 'linked';
end
$$;

-- Pending grants remember what they were parked with, so a refund that
-- lowers one is always computed from the original amount.
alter table public.credit_pending_grants add column original_amount integer
  check (original_amount is null or original_amount > 0);

-- Reversal of a granted purchase (refund / dispute), computed and applied in
-- one statement under a per-source lock: target = ceil(granted * covered /
-- total) capped at granted, minus every refund/dispute clawback already
-- recorded for this source (refs '<source>:...') and minus p_already.
-- p_granted is what the purchase originally granted; p_already is the part
-- of it that never reached the ledger because a refund lowered the grant
-- while it was parked (original - claimed). Returns the amount clawed now (0
-- when nothing is due or p_ref was already applied).
create function public.credit_reverse_grant(
  p_source text, p_user uuid, p_currency text, p_granted integer,
  p_covered integer, p_total integer, p_reason text, p_ref text, p_first_bucket text,
  p_already integer default 0
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_done integer;
  v_amount integer;
begin
  if p_total is null or p_total <= 0 or p_granted is null or p_granted <= 0 then
    raise exception 'invalid_reversal';
  end if;
  perform pg_advisory_xact_lock(hashtext('credit_source:' || p_source));
  if exists (select 1 from credit_ledger
               where user_id = p_user and currency = p_currency and reason = p_reason and ref = p_ref) then
    return 0;
  end if;
  select coalesce(sum(amount), 0) into v_done from credit_ledger
    where user_id = p_user and currency = p_currency and op = 'clawback'
      and reason in ('stripe_refund', 'stripe_dispute')
      and left(ref, length(p_source) + 1) = p_source || ':';
  v_amount := least(p_granted, ceil(p_granted::numeric * least(p_covered, p_total) / p_total)::integer)
              - v_done - greatest(coalesce(p_already, 0), 0);
  if v_amount <= 0 then
    return 0;
  end if;
  perform credit_clawback(p_user, p_currency, v_amount, p_reason, p_ref, p_first_bucket);
  return v_amount;
end
$$;

-- Lowers an unclaimed pending grant to original - ceil(original * covered /
-- total), from the amount it was parked with, under the same per-source
-- lock; deletes it when nothing is left. Only ever lowers. Returns
-- 'lowered', 'claimed' (already claimed: reverse the ledger grant instead)
-- or 'missing'.
create function public.credit_lower_pending(
  p_reason text, p_source text, p_covered integer, p_total integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r credit_pending_grants;
  v_original integer;
  v_left integer;
begin
  if p_total is null or p_total <= 0 then
    raise exception 'invalid_reversal';
  end if;
  perform pg_advisory_xact_lock(hashtext('credit_source:' || p_source));
  select * into r from credit_pending_grants where reason = p_reason and ref = p_source for update;
  if not found then
    return 'missing';
  end if;
  if r.claimed_by is not null then
    return 'claimed';
  end if;
  v_original := coalesce(r.original_amount, r.amount);
  v_left := v_original - least(v_original, ceil(v_original::numeric * least(p_covered, p_total) / p_total)::integer);
  if v_left <= 0 then
    delete from credit_pending_grants where id = r.id;
  elsif v_left < r.amount then
    update credit_pending_grants set amount = v_left where id = r.id;
  end if;
  return 'lowered';
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
      where n.nspname = 'public' and p.proname in ('credit_record_reversal', 'credit_link_customer', 'credit_reverse_grant', 'credit_lower_pending')
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
