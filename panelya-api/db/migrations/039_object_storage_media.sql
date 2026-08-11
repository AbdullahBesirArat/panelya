alter table upload_assets
  add column if not exists storage_provider text not null default 'legacy',
  add column if not exists bucket_name text,
  add column if not exists object_key text,
  add column if not exists original_filename text,
  add column if not exists content_type text,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists checksum text,
  add column if not exists status text not null default 'ready',
  add column if not exists orphaned_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update upload_assets
set content_type = coalesce(content_type, mime_type),
    original_filename = coalesce(original_filename, filename),
    status = case when status = 'pending' then 'ready' else status end
where content_type is null
   or original_filename is null
   or status = 'pending';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'upload_assets_media_status_check'
  ) then
    alter table upload_assets
      add constraint upload_assets_media_status_check
      check (status in ('pending', 'ready', 'orphan_candidate', 'deleting', 'deleted', 'failed'));
  end if;
end $$;

create unique index if not exists uq_upload_assets_org_id
  on upload_assets(organization_id, id);
create index if not exists idx_upload_assets_org_status_orphan
  on upload_assets(organization_id, status, orphaned_at);
create index if not exists idx_upload_assets_org_checksum
  on upload_assets(organization_id, checksum)
  where checksum is not null and status = 'ready';

create table if not exists media_variants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  asset_id uuid not null,
  variant_name text not null check (variant_name in ('thumbnail', 'card', 'detail')),
  storage_provider text not null,
  bucket_name text,
  object_key text not null,
  url text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  checksum text not null,
  created_at timestamptz not null default now(),
  constraint media_variants_asset_fk
    foreign key (organization_id, asset_id)
    references upload_assets(organization_id, id)
    on delete cascade,
  unique (asset_id, variant_name),
  unique (storage_provider, object_key)
);

create index if not exists idx_media_variants_org_asset
  on media_variants(organization_id, asset_id);

create table if not exists media_references (
  id bigserial primary key,
  organization_id uuid not null,
  asset_id uuid not null,
  resource_type text not null check (resource_type in ('product', 'category', 'collection', 'blog_post', 'slider_item', 'theme')),
  resource_id text not null,
  field_name text not null default 'image',
  alt_text text not null default '',
  created_at timestamptz not null default now(),
  constraint media_references_asset_fk
    foreign key (organization_id, asset_id)
    references upload_assets(organization_id, id)
    on delete cascade,
  unique (organization_id, asset_id, resource_type, resource_id, field_name)
);

create index if not exists idx_media_references_resource
  on media_references(organization_id, resource_type, resource_id);

create table if not exists media_cleanup_jobs (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  asset_id uuid,
  storage_provider text not null,
  bucket_name text,
  object_key text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (storage_provider, object_key)
);

create index if not exists idx_media_cleanup_jobs_pending
  on media_cleanup_jobs(status, available_at)
  where status in ('pending', 'processing');

alter table upload_assets enable row level security;
alter table upload_assets force row level security;
alter table media_variants enable row level security;
alter table media_variants force row level security;
alter table media_references enable row level security;
alter table media_references force row level security;
alter table media_cleanup_jobs enable row level security;
alter table media_cleanup_jobs force row level security;

drop policy if exists upload_assets_tenant_policy on upload_assets;
create policy upload_assets_tenant_policy on upload_assets
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

drop policy if exists media_variants_tenant_policy on media_variants;
create policy media_variants_tenant_policy on media_variants
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

drop policy if exists media_references_tenant_policy on media_references;
create policy media_references_tenant_policy on media_references
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

drop policy if exists media_cleanup_jobs_tenant_policy on media_cleanup_jobs;
create policy media_cleanup_jobs_tenant_policy on media_cleanup_jobs
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

comment on column upload_assets.data is
  'Legacy-only binary. New uploads use object storage; remove only after verified backfill and backup.';
