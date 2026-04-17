alter table products
  add column if not exists details jsonb not null default '{}'::jsonb;
