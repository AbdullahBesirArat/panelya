alter table if exists admins
  add column if not exists role text not null default 'admin';

alter table if exists admins
  drop constraint if exists admins_role_check;

alter table if exists admins
  add constraint admins_role_check
  check (role in ('super_admin', 'admin', 'viewer'));
