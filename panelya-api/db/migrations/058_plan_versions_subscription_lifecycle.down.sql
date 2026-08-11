-- Rollback A26 (1/2). plan_limits was never dropped, so restoring the legacy shape is
-- just a matter of removing what this migration added and putting the 005 status CHECK
-- back. Rows in the new states are mapped to their nearest legacy equivalent first,
-- otherwise the narrowed CHECK would fail its validation scan.
update subscriptions set status = 'past_due' where status in ('grace_period', 'suspended');
update subscriptions set status = 'cancelled' where status = 'expired';

alter table subscriptions drop constraint if exists subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check
  check (status in ('trialing', 'active', 'past_due', 'cancelled', 'unpaid'));

alter table subscriptions
  drop constraint if exists subscriptions_suspension_reason_len,
  drop constraint if exists subscriptions_transition_reason_len;

drop index if exists idx_subscriptions_grace_scan;
drop index if exists idx_subscriptions_trial_scan;
drop index if exists idx_subscriptions_org_status;

alter table subscriptions
  drop column if exists last_transition_reason,
  drop column if exists last_transition_at,
  drop column if exists suspension_reason,
  drop column if exists suspended_at,
  drop column if exists grace_until,
  drop column if exists cancelled_at,
  drop column if exists trial_end,
  drop column if exists trial_start,
  drop column if exists plan_version_id;

drop table if exists organization_trials cascade;
drop table if exists plan_versions cascade;
