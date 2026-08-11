alter table products no force row level security;
alter table product_variants no force row level security;

update products p
   set stock = totals.available
from (
  select organization_id, product_id,
         coalesce(sum(available) filter (where is_active), 0)::integer as available
  from product_variants
  group by organization_id, product_id
) totals
where p.organization_id = totals.organization_id and p.id = totals.product_id;

drop table if exists inventory_movements;
drop table if exists inventory_migration_anomalies;
drop index if exists idx_product_variants_catalog_available;
drop index if exists idx_product_variants_one_default;
drop index if exists idx_product_variants_org_normalized_sku;

delete from product_variants pv
where pv.is_default
  and not exists (select 1 from order_items oi where oi.variant_id = pv.id);
update product_variants pv
   set is_active = false
 where pv.is_default
   and exists (select 1 from order_items oi where oi.variant_id = pv.id);

alter table product_variants
  drop constraint if exists product_variants_low_stock_nonnegative,
  drop constraint if exists product_variants_incoming_nonnegative,
  drop constraint if exists product_variants_reserved_valid,
  drop constraint if exists product_variants_on_hand_nonnegative,
  drop column if exists normalized_sku,
  drop column if exists available,
  drop column if exists low_stock_threshold,
  drop column if exists incoming,
  drop column if exists reserved,
  drop column if exists on_hand,
  drop column if exists is_default;

update product_variants set sku = '' where sku is null;
alter table product_variants alter column sku set default '';
alter table product_variants alter column sku set not null;

alter table products force row level security;
alter table product_variants force row level security;
