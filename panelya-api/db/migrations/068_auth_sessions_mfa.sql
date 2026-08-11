-- A30 (1/2): sessions, MFA factors, passkeys and step-up.
--
-- Additive by design. The existing refresh_tokens table keeps its shape and its rotation
-- behaviour; sessions are layered ON it via refresh_tokens.session_id, so nothing about
-- A04's HttpOnly-cookie/BFF model changes and no admin is logged out by this migration.
--
-- Two actor types share these tables because the platform has two: `admins` (super-admin,
-- the platform console) and `app_users` (tenant members). They are kept in ONE session
-- table with a discriminating actor_type and two nullable, mutually exclusive foreign keys
-- rather than duplicated per actor: a session revoke, an MFA policy and a step-up check
-- must behave identically for both, and two parallel implementations would drift.
--
-- These tables are NOT tenant-scoped. A session, a passkey and a TOTP factor belong to a
-- PERSON, who may be a member of several organizations; scoping them to one tenant would
-- mean an owner of two stores had two unrelated sets of credentials. Tenant isolation for
-- them is by user identity, enforced in every query by user, which is why they carry no
-- organization_id and no RLS policy. The one A30 table that IS tenant data —
-- organization_security_policies — does carry both.

-- ---------------------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------------------

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('app', 'admin')),
  user_id uuid references app_users(id) on delete cascade,
  admin_id bigint references admins(id) on delete cascade,
  -- Survives refresh rotation: every rotated refresh token stays in the same family, so
  -- "log this device out" means one row, not a guess about which token is current.
  session_family_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) <= 80),
  device_label text check (device_label is null or char_length(device_label) <= 120),
  -- The raw User-Agent is NOT stored. A hash identifies a returning device and a short
  -- parsed summary is what a human reads; keeping the full string would make this a
  -- browser-fingerprint archive with no operational benefit.
  user_agent_hash char(64) check (user_agent_hash is null or user_agent_hash ~ '^[0-9a-f]{64}$'),
  user_agent_summary text check (user_agent_summary is null or char_length(user_agent_summary) <= 120),
  -- Network prefix only (IPv4 /24, IPv6 /48). Enough to notice "this session moved
  -- networks", not enough to track a person's location over time.
  ip_prefix text check (ip_prefix is null or char_length(ip_prefix) <= 64),
  -- The authoritative assurance level for this session. Route checks read THIS, never a
  -- claim in a token the client could be holding from before an MFA change.
  mfa_level text not null default 'password' check (mfa_level in ('password', 'mfa')),
  mfa_verified_at timestamptz,
  -- Recent re-authentication, for operations that must not ride on a week-old login.
  step_up_verified_at timestamptz,
  step_up_method text check (step_up_method is null or step_up_method in ('password', 'totp', 'webauthn', 'recovery_code')),
  created_auth_method text not null default 'password'
    check (created_auth_method in ('password', 'webauthn', 'impersonation')),
  last_auth_method text check (last_auth_method is null or char_length(last_auth_method) <= 30),
  -- A04 impersonation stays a separate, visible thing rather than an ordinary session.
  is_impersonation boolean not null default false,
  impersonator_admin_id bigint references admins(id) on delete set null,
  impersonation_reason text check (impersonation_reason is null or char_length(impersonation_reason) <= 200),
  updated_at timestamptz not null default now(),
  -- Exactly one owner, matching the actor type. Anything else would make "whose session is
  -- this" ambiguous, which is the last question you want ambiguous.
  constraint auth_sessions_actor_owner check (
    (actor_type = 'app' and user_id is not null and admin_id is null)
    or (actor_type = 'admin' and admin_id is not null and user_id is null)
  ),
  constraint auth_sessions_revoked_consistent check ((revoked_at is null) = (revoke_reason is null)),
  constraint auth_sessions_mfa_consistent check ((mfa_level = 'mfa') = (mfa_verified_at is not null))
);
create index if not exists idx_auth_sessions_user on auth_sessions (user_id, created_at desc);
create index if not exists idx_auth_sessions_admin on auth_sessions (admin_id, created_at desc);
create index if not exists idx_auth_sessions_family on auth_sessions (session_family_id);
create index if not exists idx_auth_sessions_expiry on auth_sessions (expires_at);

-- The link that makes rotation keep its session. Nullable so pre-A30 rows stay valid and
-- nobody is logged out; 069 backfills the ones that are still active.
alter table refresh_tokens
  add column if not exists session_id uuid references auth_sessions(id) on delete cascade;
create index if not exists idx_refresh_tokens_session on refresh_tokens (session_id);

-- ---------------------------------------------------------------------------------------
-- MFA factors
-- ---------------------------------------------------------------------------------------

