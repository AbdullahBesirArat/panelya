-- A20: bounded, preview-first catalog import jobs with tenant-isolated row processing.

alter table product_variants no force row level security;
alter table product_variants
  add column if not exists inventory_version bigint not null default 0 check (inventory_version >= 0);
alter table product_variants force row level security;

create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  job_type text not null check (job_type in ('product_upsert','stock_update','price_update')),
  status text not null default 'uploaded' check (status in (
    'uploaded','previewed','queued','processing','completed','completed_with_errors','failed','cancelled'
  )),
  original_filename text not null,
  content_type text not null,
  storage_provider text not null,
  bucket_name text,
  object_key text not null unique,
  byte_size bigint not null check (byte_size between 1 and 10485760),
  checksum char(64) not null check (checksum ~ '^[0-9a-f]{64}$'),
  config jsonb not null default '{}'::jsonb check (octet_length(config::text) <= 16384),
  config_hash char(64) not null check (config_hash ~ '^[0-9a-f]{64}$'),
  preview_checksum char(64),
  preview_config_hash char(64),
  warnings jsonb not null default '[]'::jsonb check (octet_length(warnings::text) <= 16384),
  total_rows integer not null default 0 check (total_rows between 0 and 10000),
  processed_rows integer not null default 0 check (processed_rows between 0 and total_rows),
  success_rows integer not null default 0 check (success_rows between 0 and total_rows),
  error_rows integer not null default 0 check (error_rows between 0 and total_rows),
  idempotency_key text not null,
  created_by uuid references app_users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  retention_until timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_jobs_org_id_key unique (organization_id, id),
  constraint import_jobs_org_idempotency_key unique (organization_id, idempotency_key),
  constraint import_jobs_preview_pair check (
    (preview_checksum is null and preview_config_hash is null)
    or (preview_checksum is not null and preview_config_hash is not null)
  )
);

create index if not exists idx_import_jobs_claim
  on import_jobs (status, created_at) where status = 'queued';
create index if not exists idx_import_jobs_org_created
  on import_jobs (organization_id, created_at desc);

create table if not exists import_job_rows (
  id bigserial primary key,
  organization_id uuid not null,
  import_job_id uuid not null,
  row_number integer not null check (row_number between 2 and 10001),
  row_key char(64) not null check (row_key ~ '^[0-9a-f]{64}$'),
  normalized_payload jsonb not null check (octet_length(normalized_payload::text) <= 65536),
  status text not null default 'pending' check (status in ('pending','processing','succeeded','error','cancelled')),
  error_codes jsonb not null default '[]'::jsonb check (octet_length(error_codes::text) <= 16384),
  resulting_entity_id bigint,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  locked_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_job_rows_org_id_key unique (organization_id, id),
  constraint import_job_rows_job_row_key unique (import_job_id, row_number),
  constraint import_job_rows_job_fk foreign key (organization_id, import_job_id)
    references import_jobs (organization_id, id) on delete cascade
);

create index if not exists idx_import_job_rows_process
  on import_job_rows (organization_id, import_job_id, status, row_number);

create table if not exists import_job_images (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  import_job_id uuid not null,
  original_filename text not null,
  normalized_filename text not null,
  storage_provider text not null,
  bucket_name text,
  object_key text not null unique,
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  checksum char(64) not null check (checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint import_job_images_org_id_key unique (organization_id, id),
  constraint import_job_images_job_name_key unique (import_job_id, normalized_filename),
  constraint import_job_images_job_fk foreign key (organization_id, import_job_id)
    references import_jobs (organization_id, id) on delete cascade
);

create index if not exists idx_import_job_images_job
  on import_job_images (organization_id, import_job_id);

do $$
declare table_name text;
begin
  foreach table_name in array array['import_jobs','import_job_rows','import_job_images'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
      table_name || '_tenant_policy', table_name
    );
  end loop;
end $$;

comment on table import_job_rows is
  'A20 normalized import rows; payload/error sizes are bounded and rows expire with their job retention policy.';
