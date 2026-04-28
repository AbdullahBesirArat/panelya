create table if not exists organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  token_hash text not null unique,
  invited_by uuid references app_users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_organization_invites_org_created
  on organization_invites(organization_id, created_at desc);

create unique index if not exists idx_organization_invites_org_email_active
  on organization_invites(organization_id, lower(email))
  where accepted_at is null;

create table if not exists plan_limits (
  plan_name text primary key check (plan_name in ('starter', 'growth', 'business', 'enterprise')),
  max_products integer not null,
  max_orders_month integer not null,
  max_members integer not null,
  max_storage_mb integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into plan_limits (plan_name, max_products, max_orders_month, max_members, max_storage_mb)
values
  ('starter', 25, 150, 3, 512),
  ('growth', 250, 2000, 15, 4096),
  ('business', 2500, 25000, 75, 20480),
  ('enterprise', 1000000, 1000000, 1000000, 102400)
on conflict (plan_name) do update set
  max_products = excluded.max_products,
  max_orders_month = excluded.max_orders_month,
  max_members = excluded.max_members,
  max_storage_mb = excluded.max_storage_mb,
  updated_at = now();
