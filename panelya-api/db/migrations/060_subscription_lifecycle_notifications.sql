-- A26 (3/3): let the EXISTING A23 notification outbox carry subscription lifecycle
-- messages, instead of standing up a second queue with its own delivery, retry and
-- dead-letter semantics. Only the event_type domain is widened; the worker, the
-- idempotency key, the suppression gate and the retry/dead-letter behaviour are all
-- reused unchanged.
--
-- These are transactional/operational notices about the tenant's own account (their trial
-- is ending, their payment failed), not marketing, so they follow the same path as the
-- other account notices rather than being consent-gated as marketing.

alter table notification_outbox drop constraint if exists notification_outbox_event_type_check;
alter table notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in (
    'back_in_stock', 'price_drop', 'favorite_update', 'subscription_opt_in',
    'trial_reminder', 'trial_expired', 'subscription_past_due', 'subscription_suspended'
  ));

-- Worker health row, matching the existing inventory worker health pattern so the
-- lifecycle sweep is observable the same way the other workers are.
insert into inventory_worker_health (job_name)
select 'subscription_lifecycle'
where not exists (
  select 1 from inventory_worker_health where job_name = 'subscription_lifecycle'
);

comment on constraint notification_outbox_event_type_check on notification_outbox is
  'A26 widened this to carry subscription lifecycle notices through the A23 outbox rather than a second queue.';
