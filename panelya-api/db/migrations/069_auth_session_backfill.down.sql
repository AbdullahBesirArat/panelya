-- Rollback the A30 backfill. Only the sessions this migration created are removed, and the
-- refresh tokens themselves are untouched — so a rollback does not log anybody out either.

with detached as (
  update refresh_tokens rt
     set session_id = null
    from auth_sessions s
   where rt.session_id = s.id
     and rt.id = s.id
     and s.session_family_id = s.id
     and s.device_label = 'Mevcut oturum'
     and s.created_auth_method = 'password'
  returning s.id
)
delete from auth_sessions s
 using detached d
 where s.id = d.id;
