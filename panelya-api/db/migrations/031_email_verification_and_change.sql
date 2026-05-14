-- Magic-link email verification + email-change tokens.
-- customer_accounts.email_verified_at added; app_users already has it (005).
-- A new polymorphic table covers customer + user subjects with signup/email_change purposes.
-- Named email_magic_link_tokens to avoid collision with the pre-existing
-- email_verification_tokens table (used by services/accountTokens.js).

begin;

alter table customer_accounts
  add column if not exists email_verified_at timestamptz;

alter table app_users
  add column if not exists email_verified_at timestamptz;

create table if not exists email_magic_link_tokens (
  id bigserial primary key,
  organization_id uuid references organizations(id) on delete cascade,
  subject_type text not null check (subject_type in ('customer', 'user')),
  subject_id text not null,
  purpose text not null check (purpose in ('signup', 'email_change')),
  token_hash text not null,
  new_email text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists email_magic_link_tokens_hash_idx
  on email_magic_link_tokens (token_hash);

create index if not exists email_magic_link_tokens_subject_idx
  on email_magic_link_tokens (subject_type, subject_id, purpose);

create index if not exists email_magic_link_tokens_active_idx
  on email_magic_link_tokens (expires_at)
  where consumed_at is null;

commit;
