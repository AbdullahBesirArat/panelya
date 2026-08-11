-- A29 (1/2): API keys, idempotency, integration events and webhook delivery.
--
-- Structure only; the plan-limit dimensions this stage introduces live in 067 so they can
-- be re-derived without dropping the tables.
--
-- Three storage decisions are deliberate and NOT interchangeable:
--
--   * An API key secret is stored as a HASH only. The server never needs to reproduce it,
--     so it must not be able to.
--   * A webhook signing secret is stored ENCRYPTED, because the sender has to reproduce it
--     on every delivery to compute an HMAC. Hashing it would make signing impossible; this
--     is why the two live in different tables with different columns rather than sharing a
--     "secret" abstraction that would inevitably be used for the wrong one.
--   * An integration event is written in the SAME transaction as the business change it
--     describes. That is what makes "the order moved but no event exists" impossible, and
--     it is why events are a table here rather than a queue somewhere else.

-- ---------------------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------------------

create table if not exists api_keys (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  -- Public, non-secret identifier carried in the key itself. Lookup happens on this, so a
  -- verification never scans the table or compares against unrelated rows.
  prefix text not null check (prefix ~ '^pk_[a-z0-9]{12}$'),
  secret_hash char(64) not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  -- Rotation lineage. A rotated key keeps working until overlap_until so a caller can
  -- deploy the new secret without a broken window; after that instant auth refuses it
  -- even though nothing has run to revoke it.
  rotation_group_id uuid not null default gen_random_uuid(),
  rotated_from_id bigint,
  overlap_until timestamptz,
  expires_at timestamptz,
  ip_allowlist text[] not null default '{}',
  last_used_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_keys_org_id_key unique (organization_id, id),
  constraint api_keys_rotated_from_fk foreign key (organization_id, rotated_from_id)
    references api_keys (organization_id, id) on delete set null (rotated_from_id),
  constraint api_keys_revoked_consistent check (
    (status = 'revoked') = (revoked_at is not null)
  ),
  constraint api_keys_overlap_requires_parent check (
    overlap_until is null or rotated_from_id is not null or status = 'active'
  )
);
-- The prefix is what authentication looks up, and it must be unique platform-wide: two
-- tenants sharing one would make the candidate row ambiguous before any secret is checked.
create unique index if not exists idx_api_keys_prefix on api_keys (prefix);
create index if not exists idx_api_keys_org on api_keys (organization_id, created_at desc);
create index if not exists idx_api_keys_rotation on api_keys (organization_id, rotation_group_id);

-- ---------------------------------------------------------------------------------------
-- Idempotency for external create endpoints
-- ---------------------------------------------------------------------------------------

create table if not exists api_idempotency_keys (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  api_key_id bigint,
  -- Only the hash of the caller's key value is stored: it is caller-chosen and may carry
  -- meaning we have no business retaining.
  idempotency_key_hash char(64) not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  method text not null check (method in ('POST', 'PUT', 'PATCH', 'DELETE')),
  -- Route TEMPLATE, not the concrete path: the same key on a different endpoint is a
  -- different operation and must not replay the first one's response.
  route text not null check (char_length(route) between 1 and 200),
  request_hash char(64) not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed')),
  response_status integer check (response_status is null or (response_status between 100 and 599)),
  -- A bounded snapshot of the response that was actually returned. Never the request body:
  -- that is the part that carries customer data.
  response_body jsonb check (response_body is null or octet_length(response_body::text) <= 65536),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  constraint api_idempotency_org_id_key unique (organization_id, id),
  constraint api_idempotency_key_fk foreign key (organization_id, api_key_id)
    references api_keys (organization_id, id) on delete set null (api_key_id),
  constraint api_idempotency_expiry_future check (expires_at > created_at)
);
-- The uniqueness that makes concurrency safe: the second caller's insert fails rather than
-- running the business mutation a second time.
create unique index if not exists idx_api_idempotency_claim
  on api_idempotency_keys (organization_id, idempotency_key_hash, method, route);
create index if not exists idx_api_idempotency_expiry on api_idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------------------
-- Integration events (transactional outbox)
-- ---------------------------------------------------------------------------------------

create table if not exists integration_events (
  id bigserial primary key,
  -- Stable public identifier a receiver dedupes on. Random, not sequential: it travels to
  -- third parties and must not leak volume.
  event_id uuid not null default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  schema_version integer not null default 1 check (schema_version >= 1),
  aggregate_type text not null check (char_length(aggregate_type) between 1 and 40),
  aggregate_id text not null check (char_length(aggregate_id) between 1 and 100),
  -- Lets a consumer detect an out-of-order delivery instead of being told in prose that
  -- ordering is not guaranteed. Monotonic per aggregate.
  aggregate_version bigint not null check (aggregate_version >= 0),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint integration_events_org_id_key unique (organization_id, id)
);
create unique index if not exists idx_integration_events_event_id
  on integration_events (event_id);
-- Deterministic dedup: the same transition recorded twice (a retried callback, a repeated
-- state write) collapses to one event, while two genuinely different updates of the same
-- aggregate differ in aggregate_version and both survive.
create unique index if not exists idx_integration_events_dedup
  on integration_events (organization_id, event_type, aggregate_type, aggregate_id, aggregate_version);
create index if not exists idx_integration_events_org
  on integration_events (organization_id, occurred_at desc, id desc);

