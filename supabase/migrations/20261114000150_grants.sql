-- Stripe grant bookkeeping (lib/grants.js). Applies after
-- 20261114000100_credit_ledger.sql. Creates a new table and two functions.
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
-- one-to-one. Serialized per customer with a transaction-scoped advisory
-- lock, so two users linking the same customer at the same moment cannot
-- both win. Returns:
--   'linked'            the profile now points at p_customer
--   'linked_elsewhere'  another profile holds p_customer (nothing written)
--   'user_has_other'    the profile points at a different customer and
--                       p_allow_replace is false (nothing written)
-- Writes the same row and column lib/entitlement.js linkStripeCustomerToProfile
-- always upserted ({ id, stripe_customer_id }); profiles' schema is unchanged.
create function public.credit_link_customer(
  p_user uuid, p_customer text, p_allow_replace boolean default false
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
  perform pg_advisory_xact_lock(hashtext('stripe_customer:' || p_customer));
  if exists (select 1 from profiles where stripe_customer_id = p_customer and id <> p_user) then
    return 'linked_elsewhere';
  end if;
  select stripe_customer_id into v_current from profiles where id = p_user;
  if v_current is not null and v_current <> p_customer and not p_allow_replace then
    return 'user_has_other';
  end if;
  insert into profiles (id, stripe_customer_id) values (p_user, p_customer)
    on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id;
  return 'linked';
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
      where n.nspname = 'public' and p.proname in ('credit_record_reversal', 'credit_link_customer')
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
