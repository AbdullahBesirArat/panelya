-- A26 (2/2): provider billing events, subscription invoices, plan change requests and
-- controlled super-admin overrides.
--
-- billing_events follows the payment_callback_events contract (migration 013): store the
-- event, dedupe it, process it with visible attempts/last_error rather than swallowing
-- failures. The difference is scope — a provider event id is unique per provider, so the
-- dedupe key is (provider, provider_event_id) and NOT organization-scoped: a spoofed or
-- mis-routed event must not be able to create a second row by claiming another tenant.
--
-- event_sequence carries the provider's own ordering signal so a late-arriving older
-- event cannot roll a newer state backwards. Signatures/secrets are never stored.

create table if not exists billing_events (
  id bigserial primary key,
  organization_id uuid references organizations(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete set null,
  provider text not null check (provider in ('iyzico', 'stripe', 'manual', 'test')),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 1 and 120),
  -- Provider ordering signal (Stripe-style monotonic timestamp / sequence). Null means
  -- the provider gives no ordering guarantee and received_at is used instead.
  event_sequence bigint,
  event_created_at timestamptz,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  ignored_reason text check (ignored_reason is null or char_length(ignored_reason) <= 300),
  processing_attempts integer not null default 0 check (processing_attempts >= 0 and processing_attempts <= 25),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The dedupe guarantee: one row per provider event, full stop. A replayed webhook hits
-- this and can never drive a second state transition.
create unique index if not exists idx_billing_events_provider_event
  on billing_events (provider, provider_event_id);
create index if not exists idx_billing_events_delivery
  on billing_events (status, next_retry_at, id) where status in ('pending', 'failed', 'processing');
create index if not exists idx_billing_events_org
  on billing_events (organization_id, received_at desc);
-- Ordering lookup: the newest applied event per subscription.
create index if not exists idx_billing_events_subscription_order
  on billing_events (subscription_id, event_sequence desc nulls last, received_at desc);

create table if not exists subscription_invoices (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete set null,
  provider text not null check (provider in ('iyzico', 'stripe', 'manual', 'test')),
  provider_invoice_reference text,
  invoice_number text not null check (char_length(invoice_number) between 1 and 80),
  currency char(3) not null default 'TRY' check (currency = 'TRY'),
  -- Money is numeric(12,2) to match the order/invoice money model already in this
  -- schema; no JS float ever computes these.
  subtotal numeric(12, 2) not null default 0 check (subtotal >= 0),
  tax_total numeric(12, 2) not null default 0 check (tax_total >= 0),
  total numeric(12, 2) not null default 0 check (total >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  -- Immutable copy of what the provider reported, so editing a plan or invoice template
  -- later never rewrites a historical invoice.
  provider_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_snapshot) = 'object' and octet_length(provider_snapshot::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_invoices_org_id_key unique (organization_id, id),
  constraint subscription_invoices_number_key unique (organization_id, invoice_number),
  -- 'paid' is only reachable with an actual settlement timestamp, so no code path can
  -- mark an invoice paid without recording when it was paid.
  constraint subscription_invoices_paid_requires_timestamp
    check (status <> 'paid' or paid_at is not null),
  constraint subscription_invoices_total_consistent
    check (total = subtotal + tax_total)
);
create index if not exists idx_subscription_invoices_org
  on subscription_invoices (organization_id, issued_at desc nulls last, id desc);
create unique index if not exists idx_subscription_invoices_provider_ref
  on subscription_invoices (provider, provider_invoice_reference)
  where provider_invoice_reference is not null;

create table if not exists plan_change_requests (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  source_plan_name text not null,
  source_plan_version_id bigint references plan_versions(id) on delete set null,
  target_plan_name text not null,
  target_plan_version_id bigint references plan_versions(id) on delete restrict,
  change_type text not null check (change_type in ('upgrade', 'downgrade', 'same_plan_version')),
  status text not null default 'pending'
    check (status in ('pending', 'scheduled', 'applied', 'rejected', 'failed', 'cancelled')),
  -- Read-only usage/limit comparison captured when the request was made, so an admin can
  -- see what the decision was based on even after usage moves.
  preview_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(preview_snapshot) = 'object' and octet_length(preview_snapshot::text) <= 16384),
  -- Whatever the provider reported about proration; this repo never computes proration
  -- itself (see services/subscriptionProviders.js).
  proration jsonb not null default '{}'::jsonb
    check (jsonb_typeof(proration) = 'object' and octet_length(proration::text) <= 8192),
  requested_by uuid references app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  effective_at timestamptz,
  applied_at timestamptz,
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_change_requests_org_id_key unique (organization_id, id)
);
create index if not exists idx_plan_change_requests_org
  on plan_change_requests (organization_id, requested_at desc);
-- At most one open request per subscription, so two conflicting changes cannot both be
-- in flight.
create unique index if not exists idx_plan_change_requests_one_open
  on plan_change_requests (subscription_id) where status in ('pending', 'scheduled');
-- Scan index for applying scheduled (period-end) downgrades.
create index if not exists idx_plan_change_requests_due
  on plan_change_requests (effective_at) where status = 'scheduled';

-- Controlled super-admin override. Deliberately NOT an open-ended bypass: a reason and an
-- expiry are required by the schema, so an indefinite silent override cannot be created.
create table if not exists subscription_overrides (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete cascade,
  override_type text not null check (override_type in ('limit', 'status', 'plan_version')),
  -- For a limit override: which resource and what ceiling. For status/plan_version: the
  -- forced value. Validated by the service, bounded here.
  target_key text not null check (char_length(target_key) between 1 and 80),
  target_value jsonb not null default '{}'::jsonb
    check (jsonb_typeof(target_value) = 'object' and octet_length(target_value::text) <= 4096),
  reason text not null check (char_length(btrim(reason)) between 5 and 500),
  created_by uuid references app_users(id) on delete set null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_overrides_org_id_key unique (organization_id, id),
  constraint subscription_overrides_expiry_future check (expires_at > created_at)
);
-- One live override per (subscription, type, key): overlapping ceilings for the same
-- resource would make "which limit applies" ambiguous.
create unique index if not exists idx_subscription_overrides_one_live
  on subscription_overrides (subscription_id, override_type, target_key)
  where revoked_at is null;
create index if not exists idx_subscription_overrides_expiry
  on subscription_overrides (expires_at) where revoked_at is null;

-- Tenant-scoped billing tables get FORCE RLS like the rest of the schema. billing_events
-- is included even though a webhook arrives before a tenant is resolved: the row is
-- written by the system role, and tenant-context reads must never see another tenant's
-- events. organization_id is nullable there (an unmatched event belongs to no tenant),
-- and such rows are visible only to the RLS-bypassing system role.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'billing_events', 'subscription_invoices', 'plan_change_requests', 'subscription_overrides'
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

comment on table billing_events is
  'A26 provider billing events. UNIQUE(provider, provider_event_id) makes a replayed webhook inert; event_sequence stops an out-of-order event rolling state backwards.';
comment on table subscription_overrides is
  'A26 super-admin overrides. reason and expires_at are NOT NULL by design: there is no indefinite silent bypass.';
