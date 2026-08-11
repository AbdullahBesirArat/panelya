-- A15: tenant-safe coupon rules, scope and concurrency-safe redemption holds.

alter table orders no force row level security;

alter table orders
  add column if not exists subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  add column if not exists discount_total numeric(12,2) not null default 0 check (discount_total >= 0),
  add column if not exists campaign_discount numeric(12,2) not null default 0 check (campaign_discount >= 0),
  add column if not exists coupon_discount numeric(12,2) not null default 0 check (coupon_discount >= 0),
  add column if not exists shipping_discount numeric(12,2) not null default 0 check (shipping_discount >= 0),
  add column if not exists coupon_code text,
  add column if not exists promotion_snapshot jsonb not null default '{}'::jsonb;

create table if not exists coupons (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null check (char_length(btrim(code)) between 3 and 64),
  normalized_code text generated always as (upper(btrim(code))) stored,
  name text not null,
  internal_description text not null default '',
  discount_type text not null check (discount_type in ('percentage','fixed','free_shipping')),
  value numeric(12,2) not null default 0,
  currency char(3) not null default 'TRY' check (currency = 'TRY'),
  minimum_subtotal numeric(12,2) not null default 0 check (minimum_subtotal >= 0),
  maximum_discount numeric(12,2) check (maximum_discount is null or maximum_discount >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  total_usage_limit integer check (total_usage_limit is null or total_usage_limit > 0),
  per_customer_limit integer check (per_customer_limit is null or per_customer_limit > 0),
  first_order_only boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive')),
  stacking_policy text not null default 'best_discount'
    check (stacking_policy in ('exclusive','with_campaign','best_discount')),
  priority integer not null default 0,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_org_id_key unique (organization_id, id),
  constraint coupons_dates_check check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint coupons_value_check check (
    (discount_type = 'percentage' and value > 0 and value <= 100)
    or (discount_type = 'fixed' and value > 0)
    or (discount_type = 'free_shipping' and value >= 0)
  )
);

create unique index if not exists idx_coupons_org_normalized_code
  on coupons (organization_id, normalized_code);
create index if not exists idx_coupons_org_status_dates
  on coupons (organization_id, status, starts_at, ends_at, priority desc);

create table if not exists coupon_products (
  organization_id uuid not null,
  coupon_id bigint not null,
  product_id bigint not null,
  excluded boolean not null default false,
  primary key (coupon_id, product_id),
  foreign key (organization_id, coupon_id)
    references coupons (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade
);

create table if not exists coupon_categories (
  organization_id uuid not null,
  coupon_id bigint not null,
  category_id bigint not null,
  excluded boolean not null default false,
  primary key (coupon_id, category_id),
  foreign key (organization_id, coupon_id)
    references coupons (organization_id, id) on delete cascade,
  foreign key (organization_id, category_id)
    references categories (organization_id, id) on delete cascade
);

create table if not exists coupon_collections (
  organization_id uuid not null,
  coupon_id bigint not null,
  collection_id bigint not null,
  excluded boolean not null default false,
  primary key (coupon_id, collection_id),
  foreign key (organization_id, coupon_id)
    references coupons (organization_id, id) on delete cascade,
  foreign key (organization_id, collection_id)
    references collections (organization_id, id) on delete cascade
);

create table if not exists coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  coupon_id bigint not null,
  customer_id bigint,
  guest_reference_hash text,
  order_id bigint not null,
  discount_amount numeric(12,2) not null check (discount_amount >= 0),
  allocation_snapshot jsonb not null default '[]'::jsonb,
  status text not null default 'reserved' check (status in ('reserved','redeemed','released')),
  idempotency_key text,
  redeemed_at timestamptz,
  released_at timestamptz,
  released_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupon_redemptions_org_id_key unique (organization_id, id),
  foreign key (organization_id, coupon_id)
    references coupons (organization_id, id) on delete restrict,
  foreign key (organization_id, customer_id)
    references customers (organization_id, id) on delete set null (customer_id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete cascade,
  unique (organization_id, coupon_id, order_id)
);

create unique index if not exists idx_coupon_redemptions_org_idempotency
  on coupon_redemptions (organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_coupon_redemptions_usage
  on coupon_redemptions (organization_id, coupon_id, status, customer_id, guest_reference_hash);

alter table coupons enable row level security;
alter table coupons force row level security;
alter table coupon_products enable row level security;
alter table coupon_products force row level security;
alter table coupon_categories enable row level security;
alter table coupon_categories force row level security;
alter table coupon_collections enable row level security;
alter table coupon_collections force row level security;
alter table coupon_redemptions enable row level security;
alter table coupon_redemptions force row level security;

create policy coupons_tenant_policy on coupons
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy coupon_products_tenant_policy on coupon_products
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy coupon_categories_tenant_policy on coupon_categories
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy coupon_collections_tenant_policy on coupon_collections
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy coupon_redemptions_tenant_policy on coupon_redemptions
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

alter table orders force row level security;

