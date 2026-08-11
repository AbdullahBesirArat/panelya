-- A24.3: size guides. A guide holds a validated column/row schema (measurement
-- dimensions + size rows) as jsonb; text is sanitized to plain text by the service so
-- the storefront can render it with textContent (no HTML injection). A guide may be
-- scoped to a category (default for that category's products) and a product may override
-- with its own guide. Tenant-scoped with FORCE RLS + tenant-aware composite FKs.

create table if not exists size_guides (
  id bigserial primary key,
  organization_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  measurement_unit text not null default 'cm' check (measurement_unit in ('cm', 'inch')),
  columns jsonb not null default '[]'::jsonb
    check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) <= 12),
  rows jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) <= 80),
  category_id bigint,
  status text not null default 'draft' check (status in ('draft', 'active')),
  version integer not null default 1 check (version >= 1),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint size_guides_org_id_key unique (organization_id, id),
  constraint size_guides_category_fk foreign key (organization_id, category_id)
    references categories (organization_id, id) on delete set null
);
create index if not exists idx_size_guides_category
  on size_guides (organization_id, category_id, status, sort_order, id);

-- Product-level override: at most one guide per product.
create table if not exists product_size_guides (
  id bigserial primary key,
  organization_id uuid not null,
  product_id bigint not null,
  size_guide_id bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_size_guides_org_id_key unique (organization_id, id),
  constraint product_size_guides_unique unique (organization_id, product_id),
  constraint product_size_guides_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade,
  constraint product_size_guides_guide_fk foreign key (organization_id, size_guide_id)
    references size_guides (organization_id, id) on delete cascade
);

do $$
declare table_name text;
begin
  foreach table_name in array array['size_guides', 'product_size_guides'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    if not exists (
      select 1 from pg_policies where schemaname = 'public'
        and tablename = table_name and policyname = table_name || '_tenant_policy'
    ) then
      execute format(
        'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
        table_name || '_tenant_policy', table_name
      );
    end if;
  end loop;
end $$;
