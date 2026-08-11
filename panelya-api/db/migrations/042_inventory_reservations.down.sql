alter table products no force row level security;
alter table product_variants no force row level security;
alter table inventory_movements no force row level security;
alter table inventory_reservations no force row level security;
alter table inventory_reservation_items no force row level security;

with active_quantities as (
  select item.organization_id, item.variant_id, sum(item.quantity)::integer as quantity
  from inventory_reservation_items item
  join inventory_reservations reservation
    on reservation.organization_id = item.organization_id
   and reservation.id = item.reservation_id
   and reservation.status = 'active'
  group by item.organization_id, item.variant_id
)
update product_variants variant
   set on_hand = variant.on_hand - active.quantity,
       reserved = variant.reserved - active.quantity,
       stock = variant.available,
       updated_at = now()
from active_quantities active
where variant.organization_id = active.organization_id
  and variant.id = active.variant_id;

drop table if exists inventory_reservation_items;
drop table if exists inventory_reservations;
drop table if exists inventory_worker_health;

drop index if exists idx_orders_org_checkout_idempotency;
alter table orders
  drop column if exists payment_page_url,
  drop column if exists checkout_idempotency_key;

alter table products force row level security;
alter table product_variants force row level security;
alter table inventory_movements force row level security;
