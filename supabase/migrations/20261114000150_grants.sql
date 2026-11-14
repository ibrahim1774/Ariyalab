-- Stripe grant bookkeeping (lib/grants.js). Applies after
-- 20261114000100_credit_ledger.sql. New table only; touches no shared table.
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
