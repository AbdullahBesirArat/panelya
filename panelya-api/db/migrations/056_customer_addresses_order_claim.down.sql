-- Rollback A25. Table drops cascade their policies. orders.customer_account_id is
-- additive and nullable, so dropping it is safe; the FORCE RLS toggle mirrors the up
-- migration so the constraint/column changes run as the migrator.
drop table if exists order_account_claim_tokens cascade;
drop table if exists customer_addresses cascade;

alter table orders no force row level security;
drop index if exists idx_orders_org_customer_account;
alter table orders drop constraint if exists orders_customer_account_org_fk;
alter table orders drop column if exists customer_account_id;
alter table orders force row level security;
