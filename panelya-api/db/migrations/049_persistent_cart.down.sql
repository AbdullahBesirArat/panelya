-- customer_accounts_org_id_key is owned by an earlier migration (returns already
-- reference it), so 049 must not drop it here; only the cart tables are removed.
drop table if exists cart_recovery_outbox;
drop table if exists cart_events;
drop table if exists cart_items;
drop table if exists carts;
