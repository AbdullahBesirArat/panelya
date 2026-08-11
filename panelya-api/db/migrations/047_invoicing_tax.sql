-- A19: immutable invoice/tax snapshots and provider-independent e-document records.

create table if not exists organization_legal_profiles (
  organization_id uuid primary key references organizations(id) on delete cascade,
  legal_name text not null default '',
  tax_office text not null default '',
  tax_number text not null default '',
  address text not null default '',
  invoice_email text not null default '',
  price_tax_policy text not null default 'inclusive' check (price_tax_policy in ('inclusive','exclusive')),
  default_tax_rate numeric(7,4) not null default 0.20 check (default_tax_rate between 0 and 1),
  shipping_tax_rate numeric(7,4) not null default 0.20 check (shipping_tax_rate between 0 and 1),
  e_document_provider text not null default 'manual',
  provider_config_ref text,
  invoice_retention_years integer not null default 10 check (invoice_retention_years between 1 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customer_invoice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id bigint not null,
  profile_type text not null check (profile_type in ('individual','company')),
  full_name text not null default '',
  legal_name text not null default '',
  identity_kind text check (identity_kind is null or identity_kind in ('tckn','vkn')),
  identity_last4 char(4),
  identity_hash text,
  identity_ciphertext text,
  tax_office text not null default '',
  invoice_address text not null,
  email text not null,
  is_default boolean not null default true,
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_invoice_profiles_org_id_key unique (organization_id, id),
  foreign key (organization_id, customer_id)
    references customers (organization_id, id) on delete restrict
);

create unique index if not exists idx_customer_invoice_profile_default
  on customer_invoice_profiles (organization_id, customer_id) where is_default;

create table if not exists product_tax_settings (
  id bigserial primary key,
  organization_id uuid not null,
  product_id bigint not null,
  variant_id bigint,
  tax_rate numeric(7,4) not null check (tax_rate between 0 and 1),
  tax_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_tax_settings_org_id_key unique (organization_id, id),
  foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade,
  foreign key (organization_id, variant_id)
    references product_variants (organization_id, id) on delete cascade
);

create unique index if not exists idx_product_tax_default
  on product_tax_settings (organization_id, product_id) where variant_id is null;
create unique index if not exists idx_product_tax_variant
  on product_tax_settings (organization_id, product_id, variant_id) where variant_id is not null;

alter table orders no force row level security;
alter table order_items no force row level security;

alter table orders
  add column if not exists invoice_profile_id uuid,
  add column if not exists invoice_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists tax_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists net_total numeric(12,2) not null default 0 check (net_total >= 0),
  add column if not exists currency char(3) not null default 'TRY' check (currency = 'TRY'),
  add column if not exists invoice_retention_until timestamptz,
  add foreign key (organization_id, invoice_profile_id)
    references customer_invoice_profiles (organization_id, id) on delete restrict;

alter table order_items
  add column if not exists tax_rate numeric(7,4) not null default 0 check (tax_rate between 0 and 1),
  add column if not exists net_amount numeric(12,2) not null default 0 check (net_amount >= 0),
  add column if not exists tax_amount numeric(12,2) not null default 0 check (tax_amount >= 0),
  add column if not exists gross_amount numeric(12,2) not null default 0 check (gross_amount >= 0),
  add column if not exists discount_allocation numeric(12,2) not null default 0 check (discount_allocation >= 0),
  add column if not exists tax_snapshot jsonb not null default '{}'::jsonb;

update orders set net_total = greatest(total - tax_total, 0) where net_total = 0 and total > 0;
update order_items set gross_amount = unit_price * quantity, net_amount = unit_price * quantity
 where gross_amount = 0 and unit_price > 0;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id bigint not null,
  invoice_number text,
  invoice_type text not null default 'sale' check (invoice_type in ('sale','return','credit_note')),
  status text not null default 'draft' check (status in ('draft','processing','issued','cancelled','failed')),
  provider text not null default 'manual',
  provider_reference text,
  idempotency_key text not null,
  snapshot jsonb not null,
  net_total numeric(12,2) not null check (net_total >= 0),
  tax_total numeric(12,2) not null check (tax_total >= 0),
  gross_total numeric(12,2) not null check (gross_total >= 0),
  currency char(3) not null default 'TRY',
  issued_at timestamptz,
  cancelled_at timestamptz,
  retention_until timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_org_id_key unique (organization_id, id),
  constraint invoices_org_idempotency_key unique (organization_id, idempotency_key),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict
);

create unique index if not exists idx_invoices_org_number
  on invoices (organization_id, invoice_number) where invoice_number is not null;
create index if not exists idx_invoices_org_order on invoices (organization_id, order_id, created_at desc);

create table if not exists invoice_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  invoice_id uuid not null,
  document_type text not null check (document_type in ('pdf','ubl','xml','other')),
  storage_provider text not null,
  bucket_name text,
  object_key text not null,
  filename text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  checksum text not null,
  created_at timestamptz not null default now(),
  constraint invoice_documents_org_id_key unique (organization_id, id),
  constraint invoice_documents_object_key_key unique (object_key),
  foreign key (organization_id, invoice_id)
    references invoices (organization_id, id) on delete cascade
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'organization_legal_profiles','customer_invoice_profiles','product_tax_settings',
    'invoices','invoice_documents'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
      table_name || '_tenant_policy', table_name
    );
  end loop;
end $$;

create or replace function panelya_protect_invoice_snapshot()
returns trigger language plpgsql as $$
begin
  if new.invoice_snapshot is distinct from old.invoice_snapshot
     or new.tax_snapshot is distinct from old.tax_snapshot
     or new.invoice_profile_id is distinct from old.invoice_profile_id
     or new.net_total is distinct from old.net_total
     or new.tax_total is distinct from old.tax_total
     or new.currency is distinct from old.currency then
    raise exception 'order invoice and tax snapshot is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_orders_invoice_snapshot_immutable
before update on orders for each row execute function panelya_protect_invoice_snapshot();

create or replace function panelya_protect_order_item_tax_snapshot()
returns trigger language plpgsql as $$
begin
  if new.tax_rate is distinct from old.tax_rate
     or new.net_amount is distinct from old.net_amount
     or new.tax_amount is distinct from old.tax_amount
     or new.gross_amount is distinct from old.gross_amount
     or new.discount_allocation is distinct from old.discount_allocation
     or new.tax_snapshot is distinct from old.tax_snapshot then
    raise exception 'order item tax snapshot is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_order_items_tax_snapshot_immutable
before update on order_items for each row execute function panelya_protect_order_item_tax_snapshot();

alter table orders force row level security;
alter table order_items force row level security;

