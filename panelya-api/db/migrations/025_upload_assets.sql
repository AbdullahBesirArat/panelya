create table if not exists upload_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  url text not null unique,
  filename text not null,
  byte_size bigint not null default 0 check (byte_size >= 0),
  mime_type text not null default 'image/webp',
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_upload_assets_org_created
  on upload_assets(organization_id, created_at desc);
