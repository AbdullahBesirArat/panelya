create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'starter' check (plan in ('starter', 'growth', 'business', 'enterprise')),
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'suspended', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null default '',
  password_hash text,
  avatar_url text,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_app_users_email_lower on app_users (lower(email));

create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  invited_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null default 'iyzico' check (provider in ('iyzico', 'stripe', 'manual')),
  provider_customer_id text,
  provider_subscription_id text,
  plan text not null default 'starter',
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'cancelled', 'unpaid')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists activity_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  actor_user_id uuid references app_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

insert into organizations (name, slug, plan, status)
values ('Maveran', 'maveran', 'starter', 'active')
on conflict (slug) do nothing;

alter table categories add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table products add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table customers add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table orders add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table campaigns add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table slider_items add column if not exists organization_id uuid references organizations(id) on delete cascade;

update categories set organization_id = (select id from organizations where slug = 'maveran') where organization_id is null;
update products set organization_id = (select id from organizations where slug = 'maveran') where organization_id is null;
update customers set organization_id = (select id from organizations where slug = 'maveran') where organization_id is null;
update orders set organization_id = (select id from organizations where slug = 'maveran') where organization_id is null;
update campaigns set organization_id = (select id from organizations where slug = 'maveran') where organization_id is null;
update slider_items set organization_id = (select id from organizations where slug = 'maveran') where organization_id is null;

alter table categories drop constraint if exists categories_name_key;
alter table categories drop constraint if exists categories_slug_key;

create unique index if not exists idx_categories_org_slug_unique on categories (organization_id, slug);
create unique index if not exists idx_categories_org_name_unique on categories (organization_id, lower(name));
create index if not exists idx_products_org on products(organization_id);
create index if not exists idx_customers_org on customers(organization_id);
create index if not exists idx_orders_org on orders(organization_id);
create index if not exists idx_campaigns_org on campaigns(organization_id);
create index if not exists idx_slider_items_org on slider_items(organization_id);
create index if not exists idx_memberships_user on memberships(user_id);
create index if not exists idx_memberships_org_role on memberships(organization_id, role);
create index if not exists idx_subscriptions_org_status on subscriptions(organization_id, status);
create index if not exists idx_activity_logs_org_created on activity_logs(organization_id, created_at desc);
