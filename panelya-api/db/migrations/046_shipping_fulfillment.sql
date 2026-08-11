-- A18: provider-independent shipping rates, multi-shipment fulfillment and labels.

create table if not exists shipping_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  provider text not null default 'manual' check (char_length(provider) between 2 and 80),
  is_default boolean not null default false,
  is_active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_profiles_org_id_key unique (organization_id, id)
);

create unique index if not exists idx_shipping_profiles_one_default
  on shipping_profiles (organization_id) where is_default and is_active;

create table if not exists shipping_zones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  shipping_profile_id uuid not null,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  countries text[] not null default array['TR']::text[],
  cities text[] not null default '{}'::text[],
  priority integer not null default 100 check (priority between 0 and 10000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_zones_org_id_key unique (organization_id, id),
  foreign key (organization_id, shipping_profile_id)
    references shipping_profiles (organization_id, id) on delete cascade
);

create index if not exists idx_shipping_zones_profile_priority
  on shipping_zones (organization_id, shipping_profile_id, priority, id);

create table if not exists shipping_zone_rules (
  id bigserial primary key,
  organization_id uuid not null,
  shipping_zone_id uuid not null,
  shipping_class text,
  min_subtotal numeric(12,2) not null default 0 check (min_subtotal >= 0),
  max_subtotal numeric(12,2) check (max_subtotal is null or max_subtotal >= min_subtotal),
  min_weight_kg numeric(12,3) not null default 0 check (min_weight_kg >= 0),
  max_weight_kg numeric(12,3) check (max_weight_kg is null or max_weight_kg >= min_weight_kg),
  min_desi numeric(12,3) not null default 0 check (min_desi >= 0),
  max_desi numeric(12,3) check (max_desi is null or max_desi >= min_desi),
  priority integer not null default 100 check (priority between 0 and 10000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_zone_rules_org_id_key unique (organization_id, id),
  foreign key (organization_id, shipping_zone_id)
    references shipping_zones (organization_id, id) on delete cascade
);

create table if not exists shipping_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  shipping_zone_rule_id bigint not null,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  calculation_type text not null check (calculation_type in ('flat','free_threshold','weight_band','provider_live')),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  per_kg_amount numeric(12,2) not null default 0 check (per_kg_amount >= 0),
  free_shipping_threshold numeric(12,2) check (free_shipping_threshold is null or free_shipping_threshold >= 0),
  currency char(3) not null default 'TRY',
  estimated_days_min integer check (estimated_days_min is null or estimated_days_min >= 0),
  estimated_days_max integer check (
    estimated_days_max is null or estimated_days_max >= coalesce(estimated_days_min, 0)
  ),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_rates_org_id_key unique (organization_id, id),
  foreign key (organization_id, shipping_zone_rule_id)
    references shipping_zone_rules (organization_id, id) on delete cascade
);

create table if not exists product_shipping_attributes (
  organization_id uuid not null,
  product_id bigint not null,
  weight_kg numeric(12,3) not null default 0 check (weight_kg >= 0),
  length_cm numeric(12,2) not null default 0 check (length_cm >= 0),
  width_cm numeric(12,2) not null default 0 check (width_cm >= 0),
  height_cm numeric(12,2) not null default 0 check (height_cm >= 0),
  desi numeric(12,3) not null default 0 check (desi >= 0),
  shipping_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, product_id),
  foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade
);

create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id bigint not null,
  provider text not null default 'manual',
  provider_shipment_ref text,
  status text not null default 'pending' check (status in (
    'pending','label_ready','shipped','in_transit','delivered','failed','cancelled','returned'
  )),
  carrier_name text not null default '',
  service_name text not null default '',
  tracking_number text not null default '',
  tracking_url text not null default '',
  package_weight_kg numeric(12,3) not null default 0 check (package_weight_kg >= 0),
  package_length_cm numeric(12,2) not null default 0 check (package_length_cm >= 0),
  package_width_cm numeric(12,2) not null default 0 check (package_width_cm >= 0),
  package_height_cm numeric(12,2) not null default 0 check (package_height_cm >= 0),
  package_desi numeric(12,3) not null default 0 check (package_desi >= 0),
  rate_snapshot jsonb not null default '{}'::jsonb,
  estimated_delivery_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  return_of_shipment_id uuid,
  return_request_id uuid,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipments_org_id_key unique (organization_id, id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict,
  foreign key (organization_id, return_of_shipment_id)
    references shipments (organization_id, id) on delete restrict,
  foreign key (organization_id, return_request_id)
    references return_requests (organization_id, id) on delete restrict
);

create index if not exists idx_shipments_org_order_created
  on shipments (organization_id, order_id, created_at desc);
create index if not exists idx_shipments_org_tracking
  on shipments (organization_id, provider, tracking_number) where tracking_number <> '';

create table if not exists shipment_items (
  id bigserial primary key,
  organization_id uuid not null,
  shipment_id uuid not null,
  order_item_id bigint not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  constraint shipment_items_org_id_key unique (organization_id, id),
  constraint shipment_items_shipment_order_item_key unique (shipment_id, order_item_id),
  foreign key (organization_id, shipment_id)
    references shipments (organization_id, id) on delete cascade,
  foreign key (organization_id, order_item_id)
    references order_items (organization_id, id) on delete restrict
);

create table if not exists shipment_events (
  id bigserial primary key,
  organization_id uuid not null,
  shipment_id uuid not null,
  event_type text not null check (char_length(event_type) between 2 and 80),
  from_status text,
  to_status text,
  actor_type text not null check (actor_type in ('staff','system','carrier','customer')),
  actor_id text,
  public_message text,
  metadata jsonb not null default '{}'::jsonb,
  provider_event_key text,
  created_at timestamptz not null default now(),
  constraint shipment_events_org_id_key unique (organization_id, id),
  foreign key (organization_id, shipment_id)
    references shipments (organization_id, id) on delete restrict
);

create unique index if not exists idx_shipment_events_provider_key
  on shipment_events (organization_id, shipment_id, provider_event_key)
  where provider_event_key is not null;

create table if not exists shipping_labels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  shipment_id uuid not null,
  upload_asset_id uuid,
  provider_label_ref text,
  filename text not null default 'kargo-etiketi',
  content_type text not null default 'application/octet-stream',
  created_at timestamptz not null default now(),
  constraint shipping_labels_org_id_key unique (organization_id, id),
  foreign key (organization_id, shipment_id)
    references shipments (organization_id, id) on delete cascade,
  foreign key (organization_id, upload_asset_id)
    references upload_assets (organization_id, id) on delete restrict
);

create table if not exists carrier_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  event_key text not null,
  shipment_id uuid,
  status text not null default 'processing' check (status in ('processing','processed','ignored','failed')),
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint carrier_webhook_events_org_key unique (organization_id, provider, event_key),
  foreign key (organization_id, shipment_id)
    references shipments (organization_id, id) on delete set null (shipment_id)
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'shipping_profiles','shipping_zones','shipping_zone_rules','shipping_rates',
    'product_shipping_attributes','shipments','shipment_items','shipment_events',
    'shipping_labels','carrier_webhook_events'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
      table_name || '_tenant_policy', table_name
    );
  end loop;
end $$;

create or replace function panelya_block_shipment_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'shipment_events are append-only' using errcode = '42501';
end;
$$;

create trigger trg_shipment_events_append_only
before update or delete on shipment_events
for each row execute function panelya_block_shipment_event_mutation();

