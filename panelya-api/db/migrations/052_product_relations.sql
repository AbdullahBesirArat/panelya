-- A24.2: curated related / complementary / upsell product links. Tenant-scoped with
-- FORCE RLS + tenant-aware composite FKs. A product may never relate to itself, and a
-- given (source, target, type) triple is unique. Deleting either product removes the
-- link. The storefront falls back to a deterministic category/collection query (no
-- personal profile) when no manual links exist; that fallback needs no table.

create table if not exists product_relations (
  id bigserial primary key,
  organization_id uuid not null,
  source_product_id bigint not null,
  target_product_id bigint not null,
  relation_type text not null check (relation_type in ('related','complementary','upsell')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_relations_org_id_key unique (organization_id, id),
  constraint product_relations_no_self check (source_product_id <> target_product_id),
  constraint product_relations_unique unique (organization_id, source_product_id, target_product_id, relation_type),
  constraint product_relations_source_fk foreign key (organization_id, source_product_id)
    references products (organization_id, id) on delete cascade,
  constraint product_relations_target_fk foreign key (organization_id, target_product_id)
    references products (organization_id, id) on delete cascade
);
create index if not exists idx_product_relations_source
  on product_relations (organization_id, source_product_id, relation_type, sort_order, id);

do $$
begin
  execute 'alter table product_relations enable row level security';
  execute 'alter table product_relations force row level security';
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'product_relations' and policyname = 'product_relations_tenant_policy'
  ) then
    execute 'create policy product_relations_tenant_policy on product_relations '
      || 'using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      || 'with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)';
  end if;
end $$;
