-- A21: server-canonical persistent carts, guest->customer merge and consent-gated
-- abandoned-cart recovery. All tables are tenant-scoped with FORCE RLS and
-- tenant-aware composite foreign keys. Guest identity is a hashed opaque token;
-- raw tokens never touch the database.

-- carts reference customer_accounts tenant-safely, so that parent needs a
-- composite unique key. Guarded so a direct re-run stays idempotent.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'customer_accounts_org_id_key'
       and conrelid = 'customer_accounts'::regclass
  ) then
    alter table customer_accounts add constraint customer_accounts_org_id_key unique (organization_id, id);
  end if;
end $$;

create table if not exists carts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_account_id bigint,
  guest_token_hash char(64) check (guest_token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active','converted','abandoned','expired','merged','cancelled')),
  currency char(3) not null default 'TRY' check (currency = 'TRY'),
  version integer not null default 1 check (version >= 1),
  item_count integer not null default 0 check (item_count >= 0 and item_count <= 5000),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount_total numeric(12,2) not null default 0 check (discount_total >= 0),
  shipping_total numeric(12,2) not null default 0 check (shipping_total >= 0),
  tax_total numeric(12,2) not null default 0 check (tax_total >= 0),
  grand_total numeric(12,2) not null default 0 check (grand_total >= 0),
  coupon_code text check (coupon_code is null or char_length(coupon_code) <= 64),
  pricing_snapshot jsonb not null default '{}'::jsonb
    check (octet_length(pricing_snapshot::text) <= 32768),
  contact_email text check (contact_email is null or char_length(contact_email) <= 320),
  recovery_consent boolean not null default false,
  recovery_sent_count integer not null default 0 check (recovery_sent_count >= 0),
  last_recovery_at timestamptz,
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  abandoned_at timestamptz,
  recovered_at timestamptz,
  converted_order_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carts_org_id_key unique (organization_id, id),
  constraint carts_owner_present check (customer_account_id is not null or guest_token_hash is not null),
  constraint carts_customer_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete cascade,
  constraint carts_converted_order_fk foreign key (organization_id, converted_order_id)
    references orders (organization_id, id) on delete set null
);

create unique index if not exists idx_carts_guest_token
  on carts (organization_id, guest_token_hash) where guest_token_hash is not null;
create unique index if not exists idx_carts_active_customer
  on carts (organization_id, customer_account_id)
  where status = 'active' and customer_account_id is not null;
create index if not exists idx_carts_org_status_activity
  on carts (organization_id, status, last_activity_at desc);
create index if not exists idx_carts_abandon_scan
  on carts (status, last_activity_at) where status = 'active';
create index if not exists idx_carts_expiry_scan
  on carts (status, expires_at) where status in ('active','abandoned');

create table if not exists cart_items (
  id bigserial primary key,
  organization_id uuid not null,
  cart_id uuid not null,
  product_id bigint not null,
  variant_id bigint not null,
  quantity integer not null check (quantity between 1 and 99),
  unit_price_snapshot numeric(12,2) not null check (unit_price_snapshot >= 0),
  discount_snapshot numeric(12,2) not null default 0 check (discount_snapshot >= 0),
  tax_rate_snapshot numeric(7,4) not null default 0 check (tax_rate_snapshot between 0 and 1),
  line_total_snapshot numeric(12,2) not null default 0 check (line_total_snapshot >= 0),
  product_name_snapshot text not null default '',
  sku_snapshot text not null default '',
  color_snapshot text not null default '',
  size_snapshot text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cart_items_org_id_key unique (organization_id, id),
  constraint cart_items_cart_variant_key unique (organization_id, cart_id, variant_id),
  constraint cart_items_cart_fk foreign key (organization_id, cart_id)
    references carts (organization_id, id) on delete cascade,
  constraint cart_items_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade,
  constraint cart_items_variant_fk foreign key (organization_id, variant_id)
    references product_variants (organization_id, id) on delete cascade
);

create index if not exists idx_cart_items_cart on cart_items (organization_id, cart_id);

create table if not exists cart_events (
  id bigserial primary key,
  organization_id uuid not null,
  cart_id uuid not null,
  customer_account_id bigint,
  event_type text not null check (event_type in (
    'created','item_added','item_updated','item_removed','cleared',
    'coupon_applied','coupon_removed','merged','converted',
    'abandoned','recovery_sent','recovered','expired','cancelled'
  )),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 8192),
  occurred_at timestamptz not null default now(),
  constraint cart_events_org_id_key unique (organization_id, id),
  constraint cart_events_cart_fk foreign key (organization_id, cart_id)
    references carts (organization_id, id) on delete cascade
);

create index if not exists idx_cart_events_cart on cart_events (organization_id, cart_id, occurred_at desc);

-- Provider-independent recovery outbox. A23 will attach a real delivery adapter;
-- until then rows are persisted with a clean sent/failed/suppressed contract.
create table if not exists cart_recovery_outbox (
  id bigserial primary key,
  organization_id uuid not null,
  cart_id uuid not null,
  event_id bigint not null,
  channel text not null default 'email' check (channel in ('email')),
  status text not null default 'pending'
    check (status in ('pending','processing','sent','failed','suppressed')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 10),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 16384),
  recovery_token_hash char(64) check (recovery_token_hash ~ '^[0-9a-f]{64}$'),
  recovery_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  suppressed_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cart_recovery_outbox_org_id_key unique (organization_id, id),
  constraint cart_recovery_outbox_event_channel_key unique (event_id, channel),
  constraint cart_recovery_outbox_cart_fk foreign key (organization_id, cart_id)
    references carts (organization_id, id) on delete cascade,
  constraint cart_recovery_outbox_event_fk foreign key (organization_id, event_id)
    references cart_events (organization_id, id) on delete cascade
);

create index if not exists idx_cart_recovery_delivery
  on cart_recovery_outbox (status, next_attempt_at, id)
  where status in ('pending','failed','processing');
create unique index if not exists idx_cart_recovery_token
  on cart_recovery_outbox (recovery_token_hash) where recovery_token_hash is not null;

do $$
declare table_name text;
begin
  foreach table_name in array array['carts','cart_items','cart_events','cart_recovery_outbox'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    if not exists (
      select 1 from pg_policies where schemaname = 'public'
        and tablename = table_name and policyname = table_name || '_tenant_policy'
    ) then
      execute format(
        'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
        table_name || '_tenant_policy', table_name
      );
    end if;
  end loop;
end $$;

comment on table carts is
  'A21 server-canonical cart; prices recalculated server-side, guest identity hashed, one active cart per customer/guest per tenant.';
