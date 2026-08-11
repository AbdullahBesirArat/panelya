-- Rollback A26 (3/3). Remove the lifecycle rows before narrowing the domain back, or the
-- restored CHECK would fail its validation scan. notification_outbox is FORCE RLS and the
-- migrator is deliberately not a member of panelya_rls_bypass, so RLS is unforced for the
-- table owner inside this transaction and restored immediately (same approach as 057).
alter table notification_outbox no force row level security;
delete from notification_outbox
 where event_type in ('trial_reminder', 'trial_expired', 'subscription_past_due', 'subscription_suspended');
alter table notification_outbox force row level security;

alter table notification_outbox drop constraint if exists notification_outbox_event_type_check;
alter table notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in ('back_in_stock', 'price_drop', 'favorite_update', 'subscription_opt_in'));

delete from inventory_worker_health where job_name = 'subscription_lifecycle';
