-- A25: customer address book + secure guest-order -> account linking.
--
-- Ownership decision: customer_addresses is keyed on customer_account_id (the
-- authenticated storefront account), matching recently_viewed / comparison /
-- wishlist / reviews. The CRM `customers` row can exist without an account (guest
-- checkout), so it is not a safe owner for account-scoped, session-authorized data.
--
-- Orders never FK an address record: checkout keeps taking an immutable jsonb
-- snapshot (orders.shipping_address_snapshot / customer_snapshot, migration 044),
-- so editing or deleting an address never changes a past order. This migration
-- only adds the explicit ownership link orders.customer_account_id so a verified
-- claim (or a verified same-email signup) can surface the order in the right
-- account history without mutating the guest snapshot.
--
-- Sensitive identity note: individual national IDs (TCKN) are intentionally NOT
-- persisted in the address book. The per-order invoice flow (customer_invoice_profiles /
-- invoice_snapshot) already collects and ENCRYPTS the identity number each checkout;
-- the address book only saves non-secret billing metadata (type, company, VKN,
-- tax office) so KVKK-sensitive IDs stay out of this plaintext table.

-- 1) Explicit, nullable account ownership on orders (the claim target). Tenant-aware
--    composite FK; ON DELETE SET NULL keeps the order and its snapshot intact if the
--    account is ever removed. Toggle FORCE RLS off around the ALTER/VALIDATE (as
--    migration 044 does) so constraint validation scans real rows as the migrator.
alter table orders no force row level security;

alter table orders add column if not exists customer_account_id bigint;

alter table orders
  drop constraint if exists orders_customer_account_org_fk,
  add constraint orders_customer_account_org_fk
    foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id)
    on delete set null (customer_account_id) not valid;
alter table orders validate constraint orders_customer_account_org_fk;

create index if not exists idx_orders_org_customer_account
  on orders (organization_id, customer_account_id)
  where customer_account_id is not null;

alter table orders force row level security;

-- 2) Address book. Structured TR address, billing metadata, soft delete.
create table if not exists customer_addresses (
  id bigserial primary key,
  organization_id uuid not null,
  customer_account_id bigint not null,
  label text not null default '' check (char_length(label) <= 60),
  recipient text not null check (char_length(btrim(recipient)) between 1 and 160),
  phone text not null default '' check (char_length(phone) <= 40),
  country text not null default 'TR' check (char_length(btrim(country)) between 2 and 60),
  city text not null default '' check (char_length(city) <= 80),
  district text not null default '' check (char_length(district) <= 80),
  neighborhood text not null default '' check (char_length(neighborhood) <= 120),
  address_line1 text not null check (char_length(btrim(address_line1)) between 1 and 500),
  address_line2 text not null default '' check (char_length(address_line2) <= 500),
  postal_code text not null default '' check (char_length(postal_code) <= 20),
  invoice_type text not null default 'individual' check (invoice_type in ('individual','company')),
  invoice_full_name text not null default '' check (char_length(invoice_full_name) <= 200),
  company_name text not null default '' check (char_length(company_name) <= 240),
  vkn text not null default '' check (vkn = '' or vkn ~ '^[1-9][0-9]{9}$'),
  tax_office text not null default '' check (char_length(tax_office) <= 160),
  is_default_shipping boolean not null default false,
  is_default_billing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint customer_addresses_org_id_key unique (organization_id, id),
  constraint customer_addresses_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete cascade
);

-- At most one default shipping and one default billing per account, enforced at the
-- database level over live rows only. Concurrent "set default" transactions cannot
-- both win: the second collides on the partial unique index.
create unique index if not exists idx_customer_addresses_one_default_shipping
  on customer_addresses (organization_id, customer_account_id)
  where is_default_shipping and deleted_at is null;
create unique index if not exists idx_customer_addresses_one_default_billing
  on customer_addresses (organization_id, customer_account_id)
  where is_default_billing and deleted_at is null;
create index if not exists idx_customer_addresses_account
  on customer_addresses (organization_id, customer_account_id, created_at desc, id desc)
  where deleted_at is null;

do $$
begin
  execute 'alter table customer_addresses enable row level security';
  execute 'alter table customer_addresses force row level security';
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'customer_addresses' and policyname = 'customer_addresses_tenant_policy'
  ) then
    execute 'create policy customer_addresses_tenant_policy on customer_addresses '
      || 'using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      || 'with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)';
  end if;
end $$;

-- 3) Guest-order claim tokens. Follows the accountTokens pattern: only the sha256
--    hash is stored, single-use (used_at), short-lived (expires_at), and bound to a
--    single tenant + order + account. Reissue invalidates prior active tokens.
create table if not exists order_account_claim_tokens (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  customer_account_id bigint not null,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint order_account_claim_tokens_org_id_key unique (organization_id, id),
  constraint order_account_claim_tokens_order_fk foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete cascade,
  constraint order_account_claim_tokens_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete cascade
);
create unique index if not exists idx_order_account_claim_tokens_hash
  on order_account_claim_tokens (token_hash);
create index if not exists idx_order_account_claim_tokens_active
  on order_account_claim_tokens (organization_id, order_id, customer_account_id)
  where used_at is null;

do $$
begin
  execute 'alter table order_account_claim_tokens enable row level security';
  execute 'alter table order_account_claim_tokens force row level security';
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'order_account_claim_tokens' and policyname = 'order_account_claim_tokens_tenant_policy'
  ) then
    execute 'create policy order_account_claim_tokens_tenant_policy on order_account_claim_tokens '
      || 'using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      || 'with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)';
  end if;
end $$;
