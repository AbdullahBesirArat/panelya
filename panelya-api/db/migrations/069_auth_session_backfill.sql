-- A30 (2/2): give every still-valid refresh token a session, so shipping A30 does not log
-- anybody out.
--
-- Kept separate from 068 on purpose: 068 is structure, this is data. If the backfill ever
-- needs re-deriving it can be rolled back and re-applied without touching the tables.
--
-- What is NOT invented here: a device label, a user agent summary, an IP prefix. Those rows
-- predate A30 and we do not have that information — refresh_tokens stores a raw user agent
-- and an IP, but re-deriving a "summary" from them in SQL would mean inventing a parser in
-- the wrong language and pretending to a precision we do not have. Each backfilled session
-- is honestly labelled as an existing session and gains real metadata on its next refresh.
--
-- Assurance is deliberately the LOWEST level: these sessions authenticated with a password
-- before MFA existed, so they are `password`, never `mfa`. A super-admin holding one is
-- therefore sent through enrolment rather than being silently grandfathered past the very
-- policy this stage introduces.

insert into auth_sessions (
  id, actor_type, user_id, session_family_id, created_at, last_seen_at, expires_at,
  device_label, mfa_level, created_auth_method
)
select
  -- Reuse the refresh row's UUID as the session UUID. This gives the following UPDATE an
  -- exact one-to-one key and avoids an ambiguous timestamp join when two legacy logins
  -- happened in the same clock tick.
  rt.id,
  'app',
  rt.user_id,
  rt.id,
  rt.created_at,
  coalesce(rt.last_used_at, rt.created_at),
  rt.expires_at,
  'Mevcut oturum',
  'password',
  'password'
from refresh_tokens rt
where rt.revoked_at is null
  and rt.expires_at > now()
  and rt.session_id is null
  and exists (select 1 from app_users u where u.id = rt.user_id)
on conflict (id) do nothing;

update refresh_tokens rt
   set session_id = rt.id
 where rt.session_id is null
   and rt.revoked_at is null
   and rt.expires_at > now()
   and exists (
     select 1 from auth_sessions s
      where s.id = rt.id and s.user_id = rt.user_id
        and s.device_label = 'Mevcut oturum'
   );

-- Super-admin sessions are NOT backfilled, and cannot be: pre-A30 the platform console
-- issued an access token with no refresh token and no server-side session at all, so there
-- is nothing to attach. Those short-lived tokens simply expire, and the next login creates
-- a real session. No admin loses data, and none is grandfathered past MFA enrolment.

comment on column refresh_tokens.session_id is
  'A30. Every rotated refresh token stays in the same auth_session, so revoking a device is one row rather than a guess about which token is current.';
