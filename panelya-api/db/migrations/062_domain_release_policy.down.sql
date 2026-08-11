-- Rollback the A27 release-policy tightening. Released rows are removed first: the 061
-- status CHECK has no 'released' value, and the narrower claim index would also collide
-- if two tenants both hold a released row for the same hostname.
alter table custom_domains no force row level security;
delete from custom_domains where status = 'released';
alter table custom_domains force row level security;

drop index if exists idx_custom_domains_hostname_claimed;
create unique index idx_custom_domains_hostname_claimed
  on custom_domains (hostname)
  where status in ('pending_verification', 'verified', 'provisioning', 'active');

alter table custom_domains drop constraint if exists custom_domains_status_check;
alter table custom_domains add constraint custom_domains_status_check
  check (status in (
    'pending_verification', 'verified', 'provisioning', 'active', 'failed', 'disabled'
  ));
