-- Rollback 032_platform_store_management.sql
-- NOT: 'setup'/'archived' statuslu kayit varsa once onlari guvenli bir statuye tasiyin,
-- aksi halde eski constraint geri eklenirken hata verir.

update organizations set status = 'active' where status in ('setup', 'archived');

alter table organizations drop constraint if exists organizations_status_check;
alter table organizations
  add constraint organizations_status_check
  check (status in ('active', 'trialing', 'past_due', 'suspended', 'cancelled'));

drop index if exists idx_organizations_domain;
drop index if exists idx_organizations_owner_user;
drop index if exists idx_organizations_status;

alter table organizations
  drop column if exists metadata,
  drop column if exists archived_at,
  drop column if exists suspended_at,
  drop column if exists setup_completed_at,
  drop column if exists owner_user_id,
  drop column if exists storefront_url,
  drop column if exists domain;
