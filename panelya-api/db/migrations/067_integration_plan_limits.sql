-- A29 (2/2): the plan dimensions the integration platform introduces.
--
-- Same shape as A27's max_domains (migration 061): a plan_limits column with a tier-ordered
-- default, then the same number folded into every existing plan_versions snapshot. Updating
-- a published snapshot in place is safe for exactly the same reason it was there — no
-- tenant can have consumed an API key, a webhook or an API call before this migration
-- existed, so no tenant's effective terms change.
--
-- max_api_calls_month is a MONTHLY quota, counted from integration usage rather than a
-- counter column, so it cannot drift out of sync with reality.

alter table plan_limits
  add column if not exists max_api_keys integer not null default 2;
alter table plan_limits
  add column if not exists max_webhooks integer not null default 2;
alter table plan_limits
  add column if not exists max_api_calls_month integer not null default 10000;

update plan_limits set
  max_api_keys = case plan_name
    when 'starter' then 2
    when 'growth' then 5
    when 'business' then 20
    when 'enterprise' then 200
    else max_api_keys
  end,
  max_webhooks = case plan_name
    when 'starter' then 2
    when 'growth' then 5
    when 'business' then 20
    when 'enterprise' then 200
    else max_webhooks
  end,
  max_api_calls_month = case plan_name
    when 'starter' then 10000
    when 'growth' then 100000
    when 'business' then 1000000
    when 'enterprise' then 20000000
    else max_api_calls_month
  end;

update plan_versions
   set limits = limits || jsonb_build_object(
         'maxApiKeys',
         (select pl.max_api_keys from plan_limits pl where pl.plan_name = plan_versions.plan_name),
         'maxWebhooks',
         (select pl.max_webhooks from plan_limits pl where pl.plan_name = plan_versions.plan_name),
         'maxApiCallsMonth',
         (select pl.max_api_calls_month from plan_limits pl where pl.plan_name = plan_versions.plan_name)
       ),
       updated_at = now()
 where not (limits ? 'maxApiKeys' and limits ? 'maxWebhooks' and limits ? 'maxApiCallsMonth')
   and exists (select 1 from plan_limits pl where pl.plan_name = plan_versions.plan_name);

-- Monthly API usage, counted per tenant and per calendar month. A row per (tenant, month)
-- rather than per request: the external API is rate limited separately, and a quota only
-- needs a total.
create table if not exists api_usage_counters (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  -- First instant of the counted month, in UTC.
  period_start timestamptz not null,
  call_count bigint not null default 0 check (call_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_usage_counters_org_id_key unique (organization_id, id)
);
create unique index if not exists idx_api_usage_counters_period
  on api_usage_counters (organization_id, period_start);

alter table api_usage_counters enable row level security;
alter table api_usage_counters force row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'api_usage_counters' and policyname = 'api_usage_counters_tenant_policy'
  ) then
    create policy api_usage_counters_tenant_policy on api_usage_counters
      using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
      with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
  end if;
end $$;

comment on table api_usage_counters is
  'A29 monthly external API call counter per tenant, the source for the maxApiCallsMonth plan dimension.';
