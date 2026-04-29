create table if not exists product_variants (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id bigint not null references products(id) on delete cascade,
  color text not null default '',
  size text not null default '',
  sku text not null default '',
  stock integer not null default 0 check (stock >= 0),
  status text not null default 'active' check (status in ('active', 'out')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, color, size)
);

create index if not exists idx_product_variants_product
  on product_variants(product_id);

create index if not exists idx_product_variants_org_product
  on product_variants(organization_id, product_id);

alter table order_items
  add column if not exists variant_id bigint references product_variants(id) on delete set null,
  add column if not exists selected_color text not null default '',
  add column if not exists selected_size text not null default '',
  add column if not exists sku text not null default '';
