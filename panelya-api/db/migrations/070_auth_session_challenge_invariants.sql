-- A30 hard invariants added after the initial session/MFA schema audit.

-- One logical device session owns one family; many rotated refresh tokens may point at it,
-- but two session rows must never describe the same family.
drop index if exists idx_auth_sessions_family;
create unique index if not exists idx_auth_sessions_family
  on auth_sessions (session_family_id);

-- Discoverable-login challenges deliberately have no known owner/session. Registration and
-- step-up challenges are the opposite: both person- and session-bound. Encoding that split
-- in the schema prevents a future route from accidentally creating a transferable challenge.
alter table webauthn_challenges
  add constraint webauthn_challenges_binding check (
    (
      purpose = 'authentication'
      and actor_type is null and user_id is null and admin_id is null and session_id is null
    )
    or
    (
      purpose in ('registration', 'step_up')
      and session_id is not null
      and (
        (actor_type = 'app' and user_id is not null and admin_id is null)
        or (actor_type = 'admin' and admin_id is not null and user_id is null)
      )
    )
  );

