alter table upload_assets
  add column if not exists data bytea;

create index if not exists idx_upload_assets_filename
  on upload_assets (filename);
