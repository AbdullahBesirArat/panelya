-- A24.4: server-canonical product comparison list for signed-in customers (guests keep
-- theirs in localStorage / the shareable URL and merge on login). Only product ids are
-- stored; the list is capped by the service. Tenant-scoped with FORCE RLS + composite FKs.

create table if not exists customer_comparisons (
  id bigserial primary key,
  organization_id uuid not null,
  customer_account_id bigint not null,
  product_id bigint not null,
  added_at timestamptz not null default now(),
  constraint customer_comparisons_org_id_key unique (organization_id, id),
  constraint customer_comparisons_unique unique (organization_id, customer_account_id, product_id),
  constraint customer_comparisons_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete cascade,
  constraint customer_comparisons_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade
);
create index if not exists idx_customer_comparisons
  on customer_comparisons (organization_id, customer_account_id, added_at, id);

do $$
begin
  execute 'alter table customer_comparisons enable row level security';
  execute 'alter table customer_comparisons force row level security';
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'customer_comparisons' and policyname = 'customer_comparisons_tenant_policy'
  ) then
    execute 'create policy customer_comparisons_tenant_policy on customer_comparisons '
      || 'using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      || 'with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)';
  end if;
end $$;
