-- A24.5: tenant gift-wrap options + gift note.
--
-- Options are tenant-scoped with FORCE RLS and are reachable from a cart only
-- through a tenant-aware composite FK, so a cross-tenant option can never be
-- selected even if an id is guessed. The cart keeps the server-resolved fee in a
-- dedicated column (never a client value) so the fee is added to the cart total in
-- exactly one place. Orders keep an immutable jsonb snapshot and deliberately have
-- NO foreign key to gift_wrap_options: editing, deactivating or deleting an option
-- later must never rewrite a historical order.

create table if not exists gift_wrap_options (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  fee numeric(12,2) not null default 0 check (fee >= 0 and fee <= 100000),
  currency char(3) not null default 'TRY' check (currency = 'TRY'),
  media_id uuid,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gift_wrap_options_org_id_key unique (organization_id, id),
  constraint gift_wrap_options_media_fk foreign key (organization_id, media_id)
    references upload_assets (organization_id, id) on delete set null
);

create index if not exists idx_gift_wrap_options_active
  on gift_wrap_options (organization_id, is_active, sort_order, id);

alter table carts
  add column if not exists gift_wrap_option_id bigint,
  add column if not exists gift_wrap_fee numeric(12,2) not null default 0,
  add column if not exists gift_note text;

alter table orders
  add column if not exists gift_wrap_fee numeric(12,2) not null default 0,
  add column if not exists gift_note text not null default '',
  add column if not exists gift_wrap_snapshot jsonb not null default '{}'::jsonb;

-- Constraints are added guarded so a direct re-run of this migration stays idempotent.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'carts_gift_wrap_option_fk') then
    alter table carts add constraint carts_gift_wrap_option_fk
      foreign key (organization_id, gift_wrap_option_id)
      references gift_wrap_options (organization_id, id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'carts_gift_wrap_fee_check') then
    alter table carts add constraint carts_gift_wrap_fee_check
      check (gift_wrap_fee >= 0 and gift_wrap_fee <= 100000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'carts_gift_note_length_check') then
    alter table carts add constraint carts_gift_note_length_check
      check (gift_note is null or char_length(gift_note) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_gift_wrap_fee_check') then
    alter table orders add constraint orders_gift_wrap_fee_check
      check (gift_wrap_fee >= 0 and gift_wrap_fee <= 100000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_gift_note_length_check') then
    alter table orders add constraint orders_gift_note_length_check
      check (char_length(gift_note) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_gift_wrap_snapshot_size_check') then
    alter table orders add constraint orders_gift_wrap_snapshot_size_check
      check (octet_length(gift_wrap_snapshot::text) <= 8192);
  end if;
end $$;

-- Gift selection changes are a first-class cart event, not an item edit.
alter table cart_events drop constraint if exists cart_events_event_type_check;
alter table cart_events add constraint cart_events_event_type_check
  check (event_type in (
    'created','item_added','item_updated','item_removed','cleared',
    'coupon_applied','coupon_removed','merged','converted',
    'abandoned','recovery_sent','recovered','expired','cancelled',
    'gift_wrap_updated'
  ));

do $$
declare table_name text;
begin
  foreach table_name in array array['gift_wrap_options'] loop
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

comment on table gift_wrap_options is
  'A24.5 tenant gift-wrap options. Fee is server-authoritative; orders store an immutable snapshot instead of referencing this table.';
