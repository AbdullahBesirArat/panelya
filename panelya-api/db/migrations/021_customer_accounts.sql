create table if not exists customer_accounts (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id bigint references customers(id) on delete cascade,
  email text not null,
  name text not null default '',
  phone text not null default '',
  password_hash text not null,
  session_token_hash text,
  session_expires_at timestamptz,
  reset_token_hash text,
  reset_expires_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create index if not exists idx_customer_accounts_session
  on customer_accounts (session_token_hash)
  where session_token_hash is not null;

create index if not exists idx_customer_accounts_reset
  on customer_accounts (reset_token_hash)
  where reset_token_hash is not null;
