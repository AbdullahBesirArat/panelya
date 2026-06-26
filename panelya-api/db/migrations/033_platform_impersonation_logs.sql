-- 033_platform_impersonation_logs.sql
-- Super_admin'in bir magazanin paneline gecis (impersonation) kayitlari.
-- Geri donus: 033_..._down.sql

create table if not exists platform_impersonation_logs (
  id uuid primary key default gen_random_uuid(),
  super_admin_id bigint not null references admins(id) on delete cascade,
  target_organization_id uuid not null references organizations(id) on delete cascade,
  reason text,
  ip_address text,
  user_agent text,
  expires_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists idx_impersonation_super_admin on platform_impersonation_logs (super_admin_id, started_at desc);
create index if not exists idx_impersonation_target_org on platform_impersonation_logs (target_organization_id, started_at desc);
