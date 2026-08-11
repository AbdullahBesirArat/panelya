-- A23: stock/price/favorite notifications and channel-based communication consent.
-- Every table is tenant-scoped with FORCE RLS + tenant-aware composite FKs.
-- Transactional and marketing consent are kept separate (purpose column). Raw
-- contact is stored only where it must be sent from; a target_hash keys dedup,
-- suppression and admin masking so lookups never need the raw value.

create table if not exists communication_consents (
  id bigserial primary key,
  organization_id uuid not null,
  customer_account_id bigint,
  contact_email text not null default '',
  contact_phone text not null default '',
  target_hash char(64) not null check (target_hash ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('email','sms','whatsapp','push')),
  purpose text not null check (purpose in ('transactional','marketing','stock_alert','price_drop','favorite_update','abandoned_cart')),
  status text not null default 'granted' check (status in ('granted','revoked')),
  source text not null default '' check (char_length(source) <= 120),
  legal_basis text not null default 'consent' check (char_length(legal_basis) <= 60),
  policy_version text not null default '' check (char_length(policy_version) <= 40),
  consent_text_hash char(64),
  granted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  ip_hash char(64),
  user_agent_hash char(64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint communication_consents_org_id_key unique (organization_id, id),
  constraint communication_consents_unique unique (organization_id, target_hash, channel, purpose),
  constraint communication_consents_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete set null
);
create index if not exists idx_comm_consents_lookup
  on communication_consents (organization_id, target_hash, channel, purpose, status);

-- Append-only legal audit trail of every grant/revoke; consent snapshots are never mutated.
create table if not exists communication_consent_events (
  id bigserial primary key,
  organization_id uuid not null,
  consent_id bigint,
  target_hash char(64) not null,
  channel text not null,
  purpose text not null,
  action text not null check (action in ('granted','revoked')),
  policy_version text not null default '',
  consent_text_hash char(64),
  source text not null default '',
  ip_hash char(64),
  user_agent_hash char(64),
  occurred_at timestamptz not null default now(),
  constraint comm_consent_events_org_id_key unique (organization_id, id),
  constraint comm_consent_events_consent_fk foreign key (organization_id, consent_id)
    references communication_consents (organization_id, id) on delete set null
);
create index if not exists idx_comm_consent_events_consent
  on communication_consent_events (organization_id, consent_id, occurred_at desc);

create table if not exists notification_subscriptions (
  id bigserial primary key,
  organization_id uuid not null,
  customer_account_id bigint,
  product_id bigint not null,
  variant_id bigint,
  subscription_type text not null check (subscription_type in ('back_in_stock','price_drop','favorite_update')),
  channel text not null check (channel in ('email','sms','whatsapp','push')),
  contact_email text not null default '',
  contact_phone text not null default '',
  target_hash char(64) not null check (target_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('pending','active','notified','unsubscribed')),
  baseline_price numeric(12,2),
  last_notified_price numeric(12,2),
  last_notified_at timestamptz,
  cooldown_until timestamptz,
  expires_at timestamptz,
  confirmation_token_hash char(64),
  confirmed_at timestamptz,
  unsubscribe_token_hash char(64) not null check (unsubscribe_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_subscriptions_org_id_key unique (organization_id, id),
  constraint notification_subscriptions_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade,
  constraint notification_subscriptions_variant_fk foreign key (organization_id, variant_id)
    references product_variants (organization_id, id) on delete cascade,
  constraint notification_subscriptions_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete set null
);
create unique index if not exists idx_notification_sub_unique
  on notification_subscriptions (organization_id, target_hash, subscription_type, product_id, coalesce(variant_id, 0), channel);
create index if not exists idx_notification_sub_active
  on notification_subscriptions (organization_id, subscription_type, product_id, status)
  where status = 'active';
create unique index if not exists idx_notification_sub_unsub_token
  on notification_subscriptions (unsubscribe_token_hash);

create table if not exists notification_outbox (
  id bigserial primary key,
  organization_id uuid not null,
  customer_account_id bigint,
  subscription_id bigint,
  event_type text not null check (event_type in ('back_in_stock','price_drop','favorite_update','subscription_opt_in')),
  channel text not null check (channel in ('email','sms','whatsapp','push')),
  provider text not null default '',
  recipient_ref text not null default '',
  recipient_hash char(64) not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 16384),
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','dead')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 20),
  max_attempts integer not null default 5 check (max_attempts >= 1 and max_attempts <= 20),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_outbox_org_id_key unique (organization_id, id),
  constraint notification_outbox_idem_key unique (organization_id, idempotency_key),
  constraint notification_outbox_subscription_fk foreign key (organization_id, subscription_id)
    references notification_subscriptions (organization_id, id) on delete set null
);
create index if not exists idx_notification_outbox_delivery
  on notification_outbox (status, next_attempt_at, id)
  where status in ('pending','failed','processing');

create table if not exists notification_deliveries (
  id bigserial primary key,
  organization_id uuid not null,
  outbox_id bigint not null,
  provider text not null default '',
  provider_message_id text,
  status text not null check (status in ('sent','temporary_failure','permanent_failure','rate_limited','invalid_recipient')),
  response_metadata jsonb not null default '{}'::jsonb check (octet_length(response_metadata::text) <= 8192),
  attempted_at timestamptz not null default now(),
  delivered_at timestamptz,
  failed_at timestamptz,
  constraint notification_deliveries_org_id_key unique (organization_id, id),
  constraint notification_deliveries_outbox_fk foreign key (organization_id, outbox_id)
    references notification_outbox (organization_id, id) on delete cascade
);
create index if not exists idx_notification_deliveries_outbox
  on notification_deliveries (organization_id, outbox_id, attempted_at desc);

create table if not exists communication_suppressions (
  id bigserial primary key,
  organization_id uuid not null,
  channel text not null check (channel in ('email','sms','whatsapp','push')),
  target_hash char(64) not null check (target_hash ~ '^[0-9a-f]{64}$'),
  reason text not null default '' check (char_length(reason) <= 120),
  source text not null default '' check (char_length(source) <= 120),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint communication_suppressions_org_id_key unique (organization_id, id),
  constraint communication_suppressions_unique unique (organization_id, channel, target_hash)
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'communication_consents','communication_consent_events','notification_subscriptions',
    'notification_outbox','notification_deliveries','communication_suppressions'
  ] loop
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
