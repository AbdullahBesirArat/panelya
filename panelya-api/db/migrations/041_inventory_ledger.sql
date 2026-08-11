-- A13: canonical variant inventory, tenant-unique SKU and append-only ledger.
-- Existing product stock mismatches are recorded without copying names/PII.

alter table products no force row level security;
alter table product_variants no force row level security;

alter table product_variants
  add column if not exists is_default boolean not null default false,
  add column if not exists on_hand integer,
  add column if not exists reserved integer not null default 0,
  add column if not exists incoming integer not null default 0,
  add column if not exists low_stock_threshold integer not null default 0;

update product_variants
   set on_hand = stock
 where on_hand is null;

alter table product_variants
  alter column on_hand set not null,
  alter column on_hand set default 0,
  add constraint product_variants_on_hand_nonnegative check (on_hand >= 0),
  add constraint product_variants_reserved_valid check (reserved >= 0 and reserved <= on_hand),
  add constraint product_variants_incoming_nonnegative check (incoming >= 0),
  add constraint product_variants_low_stock_nonnegative check (low_stock_threshold >= 0);

alter table product_variants
  add column if not exists available integer generated always as (on_hand - reserved) stored;

alter table product_variants alter column sku drop not null;
alter table product_variants alter column sku drop default;
update product_variants set sku = null where btrim(sku) = '';
alter table product_variants
  add column if not exists normalized_sku text
  generated always as (nullif(lower(btrim(sku)), '')) stored;

do $$
declare duplicate_count integer;
begin
  select count(*) into duplicate_count
  from (
    select organization_id, normalized_sku
    from product_variants
    where normalized_sku is not null
    group by organization_id, normalized_sku
    having count(*) > 1
  ) duplicates;
  if duplicate_count > 0 then
    raise exception 'A13: % tenant-scoped normalized SKU collisions require remediation', duplicate_count;
  end if;
end $$;

create unique index if not exists idx_product_variants_org_normalized_sku
  on product_variants (organization_id, normalized_sku)
  where normalized_sku is not null;

create unique index if not exists idx_product_variants_one_default
  on product_variants (organization_id, product_id)
  where is_default;

create table if not exists inventory_migration_anomalies (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id bigint not null,
  product_stock integer not null,
  active_variant_available integer not null,
  anomaly_type text not null check (anomaly_type in ('legacy_variant_total_mismatch')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, product_id, anomaly_type)
);

insert into inventory_migration_anomalies
  (organization_id, product_id, product_stock, active_variant_available, anomaly_type)
select p.organization_id, p.id, p.stock,
       coalesce(sum(v.available) filter (where v.is_active), 0)::integer,
       'legacy_variant_total_mismatch'
from products p
join product_variants v
  on v.organization_id = p.organization_id and v.product_id = p.id
group by p.organization_id, p.id, p.stock
having p.stock <> coalesce(sum(v.available) filter (where v.is_active), 0)::integer
on conflict (organization_id, product_id, anomaly_type) do nothing;

-- A sole blank option is the legacy representation of a non-variant product.
update product_variants target
   set is_default = true
 where btrim(target.color) = ''
   and btrim(target.size) = ''
   and not exists (
     select 1 from product_variants sibling
     where sibling.organization_id = target.organization_id
       and sibling.product_id = target.product_id
       and sibling.id <> target.id
   );

insert into product_variants
  (organization_id, product_id, color, size, sku, stock, status, is_active,
   is_default, on_hand, reserved, incoming, low_stock_threshold)
select p.organization_id, p.id, '', '', null, p.stock,
       case when p.stock > 0 then 'active' else 'out' end,
       true, true, p.stock, 0, 0, 0
from products p
where not exists (
  select 1 from product_variants v
  where v.organization_id = p.organization_id and v.product_id = p.id
);

create table if not exists inventory_movements (
  id bigserial primary key,
  organization_id uuid not null,
  variant_id bigint not null,
  movement_type text not null check (movement_type in (
    'initial', 'purchase', 'inbound', 'sale', 'return', 'adjustment',
    'reservation', 'reservation_release', 'cancellation', 'transfer'
  )),
  quantity_delta integer not null,
  on_hand_delta integer not null default 0,
  reserved_delta integer not null default 0,
  balance_after integer not null check (balance_after >= 0),
  on_hand_after integer not null check (on_hand_after >= 0),
  reserved_after integer not null check (reserved_after >= 0),
  reference_type text,
  reference_id text,
  idempotency_key text,
  reason text,
  actor_type text,
  actor_id text,
  created_at timestamptz not null default now(),
  constraint inventory_movements_variant_org_fk
    foreign key (organization_id, variant_id)
    references product_variants (organization_id, id)
    on delete restrict,
  constraint inventory_movements_reserved_balance_check
    check (reserved_after <= on_hand_after)
);

create unique index if not exists idx_inventory_movements_org_idempotency
  on inventory_movements (organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_inventory_movements_variant_created
  on inventory_movements (organization_id, variant_id, created_at desc, id desc);
create index if not exists idx_product_variants_catalog_available
  on product_variants (organization_id, product_id, is_active, status, available);

insert into inventory_movements
  (organization_id, variant_id, movement_type, quantity_delta, on_hand_delta,
   reserved_delta, balance_after, on_hand_after, reserved_after,
   reference_type, reference_id, idempotency_key, reason, actor_type)
select organization_id, id, 'initial', available, on_hand, reserved,
       available, on_hand, reserved, 'migration', '041',
       'initial:' || id, 'A13 canonical inventory backfill', 'migration'
from product_variants
on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

update product_variants
   set stock = available,
       status = case when available <= 0 then 'out' else status end;

update products p
   set stock = totals.available,
       status = case
         when totals.available <= 0 then 'out'
         when p.status = 'out' and totals.available > 0 then 'active'
         else p.status
       end,
       updated_at = now()
from (
  select organization_id, product_id,
         coalesce(sum(available) filter (where is_active), 0)::integer as available
  from product_variants
  group by organization_id, product_id
) totals
where p.organization_id = totals.organization_id and p.id = totals.product_id;

alter table inventory_migration_anomalies enable row level security;
alter table inventory_migration_anomalies force row level security;
alter table inventory_movements enable row level security;
alter table inventory_movements force row level security;

create policy inventory_migration_anomalies_tenant_policy on inventory_migration_anomalies
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy inventory_movements_tenant_policy on inventory_movements
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

alter table products force row level security;
alter table product_variants force row level security;

comment on column products.stock is
  'A13 compatibility read model: sum of active product_variants.available; do not write directly.';
comment on column product_variants.stock is
  'A13 compatibility read model mirroring available; use inventory movement service.';