-- ---------------------------------------------------------------------------------------
-- Webhook endpoints, their event subscriptions and their signing secrets
-- ---------------------------------------------------------------------------------------

create table if not exists webhook_endpoints (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  url text not null check (char_length(url) between 8 and 2000),
  status text not null default 'active'
    check (status in ('active', 'disabled', 'archived')),
  -- Consecutive delivery failures. Reset by any success; a threshold disables the endpoint
  -- so a dead receiver stops consuming worker capacity forever.
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 200),
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_endpoints_org_id_key unique (organization_id, id),
  constraint webhook_endpoints_disabled_consistent check (
    (status = 'disabled') = (disabled_at is not null)
  )
);
create index if not exists idx_webhook_endpoints_org
  on webhook_endpoints (organization_id, created_at desc);

-- Subscriptions are rows, not an array column, so fanout is a join the planner can use and
-- an event type can be indexed rather than scanned.
create table if not exists webhook_endpoint_events (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  endpoint_id bigint not null,
  event_type text not null check (char_length(event_type) between 1 and 80),
  created_at timestamptz not null default now(),
  constraint webhook_endpoint_events_org_id_key unique (organization_id, id),
  constraint webhook_endpoint_events_endpoint_fk foreign key (organization_id, endpoint_id)
    references webhook_endpoints (organization_id, id) on delete cascade
);
create unique index if not exists idx_webhook_endpoint_events_unique
  on webhook_endpoint_events (organization_id, endpoint_id, event_type);
create index if not exists idx_webhook_endpoint_events_lookup
  on webhook_endpoint_events (organization_id, event_type);

-- Signing secrets are ENCRYPTED, not hashed: the sender must reproduce the value to compute
-- an HMAC. Two versions may be active at once so a receiver can accept both while it
-- deploys the new one.
create table if not exists webhook_endpoint_secrets (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  endpoint_id bigint not null,
  version integer not null check (version >= 1),
  ciphertext text not null check (char_length(ciphertext) between 1 and 4000),
  status text not null default 'current' check (status in ('current', 'retiring', 'retired')),
  created_at timestamptz not null default now(),
  retire_at timestamptz,
  retired_at timestamptz,
  constraint webhook_endpoint_secrets_org_id_key unique (organization_id, id),
  constraint webhook_endpoint_secrets_endpoint_fk foreign key (organization_id, endpoint_id)
    references webhook_endpoints (organization_id, id) on delete cascade
);
create unique index if not exists idx_webhook_secrets_version
  on webhook_endpoint_secrets (organization_id, endpoint_id, version);
-- Exactly one signing secret per endpoint at any time: which secret a new delivery is
-- signed with must never be ambiguous.
create unique index if not exists idx_webhook_secrets_one_current
  on webhook_endpoint_secrets (organization_id, endpoint_id) where status = 'current';

-- ---------------------------------------------------------------------------------------
-- Webhook deliveries
-- ---------------------------------------------------------------------------------------

create table if not exists webhook_deliveries (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id bigint not null,
  endpoint_id bigint not null,
  secret_version_id bigint,
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 8 check (max_attempts >= 1),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'delivered', 'dead_letter', 'cancelled')),
  response_status integer check (response_status is null or (response_status between 100 and 599)),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text check (locked_by is null or char_length(locked_by) <= 120),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 60),
  -- Bounded and already redacted by the worker. A receiver's response body is untrusted
  -- input and is never stored in full.
  error_detail text check (error_detail is null or char_length(error_detail) <= 500),
  payload_hash char(64) check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint webhook_deliveries_org_id_key unique (organization_id, id),
  constraint webhook_deliveries_event_fk foreign key (organization_id, event_id)
    references integration_events (organization_id, id) on delete cascade,
  constraint webhook_deliveries_endpoint_fk foreign key (organization_id, endpoint_id)
    references webhook_endpoints (organization_id, id) on delete cascade,
  constraint webhook_deliveries_secret_fk foreign key (organization_id, secret_version_id)
    references webhook_endpoint_secrets (organization_id, id) on delete set null (secret_version_id)
);
-- One delivery per (event, endpoint): a fanout that runs twice cannot send twice.
create unique index if not exists idx_webhook_deliveries_unique
  on webhook_deliveries (organization_id, event_id, endpoint_id);
create index if not exists idx_webhook_deliveries_claim
  on webhook_deliveries (status, next_attempt_at, id);
create index if not exists idx_webhook_deliveries_org
  on webhook_deliveries (organization_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------------------
-- Tenant isolation
-- ---------------------------------------------------------------------------------------

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'api_keys', 'api_idempotency_keys', 'integration_events', 'webhook_endpoints',
    'webhook_endpoint_events', 'webhook_endpoint_secrets', 'webhook_deliveries'
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

comment on table api_keys is
  'A29 external API credentials. Only the sha256 of the secret is stored; rotation keeps the old key valid until overlap_until, enforced at authentication rather than by a job.';
comment on table integration_events is
  'A29 transactional outbox. Written in the same transaction as the business change, so a rolled-back mutation cannot leave an event behind.';
comment on table webhook_endpoint_secrets is
  'A29 signing secrets, ENCRYPTED (not hashed) because the sender must reproduce them to compute an HMAC. Exactly one current version per endpoint.';
