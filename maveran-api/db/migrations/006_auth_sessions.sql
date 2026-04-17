create table if not exists refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  user_agent text,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index if not exists idx_refresh_tokens_user on refresh_tokens(user_id);
create index if not exists idx_refresh_tokens_expires on refresh_tokens(expires_at);
