-- Rollback A26 (2/2). Drop in dependency order: overrides and change requests reference
-- subscriptions/plan_versions, invoices and events reference subscriptions.
drop table if exists subscription_overrides cascade;
drop table if exists plan_change_requests cascade;
drop table if exists subscription_invoices cascade;
drop table if exists billing_events cascade;
