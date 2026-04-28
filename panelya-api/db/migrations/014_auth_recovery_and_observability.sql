create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_password_reset_tokens_user on password_reset_tokens(user_id, created_at desc);
create index if not exists idx_password_reset_tokens_expires on password_reset_tokens(expires_at);

create table if not exists email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_verification_tokens_user on email_verification_tokens(user_id, created_at desc);
create index if not exists idx_email_verification_tokens_expires on email_verification_tokens(expires_at);
