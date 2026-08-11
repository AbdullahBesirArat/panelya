-- A27: verified custom domains.
--
-- organizations.domain (migration 032) is KEPT and untouched: it is unverified
-- super-admin metadata used for platform listing/filtering, and it is deliberately NOT a
-- tenant-resolution source. Resolving a Host from an unverified free-text column would be
-- a domain-takeover vector, so A27 adds a real table with proof of ownership and only
-- resolves from that.
--
-- Ownership model:
--   * hostname is stored ONLY in its canonical ASCII form (services/domainNames.js), so a
--     second representation of the same name cannot bypass uniqueness.
--   * A hostname may be ACTIVE for at most one tenant globally, and a pending claim also
--     reserves it, so two tenants cannot race the same name to verification.
--   * Only the sha256 of the verification value is stored; the raw challenge is shown to
--     the tenant and never persisted or logged.

create table if not exists custom_domains (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Canonical ASCII hostname; the only form ever compared or resolved.
  hostname text not null check (
    char_length(hostname) between 4 and 253
    and hostname = lower(hostname)
    and hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  status text not null default 'pending_verification' check (status in (
    'pending_verification', 'verified', 'provisioning', 'active', 'failed', 'disabled'
  )),
  verification_method text not null default 'dns_txt' check (verification_method in ('dns_txt')),
  -- sha256 of the raw challenge value. Never the value itself.
  verification_token_hash char(64) check (verification_token_hash ~ '^[0-9a-f]{64}$'),
  verification_record_name text not null default '',
  verification_expires_at timestamptz,
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 60),
  is_canonical boolean not null default false,
  redirect_to_canonical boolean not null default true,
  ssl_status text not null default 'pending' check (ssl_status in (
    'pending', 'provisioning', 'active', 'failed', 'not_configured'
  )),
  ssl_checked_at timestamptz,
  provider text not null default 'manual' check (provider in ('manual', 'test', 'vercel')),
  provider_reference text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_domains_org_id_key unique (organization_id, id),
  -- The same tenant cannot list a hostname twice.
  constraint custom_domains_org_hostname_key unique (organization_id, hostname)
);

-- GLOBAL uniqueness for any hostname that is live or being claimed. A released/disabled
-- row drops out of this index, which is what allows a controlled hand-over, while an
-- active or in-flight claim blocks every other tenant.
create unique index if not exists idx_custom_domains_hostname_claimed
  on custom_domains (hostname)
  where status in ('pending_verification', 'verified', 'provisioning', 'active');

-- At most one canonical domain per tenant, enforced by the database rather than by
-- application ordering, so two concurrent "make me canonical" writes cannot both win.
create unique index if not exists idx_custom_domains_one_canonical
  on custom_domains (organization_id)
  where is_canonical and status = 'active';

create index if not exists idx_custom_domains_org
  on custom_domains (organization_id, status, created_at desc);
-- Host -> tenant resolution only ever looks at active rows.
create index if not exists idx_custom_domains_active_lookup
  on custom_domains (hostname) where status = 'active';

-- Ownership history. A hostname that was verified by one tenant and later released keeps
-- a trail, so a silent hand-over is impossible to perform unnoticed and a cooldown can be
-- enforced against immediate re-claim by a different tenant.
create table if not exists custom_domain_events (
  id bigserial primary key,
  organization_id uuid references organizations(id) on delete set null,
  domain_id bigint,
  hostname text not null,
  event_type text not null check (event_type in (
    'claimed', 'challenge_issued', 'verified', 'activated', 'canonical_set',
    'disabled', 'released', 'failed', 'force_disabled'
  )),
  actor_type text not null default 'system' check (actor_type in ('system', 'user', 'super_admin')),
  actor_user_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  occurred_at timestamptz not null default now()
);
create index if not exists idx_custom_domain_events_hostname
  on custom_domain_events (hostname, occurred_at desc);
create index if not exists idx_custom_domain_events_org
  on custom_domain_events (organization_id, occurred_at desc);

do $$
declare table_name text;
begin
  foreach table_name in array array['custom_domains', 'custom_domain_events'] loop
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

-- A27 makes domains a real, countable resource, so the plan model gets a ceiling for it.
-- Existing plans get a conservative default that matches their tier ordering; a plan's
-- published v1 snapshot is updated in place ONLY because no tenant can have consumed a
-- domain before this migration existed.
alter table plan_limits
  add column if not exists max_domains integer not null default 1;

update plan_limits set max_domains = case plan_name
  when 'starter' then 1
  when 'growth' then 3
  when 'business' then 10
  when 'enterprise' then 1000
  else max_domains
end;

update plan_versions
   set limits = limits || jsonb_build_object(
         'maxDomains',
         (select pl.max_domains from plan_limits pl where pl.plan_name = plan_versions.plan_name)
       ),
       updated_at = now()
 where not (limits ? 'maxDomains')
   and exists (select 1 from plan_limits pl where pl.plan_name = plan_versions.plan_name);

comment on table custom_domains is
  'A27 verified custom domains. Only status=active rows resolve a Host to a tenant; organizations.domain stays unverified platform metadata.';
comment on index idx_custom_domains_hostname_claimed is
  'Global claim lock: an active or in-flight hostname belongs to exactly one tenant, which is what prevents domain takeover.';
