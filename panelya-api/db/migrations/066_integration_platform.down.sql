-- Rollback A29 (1/2). Nothing outside these tables is touched: integration events are a
-- record OF business changes, never the changes themselves, so removing them returns the
-- platform to its pre-A29 behaviour without affecting a single order, product or theme.

drop table if exists webhook_deliveries cascade;
drop table if exists webhook_endpoint_secrets cascade;
drop table if exists webhook_endpoint_events cascade;
drop table if exists webhook_endpoints cascade;
drop table if exists integration_events cascade;
drop table if exists api_idempotency_keys cascade;
drop table if exists api_keys cascade;
