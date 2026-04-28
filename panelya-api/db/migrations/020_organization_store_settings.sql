alter table organizations
  add column if not exists store_settings jsonb not null default '{}'::jsonb;
