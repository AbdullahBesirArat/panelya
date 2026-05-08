create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'starter' check (plan in ('starter', 'growth', 'business', 'enterprise')),
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'suspended', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into organizations (name, slug, plan, status)
values ('Suvera', 'suvera', 'growth', 'active')
on conflict (slug) do nothing;

create table if not exists categories (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  image_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  category_id bigint references categories(id) on delete set null,
  price numeric(12,2) not null check (price >= 0),
  sale_price numeric(12,2) check (sale_price is null or sale_price >= 0),
  stock integer not null default 0 check (stock >= 0),
  status text not null default 'draft' check (status in ('active', 'draft', 'out')),
  colors jsonb not null default '[]'::jsonb,
  sizes jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  tags text not null default '',
  description text not null default '',
  emoji text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists customers (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text not null default '',
  phone text not null default '',
  address text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  order_code text not null unique,
  customer_id bigint references customers(id) on delete set null,
  total numeric(12,2) not null default 0,
  status text not null default 'new' check (status in ('new', 'payment_pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid')),
  payment_provider text not null default 'manual',
  payment_method text not null default 'card' check (payment_method in ('card', 'iban')),
  payment_token text,
  payment_id text,
  payment_error text,
  note text not null default '',
  gift_wrap boolean not null default false,
  shipping_fee numeric(12,2) not null default 0,
  shipping_company text,
  tracking_number text,
  tracking_url text,
  shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_items (
  id bigserial primary key,
  order_id bigint not null references orders(id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  variant_id bigint references product_variants(id) on delete set null,
  product_name text not null,
  selected_color text not null default '',
  selected_size text not null default '',
  sku text not null default '',
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  type text not null,
  value numeric(12,2) not null default 0,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists collections (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  slug text not null,
  description text not null default '',
  image_url text not null default '',
  link_url text not null default 'urunler',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists slider_items (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  tag text not null default '',
  title text not null,
  sub text not null default '',
  btn text not null default 'Keşfet',
  image_url text not null default '',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admins (
  id bigserial primary key,
  username text not null unique,
  password_hash text not null,
  role text not null default 'admin' check (role in ('super_admin', 'admin', 'viewer')),
  created_at timestamptz not null default now()
);

alter table if exists admins
  add column if not exists role text not null default 'admin'
  check (role in ('super_admin', 'admin', 'viewer'));

create table if not exists audit_logs (
  id bigserial primary key,
  timestamp timestamptz not null default now(),
  admin_id bigint references admins(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  old_value jsonb,
  new_value jsonb,
  ip_address inet,
  user_agent text,
  success boolean not null default true,
  error_message text
);

create table if not exists upload_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  url text not null unique,
  filename text not null,
  byte_size bigint not null default 0 check (byte_size >= 0),
  mime_type text not null default 'image/webp',
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_products_category on products(category_id);
create unique index if not exists idx_categories_org_slug_unique on categories (organization_id, slug);
create unique index if not exists idx_categories_org_name_unique on categories (organization_id, lower(name));
create index if not exists idx_products_org on products(organization_id);
create index if not exists idx_customers_org on customers(organization_id);
create index if not exists idx_orders_org on orders(organization_id);
create index if not exists idx_campaigns_org on campaigns(organization_id);
create index if not exists idx_slider_items_org on slider_items(organization_id);
create index if not exists idx_product_variants_product on product_variants(product_id);
create index if not exists idx_product_variants_org_product on product_variants(organization_id, product_id);
create unique index if not exists idx_collections_org_slug_unique on collections (organization_id, slug);
create index if not exists idx_collections_org_active_sort on collections (organization_id, active, sort_order, id);
create index if not exists idx_products_status on products(status);
create index if not exists idx_products_created_at on products(created_at desc);
create index if not exists idx_products_name_trgm on products using gin (name gin_trgm_ops);
create index if not exists idx_customers_created_at on customers(created_at desc);
create index if not exists idx_customers_email on customers(email);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_created_at on orders(created_at desc);
create index if not exists idx_orders_payment_token on orders(payment_token);
create index if not exists idx_orders_customer on orders(customer_id);
create index if not exists idx_order_items_order on order_items(order_id);
create index if not exists idx_audit_logs_timestamp on audit_logs(timestamp desc);
create index if not exists idx_audit_logs_admin on audit_logs(admin_id);
create index if not exists idx_audit_logs_resource on audit_logs(resource_type, resource_id);
create index if not exists idx_upload_assets_org_created on upload_assets(organization_id, created_at desc);