create table if not exists user_mfa_methods (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('app', 'admin')),
  user_id uuid references app_users(id) on delete cascade,
  admin_id bigint references admins(id) on delete cascade,
  type text not null check (type in ('totp')),
  -- ENCRYPTED, not hashed: TOTP verification recomputes the code from the shared secret,
  -- so the server must be able to read it back. This is the same reason A29's webhook
  -- signing secret is encrypted, and the opposite of an API key or a password.
  encrypted_secret text not null check (char_length(encrypted_secret) between 1 and 2000),
  encryption_version integer not null default 1,
  enabled boolean not null default false,
  verified_at timestamptz,
  -- The last accepted TOTP time-step. A code is valid for a whole step, so without this a
  -- captured code could be replayed for the rest of its window.
  last_used_step bigint,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  constraint user_mfa_actor_owner check (
    (actor_type = 'app' and user_id is not null and admin_id is null)
    or (actor_type = 'admin' and admin_id is not null and user_id is null)
  ),
  constraint user_mfa_enabled_verified check ((enabled = false) or (verified_at is not null))
);
-- One TOTP factor per person: a second one is a second thing to lose, not more security.
-- Partial so a disabled factor does not block re-enrolment.
create unique index if not exists idx_user_mfa_one_active_app
  on user_mfa_methods (user_id, type) where user_id is not null and disabled_at is null;
create unique index if not exists idx_user_mfa_one_active_admin
  on user_mfa_methods (admin_id, type) where admin_id is not null and disabled_at is null;

create table if not exists mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('app', 'admin')),
  user_id uuid references app_users(id) on delete cascade,
  admin_id bigint references admins(id) on delete cascade,
  -- HASH ONLY. Unlike a TOTP secret there is nothing to recompute: the server checks a
  -- presented code against the hash and never needs the original again.
  code_hash char(64) not null check (code_hash ~ '^[0-9a-f]{64}$'),
  generation integer not null default 1,
  used_at timestamptz,
  used_session_id uuid references auth_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint mfa_recovery_actor_owner check (
    (actor_type = 'app' and user_id is not null and admin_id is null)
    or (actor_type = 'admin' and admin_id is not null and user_id is null)
  )
);
create unique index if not exists idx_mfa_recovery_hash on mfa_recovery_codes (code_hash);
create index if not exists idx_mfa_recovery_user on mfa_recovery_codes (user_id, generation);
create index if not exists idx_mfa_recovery_admin on mfa_recovery_codes (admin_id, generation);

-- ---------------------------------------------------------------------------------------
-- Passkeys
-- ---------------------------------------------------------------------------------------

create table if not exists webauthn_credentials (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('app', 'admin')),
  user_id uuid references app_users(id) on delete cascade,
  admin_id bigint references admins(id) on delete cascade,
  -- base64url, as the WebAuthn spec and the library hand it to us.
  credential_id text not null check (char_length(credential_id) between 1 and 500),
  -- A public key is not a secret, but it is still credential material and is stored as
  -- bytes rather than re-encoded on every read.
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_type text check (device_type is null or device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  aaguid text check (aaguid is null or char_length(aaguid) <= 64),
  name text not null default 'Passkey' check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint webauthn_actor_owner check (
    (actor_type = 'app' and user_id is not null and admin_id is null)
    or (actor_type = 'admin' and admin_id is not null and user_id is null)
  )
);
-- Platform-wide unique: a credential id identifies one authenticator key pair, and the
-- same one being registered to two accounts would make discoverable login ambiguous.
create unique index if not exists idx_webauthn_credential_id on webauthn_credentials (credential_id);
create index if not exists idx_webauthn_user on webauthn_credentials (user_id);
create index if not exists idx_webauthn_admin on webauthn_credentials (admin_id);

-- Server-held challenges. The challenge is a public nonce, not a secret, but it is
-- single-use and short-lived: replaying one is how a captured assertion gets reused.
create table if not exists webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  actor_type text check (actor_type is null or actor_type in ('app', 'admin')),
  -- Null for a discoverable-credential login, where the user is not known until the
  -- authenticator answers.
  user_id uuid references app_users(id) on delete cascade,
  admin_id bigint references admins(id) on delete cascade,
  purpose text not null check (purpose in ('registration', 'authentication', 'step_up')),
  challenge text not null check (char_length(challenge) between 16 and 500),
  session_id uuid references auth_sessions(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint webauthn_challenge_expiry_future check (expires_at > created_at)
);
create unique index if not exists idx_webauthn_challenge_value on webauthn_challenges (challenge);
create index if not exists idx_webauthn_challenge_expiry on webauthn_challenges (expires_at);

-- ---------------------------------------------------------------------------------------
-- Tenant MFA policy
-- ---------------------------------------------------------------------------------------

-- The one A30 table that IS tenant data, so it gets organization_id, FORCE RLS and the
-- same tenant policy as every other tenant table.
create table if not exists organization_security_policies (
  organization_id uuid primary key references organizations(id) on delete cascade,
  require_mfa_for_owner boolean not null default false,
  require_mfa_for_admin boolean not null default false,
  updated_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table organization_security_policies enable row level security;
alter table organization_security_policies force row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'organization_security_policies'
      and policyname = 'organization_security_policies_tenant_policy'
  ) then
    create policy organization_security_policies_tenant_policy on organization_security_policies
      using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
      with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
  end if;
end $$;

comment on table auth_sessions is
  'A30 device sessions for both actor types. Refresh rotation stays within one session; mfa_level and step_up_verified_at here are the authority for assurance checks, not any token claim.';
comment on table user_mfa_methods is
  'A30 MFA factors. The TOTP secret is ENCRYPTED (not hashed) because verification recomputes the code from it; last_used_step is what stops a code being replayed inside its own time window.';
comment on table mfa_recovery_codes is
  'A30 recovery codes, hash-only and single-use. Regenerating bumps `generation`, which invalidates every unused code from the previous one.';
