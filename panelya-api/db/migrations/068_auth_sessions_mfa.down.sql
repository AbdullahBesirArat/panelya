-- Rollback A30 (1/2). refresh_tokens keeps every row and its original shape, so removing
-- these tables returns the platform to pre-A30 auth without logging anybody out: sessions
-- were layered ON refresh tokens, never a replacement for them.

alter table refresh_tokens drop column if exists session_id;

drop table if exists organization_security_policies cascade;
drop table if exists webauthn_challenges cascade;
drop table if exists webauthn_credentials cascade;
drop table if exists mfa_recovery_codes cascade;
drop table if exists user_mfa_methods cascade;
drop table if exists auth_sessions cascade;
