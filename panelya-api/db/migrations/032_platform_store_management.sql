-- 032_platform_store_management.sql
-- Platform Yonetimi (super_admin) icin organizations tablosuna ek alanlar.
-- Tum alanlar nullable veya default'lu; mevcut veri korunur. Geri donus: 032_..._down.sql

-- 1) Yeni kolonlar (additive, guvenli)
alter table organizations
  add column if not exists domain text,
  add column if not exists storefront_url text,
  add column if not exists owner_user_id uuid references app_users(id) on delete set null,
  add column if not exists setup_completed_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- 2) status CHECK constraint'ini genislet:
--    mevcut: active, trialing, past_due, suspended, cancelled
--    eklenen: setup (kurulumda), archived (arsivlenmis / soft-delete)
alter table organizations drop constraint if exists organizations_status_check;
alter table organizations
  add constraint organizations_status_check
  check (status in ('setup', 'active', 'trialing', 'past_due', 'suspended', 'cancelled', 'archived'));

-- 3) Geriye donuk doldurma: mevcut owner membership'inden owner_user_id turet (yalnizca bos olanlar)
update organizations o
set owner_user_id = sub.user_id
from (
  select distinct on (m.organization_id) m.organization_id, m.user_id
  from memberships m
  where m.role = 'owner' and m.status = 'active'
  order by m.organization_id, m.created_at asc
) sub
where sub.organization_id = o.id
  and o.owner_user_id is null;

-- 4) Indexler (platform listeleme/filtreleme)
create index if not exists idx_organizations_status on organizations (status);
create index if not exists idx_organizations_owner_user on organizations (owner_user_id);
create index if not exists idx_organizations_domain on organizations (domain) where domain is not null;
