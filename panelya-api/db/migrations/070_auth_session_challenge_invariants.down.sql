alter table webauthn_challenges
  drop constraint if exists webauthn_challenges_binding;

drop index if exists idx_auth_sessions_family;
create index if not exists idx_auth_sessions_family
  on auth_sessions (session_family_id);

