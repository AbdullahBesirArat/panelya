-- 034_platform_settings.sql
-- Platform geneli ayarlar icin tek-satir (singleton) tablo.
-- Additive, geri-guvenli. Geri donus: 034_..._down.sql

create table if not exists platform_settings (
  id smallint primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint platform_settings_singleton check (id = 1)
);

insert into platform_settings (id, data)
values (1, jsonb_build_object(
  'defaultPlan', 'growth',
  'supportEmail', '',
  'allowSelfSignup', true,
  'maintenanceMode', false
))
on conflict (id) do nothing;
