-- A provider payment id is bound to exactly one (tenant, order) across every verified-payment
-- branch (paid, late, amount mismatch). First binder wins; append-only; no provider secrets.
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
alter table payment_identity_claims force row level security;
create policy payment_identity_claims_tenant_policy on payment_identity_claims
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

-- backfill:begin
insert into payment_identity_claims (provider, provider_payment_id, organization_id, order_id, created_at)
select distinct on (provider, provider_payment_id) provider, provider_payment_id, organization_id, order_id, created_at
  from (
    select provider, provider_payment_id, organization_id, order_id, created_at
      from payment_evidence where channel = 'card'
    union all
    select provider, provider_payment_id, organization_id, order_id, created_at
      from payment_reconciliation_cases where provider <> 'manual'
  ) known
 order by provider, provider_payment_id, created_at, order_id
on conflict (provider, provider_payment_id) do nothing;
-- backfill:end

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
