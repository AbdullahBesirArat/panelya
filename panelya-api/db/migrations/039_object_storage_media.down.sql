drop policy if exists media_cleanup_jobs_tenant_policy on media_cleanup_jobs;
drop policy if exists media_references_tenant_policy on media_references;
drop policy if exists media_variants_tenant_policy on media_variants;
drop policy if exists upload_assets_tenant_policy on upload_assets;

alter table if exists media_cleanup_jobs disable row level security;
alter table if exists media_references disable row level security;
alter table if exists media_variants disable row level security;
alter table upload_assets disable row level security;

-- Safe expand rollback: object metadata, variants, references, cleanup jobs and
-- the legacy binary remain intact. Reapplying the up migration restores RLS
-- policies without deleting uploaded media or losing garbage-collection state.
