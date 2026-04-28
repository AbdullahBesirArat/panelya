alter table organizations
  add column if not exists public_access_token text not null default encode(gen_random_bytes(24), 'hex');

create unique index if not exists idx_organizations_public_access_token
  on organizations (public_access_token);

create table if not exists api_rate_limits (
  key text primary key,
  hit_count integer not null default 0,
  reset_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_api_rate_limits_reset_at on api_rate_limits(reset_at);
