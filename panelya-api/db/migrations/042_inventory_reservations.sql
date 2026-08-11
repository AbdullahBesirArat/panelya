-- A14: expiring, idempotent inventory reservations for checkout concurrency.

alter table orders no force row level security;
alter table order_items no force row level security;
alter table products no force row level security;
alter table product_variants no force row level security;
alter table inventory_movements no force row level security;

alter table orders
  add column if not exists checkout_idempotency_key text,
  add column if not exists payment_page_url text;
create unique index if not exists idx_orders_org_checkout_idempotency
  on orders (organization_id, checkout_idempotency_key)
  where checkout_idempotency_key is not null;

create table if not exists inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  order_id bigint not null,
  customer_id bigint,
  guest_reference_hash text,
  status text not null default 'active'
    check (status in ('active', 'consumed', 'released', 'expired')),
  expires_at timestamptz not null,
  idempotency_key text,
  consumed_at timestamptz,
  released_at timestamptz,
  restocked_at timestamptz,
  revision integer not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_reservations_order_org_fk
    foreign key (organization_id, order_id)
    references orders (organization_id, id)
    on delete cascade,
  constraint inventory_reservations_customer_org_fk
    foreign key (organization_id, customer_id)
    references customers (organization_id, id)
    on delete set null (customer_id),
  unique (organization_id, id),
  unique (organization_id, order_id)
);

create unique index if not exists idx_inventory_reservations_org_idempotency
  on inventory_reservations (organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_inventory_reservations_expiry
  on inventory_reservations (expires_at, id)
  where status = 'active';

create table if not exists inventory_reservation_items (
  organization_id uuid not null,
  reservation_id uuid not null,
  variant_id bigint not null,
  quantity integer not null check (quantity > 0),
  unit_price_snapshot numeric(12,2),
  created_at timestamptz not null default now(),
  primary key (reservation_id, variant_id),
  constraint inventory_reservation_items_reservation_org_fk
    foreign key (organization_id, reservation_id)
    references inventory_reservations (organization_id, id)
    on delete cascade,
  constraint inventory_reservation_items_variant_org_fk
    foreign key (organization_id, variant_id)
    references product_variants (organization_id, id)
    on delete restrict
);

create index if not exists idx_inventory_reservation_items_variant
  on inventory_reservation_items (organization_id, variant_id, reservation_id);

-- Orders created before A14 already consumed on-hand stock. Pending payments
-- are converted to an equivalent reservation (on_hand +q, reserved +q), so
-- available stock remains unchanged and expiry can safely release it.
insert into inventory_reservations
  (organization_id, order_id, customer_id, status, expires_at, idempotency_key,
   consumed_at, released_at, created_at, updated_at)
select o.organization_id, o.id, o.customer_id,
       case
         when o.status = 'payment_pending' then 'active'
         when o.status = 'cancelled' then 'released'
         else 'consumed'
       end,
       case when o.status = 'payment_pending'
         then o.created_at + interval '30 minutes'
         else o.created_at
       end,
       'legacy-order:' || o.id,
       case when o.status not in ('payment_pending', 'cancelled') then o.created_at end,
       case when o.status = 'cancelled' then o.updated_at end,
       o.created_at, o.updated_at
from orders o
where exists (
  select 1 from order_items oi
  where oi.organization_id = o.organization_id
    and oi.order_id = o.id
    and oi.product_id is not null
)
on conflict (organization_id, order_id) do nothing;

insert into inventory_reservation_items
  (organization_id, reservation_id, variant_id, quantity, unit_price_snapshot)
select r.organization_id, r.id, coalesce(oi.variant_id, default_variant.id),
       sum(oi.quantity)::integer,
       max(oi.unit_price)
from inventory_reservations r
join order_items oi
  on oi.organization_id = r.organization_id and oi.order_id = r.order_id
left join product_variants default_variant
  on default_variant.organization_id = oi.organization_id
 and default_variant.product_id = oi.product_id
 and default_variant.is_default
where oi.product_id is not null
  and coalesce(oi.variant_id, default_variant.id) is not null
group by r.organization_id, r.id, coalesce(oi.variant_id, default_variant.id)
on conflict (reservation_id, variant_id) do nothing;

with pending_quantities as (
  select item.organization_id, item.variant_id, sum(item.quantity)::integer as quantity
  from inventory_reservation_items item
  join inventory_reservations reservation
    on reservation.organization_id = item.organization_id
   and reservation.id = item.reservation_id
   and reservation.status = 'active'
  group by item.organization_id, item.variant_id
)
update product_variants variant
   set on_hand = variant.on_hand + pending.quantity,
       reserved = variant.reserved + pending.quantity,
       stock = variant.available,
       updated_at = now()
from pending_quantities pending
where variant.organization_id = pending.organization_id
  and variant.id = pending.variant_id;

insert into inventory_movements
  (organization_id, variant_id, movement_type, quantity_delta,
   on_hand_delta, reserved_delta, balance_after, on_hand_after,
   reserved_after, reference_type, reference_id, idempotency_key,
   reason, actor_type)
select item.organization_id, item.variant_id, 'reservation', 0,
       item.quantity, item.quantity, variant.available, variant.on_hand,
       variant.reserved, 'inventory_reservation', reservation.id::text,
       'reservation-backfill:' || reservation.id || ':variant:' || item.variant_id,
       'A14 pending-order reservation conversion', 'migration'
from inventory_reservation_items item
join inventory_reservations reservation
  on reservation.organization_id = item.organization_id
 and reservation.id = item.reservation_id
 and reservation.status = 'active'
join product_variants variant
  on variant.organization_id = item.organization_id and variant.id = item.variant_id
on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

create table if not exists inventory_worker_health (
  job_name text primary key,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error text,
  processed_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table inventory_reservations enable row level security;
alter table inventory_reservations force row level security;
alter table inventory_reservation_items enable row level security;
alter table inventory_reservation_items force row level security;
create policy inventory_reservations_tenant_policy on inventory_reservations
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy inventory_reservation_items_tenant_policy on inventory_reservation_items
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'panelya_runtime') then
    execute 'revoke all on inventory_worker_health from panelya_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'panelya_system_runtime') then
    execute 'grant select, insert, update on inventory_worker_health to panelya_system_runtime';
  end if;
end $$;

alter table orders force row level security;
alter table order_items force row level security;
alter table products force row level security;
alter table product_variants force row level security;
alter table inventory_movements force row level security;
