-- A17: tenant-safe cancellations, returns, exchanges and refund accounting.

alter table orders no force row level security;

alter table orders
  add column if not exists tax_total numeric(12,2) not null default 0 check (tax_total >= 0),
  add column if not exists refunded_total numeric(12,2) not null default 0 check (refunded_total >= 0);

do $$
declare
  table_name text;
  constraint_name text;
begin
  foreach table_name in array array['customer_accounts','order_items','upload_assets'] loop
    constraint_name := table_name || '_org_id_key';
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('%I', table_name)::regclass
         and conname = constraint_name
    ) then
      execute format('alter table %I add constraint %I unique (organization_id, id)', table_name, constraint_name);
    end if;
  end loop;
end $$;

create table if not exists return_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id bigint not null,
  customer_account_id bigint,
  request_type text not null check (request_type in ('return','exchange','cancellation')),
  status text not null default 'requested' check (status in (
    'requested','approved','rejected','awaiting_shipment','in_transit','received',
    'inspected','resolved','cancelled'
  )),
  reason_code text not null check (char_length(btrim(reason_code)) between 2 and 80),
  customer_note text not null default '' check (char_length(customer_note) <= 2000),
  internal_note text not null default '' check (char_length(internal_note) <= 4000),
  requested_at timestamptz not null default now(),
  return_deadline timestamptz,
  approved_at timestamptz,
  approved_by uuid references app_users(id) on delete set null,
  rejected_at timestamptz,
  rejected_by uuid references app_users(id) on delete set null,
  rejection_reason text,
  received_at timestamptz,
  inspected_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  return_shipping_code text,
  return_instructions text,
  replacement_order_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint return_requests_org_id_key unique (organization_id, id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict,
  foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete set null (customer_account_id),
  foreign key (organization_id, replacement_order_id)
    references orders (organization_id, id) on delete restrict
);

create index if not exists idx_return_requests_org_status_requested
  on return_requests (organization_id, status, requested_at desc);
create index if not exists idx_return_requests_customer
  on return_requests (organization_id, customer_account_id, requested_at desc);

create table if not exists return_items (
  id bigserial primary key,
  organization_id uuid not null,
  return_request_id uuid not null,
  order_item_id bigint not null,
  quantity integer not null check (quantity > 0),
  reason_code text not null check (char_length(btrim(reason_code)) between 2 and 80),
  item_condition text check (item_condition is null or item_condition in (
    'unopened','unused','used','damaged','defective','other'
  )),
  requested_resolution text not null check (requested_resolution in ('refund','exchange','store_credit')),
  received_quantity integer not null default 0 check (received_quantity >= 0 and received_quantity <= quantity),
  restock_quantity integer not null default 0 check (restock_quantity >= 0 and restock_quantity <= received_quantity),
  replacement_variant_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint return_items_org_id_key unique (organization_id, id),
  constraint return_items_request_order_item_key unique (return_request_id, order_item_id),
  foreign key (organization_id, return_request_id)
    references return_requests (organization_id, id) on delete cascade,
  foreign key (organization_id, order_item_id)
    references order_items (organization_id, id) on delete restrict,
  foreign key (organization_id, replacement_variant_id)
    references product_variants (organization_id, id) on delete restrict
);

create index if not exists idx_return_items_org_request
  on return_items (organization_id, return_request_id);

create table if not exists return_media (
  organization_id uuid not null,
  return_request_id uuid not null,
  upload_asset_id uuid not null,
  attached_at timestamptz not null default now(),
  primary key (return_request_id, upload_asset_id),
  foreign key (organization_id, return_request_id)
    references return_requests (organization_id, id) on delete cascade,
  foreign key (organization_id, upload_asset_id)
    references upload_assets (organization_id, id) on delete restrict
);

create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id bigint not null,
  return_request_id uuid,
  provider text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'TRY',
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed','cancelled')),
  provider_ref text,
  idempotency_key text not null,
  reason text not null default '' check (char_length(reason) <= 1000),
  requested_by uuid references app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  failure_message text,
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refunds_org_id_key unique (organization_id, id),
  constraint refunds_org_idempotency_key unique (organization_id, idempotency_key),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict,
  foreign key (organization_id, return_request_id)
    references return_requests (organization_id, id) on delete restrict
);

create index if not exists idx_refunds_org_order
  on refunds (organization_id, order_id, requested_at desc);

create table if not exists refund_allocations (
  id bigserial primary key,
  organization_id uuid not null,
  refund_id uuid not null,
  order_item_id bigint,
  allocation_type text not null check (allocation_type in ('item','shipping','tax','discount')),
  amount numeric(12,2) not null check (amount >= 0),
  quantity integer check (quantity is null or quantity > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint refund_allocations_org_id_key unique (organization_id, id),
  foreign key (organization_id, refund_id)
    references refunds (organization_id, id) on delete cascade,
  foreign key (organization_id, order_item_id)
    references order_items (organization_id, id) on delete restrict
);

create table if not exists return_events (
  id bigserial primary key,
  organization_id uuid not null,
  return_request_id uuid not null,
  event_type text not null check (char_length(event_type) between 3 and 80),
  from_status text,
  to_status text,
  actor_type text not null check (actor_type in ('customer','staff','system','payment_provider')),
  actor_id text,
  public_message text,
  internal_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint return_events_org_id_key unique (organization_id, id),
  foreign key (organization_id, return_request_id)
    references return_requests (organization_id, id) on delete restrict
);

create index if not exists idx_return_events_org_request
  on return_events (organization_id, return_request_id, created_at, id);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'return_requests','return_items','return_media','refunds','refund_allocations','return_events'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
      table_name || '_tenant_policy', table_name
    );
  end loop;
end $$;

create or replace function panelya_block_return_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'return_events are append-only' using errcode = '42501';
end;
$$;

create trigger trg_return_events_append_only
before update or delete on return_events
for each row execute function panelya_block_return_event_mutation();

alter table orders force row level security;
