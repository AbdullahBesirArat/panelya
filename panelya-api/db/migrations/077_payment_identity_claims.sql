-- A provider payment id is bound to exactly one (tenant, order) across every verified-payment
-- branch (paid, late, amount mismatch). First binder wins; append-only; no provider secrets.
-- Bound the wait for the locks below so a busy old instance makes the deploy fail fast and safely.
set local lock_timeout = '10s';

create table payment_identity_claims (
  provider text not null check (nullif(btrim(provider), '') is not null),
  provider_payment_id text not null check (nullif(btrim(provider_payment_id), '') is not null),
  organization_id uuid not null,
  order_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (provider, provider_payment_id),
  foreign key (organization_id, order_id) references orders (organization_id, id) on delete restrict
);

create index idx_payment_identity_claims_order on payment_identity_claims (organization_id, order_id);

create function reject_payment_identity_claim_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Payment identity claims are append-only';
end $$;

create trigger payment_identity_claims_immutable before update or delete on payment_identity_claims
  for each row execute function reject_payment_identity_claim_mutation();
create trigger payment_identity_claims_no_truncate before truncate on payment_identity_claims
  for each statement execute function reject_payment_identity_claim_mutation();

alter table payment_identity_claims enable row level security;
create policy payment_identity_claims_tenant_policy on payment_identity_claims
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

-- backfill:begin
-- The migrating role is subject to FORCE ROW LEVEL SECURITY, so it only sees rows of the tenant named
-- in app.current_organization_id. Iterate the tenants instead of lifting FORCE: ALTER TABLE ... NO FORCE
-- takes ACCESS EXCLUSIVE locks and would stall every order read/write of still-running old instances.
-- A clean result is only meaningful if this role can actually see every tenant's rows. Refuse to
-- continue (instead of silently reporting "no conflicts") when visibility cannot be verified: the
-- tenant list itself must be unrestricted and each scanned table must use the tenant-context policy
-- this scan relies on.
do $$
declare scanned text;
begin
  if (select relforcerowsecurity from pg_class where oid = 'organizations'::regclass) then
    raise exception 'Cannot apply migration 077: tenant visibility cannot be verified (tenant list is row-restricted)'
      using errcode = 'P0001';
  end if;
  for scanned in select unnest(array['payment_evidence', 'payment_reconciliation_cases', 'orders']) loop
    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = scanned
         and coalesce(p.qual, '') like '%app.current_organization_id%'
    ) then
      raise exception 'Cannot apply migration 077: tenant visibility cannot be verified (unrecognised row policy)'
        using errcode = 'P0001';
    end if;
  end loop;
end $$;

create temporary table payment_identity_known (
  source text not null, provider text not null, provider_payment_id text not null,
  organization_id uuid not null, order_id bigint not null, created_at timestamptz not null
) on commit drop;

do $$
declare tenant uuid;
begin
  for tenant in select id from organizations loop
    perform set_config('app.current_organization_id', tenant::text, true);
    insert into payment_identity_known
      select 'evidence', provider, provider_payment_id, organization_id, order_id, created_at
        from payment_evidence
       where channel = 'card' and nullif(btrim(provider_payment_id), '') is not null;
    insert into payment_identity_known
      select 'case', provider, provider_payment_id, organization_id, order_id, created_at
        from payment_reconciliation_cases
       where provider <> 'manual' and nullif(btrim(provider_payment_id), '') is not null;
    insert into payment_identity_known
      select 'order', payment_provider, payment_id, organization_id, id, created_at
        from orders
       where payment_provider = 'iyzico' and nullif(btrim(payment_id), '') is not null
         and payment_id not like 'mock-%';
  end loop;
  perform set_config('app.current_organization_id', '', true);
end $$;

-- Fail closed on ambiguous legacy ownership: one provider payment id must belong to exactly one
-- (tenant, order) across evidence, cases and legacy orders.payment_id (iyzico only; the id then only
-- RESERVES the identity, it is never treated as verified evidence). The message carries no payment id
-- or tenant data; the whole migration (table, claims, schema_migrations row) rolls back.
do $$
begin
  if exists (
    select 1 from payment_identity_known
     group by provider, provider_payment_id
    having count(distinct (organization_id, order_id)) > 1
  ) then
    raise exception 'Cannot apply migration 077: conflicting legacy payment identity ownership exists; resolve it before migrating'
      using errcode = 'P0001';
  end if;
end $$;

insert into payment_identity_claims (provider, provider_payment_id, organization_id, order_id, created_at)
select distinct on (provider, provider_payment_id) provider, provider_payment_id, organization_id, order_id, created_at
  from payment_identity_known
 order by provider, provider_payment_id, created_at, order_id
on conflict (provider, provider_payment_id) do nothing;
-- backfill:end

-- Lookup used by every verified-payment callback for legacy orders.payment_id values.
create index idx_orders_payment_provider_payment_id on orders (payment_provider, payment_id)
  where payment_id is not null;

alter table payment_identity_claims force row level security;

do $$
declare role_name text;
begin
  foreach role_name in array array['panelya_runtime', 'panelya_system_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke update, delete, truncate on payment_identity_claims from %I', role_name);
      execute format('grant select, insert on payment_identity_claims to %I', role_name);
    end if;
  end loop;
end $$;
