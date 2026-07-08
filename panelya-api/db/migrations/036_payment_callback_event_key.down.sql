-- Rollback 036_payment_callback_event_key.sql
drop index if exists uq_payment_callback_events_event_key;

alter table payment_callback_events
  drop column if exists event_key;
