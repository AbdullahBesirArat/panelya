-- A24.1: server-canonical "recently viewed" history for signed-in customers. Guests
-- keep their history client-side (localStorage) and merge it here on login. Only the
-- product id + a timestamp are stored (no browsing profile). Tenant-scoped with FORCE
-- RLS + tenant-aware composite FKs; a re-view updates the timestamp (unique upsert),
-- and the read side enforces the max-count / TTL and hides passive products.

create table if not exists customer_recently_viewed (
  id bigserial primary key,
  organization_id uuid not null,
  customer_account_id bigint not null,
  product_id bigint not null,
  viewed_at timestamptz not null default now(),
  constraint customer_recently_viewed_org_id_key unique (organization_id, id),
  constraint customer_recently_viewed_unique unique (organization_id, customer_account_id, product_id),
  constraint customer_recently_viewed_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete cascade,
  constraint customer_recently_viewed_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade
);
create index if not exists idx_customer_recently_viewed
  on customer_recently_viewed (organization_id, customer_account_id, viewed_at desc, id desc);

do $$
begin
  execute 'alter table customer_recently_viewed enable row level security';
  execute 'alter table customer_recently_viewed force row level security';
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'customer_recently_viewed' and policyname = 'customer_recently_viewed_tenant_policy'
  ) then
    execute 'create policy customer_recently_viewed_tenant_policy on customer_recently_viewed '
      || 'using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      || 'with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)';
  end if;
end $$;
