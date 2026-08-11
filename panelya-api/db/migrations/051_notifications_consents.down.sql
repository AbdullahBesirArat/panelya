-- Rollback A23 notifications/consents. Drop children first; table drops cascade policies.
drop table if exists notification_deliveries cascade;
drop table if exists notification_outbox cascade;
drop table if exists notification_subscriptions cascade;
drop table if exists communication_consent_events cascade;
drop table if exists communication_consents cascade;
drop table if exists communication_suppressions cascade;
