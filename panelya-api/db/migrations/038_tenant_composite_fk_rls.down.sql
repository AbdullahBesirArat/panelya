-- Safe expand rollback for A08. Tenant columns and their populated values are
-- retained so rollback never destroys attribution data. Old application code
-- can omit the new columns after NOT NULL is relaxed; reapplying 038 backfills
-- and validates them again.
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'products', 'product_variants', 'customers', 'orders',
    'order_items', 'collections', 'product_collections',
    'payment_callback_events'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format('alter table %I no force row level security', t);
    execute format('alter table %I disable row level security', t);
  end loop;
end $$;

drop function if exists app_rls_bypassed();

alter table if exists products drop constraint if exists products_category_org_fk;
alter table if exists product_variants drop constraint if exists product_variants_product_org_fk;
alter table if exists orders drop constraint if exists orders_customer_org_fk;
alter table if exists order_items drop constraint if exists order_items_order_org_fk;
alter table if exists order_items drop constraint if exists order_items_product_org_fk;
alter table if exists order_items drop constraint if exists order_items_variant_org_fk;
alter table if exists product_collections drop constraint if exists product_collections_collection_org_fk;
alter table if exists product_collections drop constraint if exists product_collections_product_org_fk;
alter table if exists customer_wishlist drop constraint if exists customer_wishlist_product_org_fk;
alter table if exists customer_accounts drop constraint if exists customer_accounts_customer_org_fk;
alter table if exists payment_callback_events drop constraint if exists payment_callback_events_order_org_fk;

alter table if exists categories drop constraint if exists categories_org_id_key;
alter table if exists products drop constraint if exists products_org_id_key;
alter table if exists customers drop constraint if exists customers_org_id_key;
alter table if exists orders drop constraint if exists orders_org_id_key;
alter table if exists collections drop constraint if exists collections_org_id_key;
alter table if exists product_variants drop constraint if exists product_variants_org_id_key;

alter table if exists order_items alter column organization_id drop not null;
alter table if exists payment_callback_events alter column organization_id drop not null;
