-- A26 (1/2): versioned plan definitions + the canonical subscription state model.
--
-- Why versions: today limits resolve as organizations.plan -> plan_limits, so editing a
-- plan's limits silently rewrites the terms of every existing customer on that plan.
-- plan_versions freezes a plan's limits into an immutable published snapshot, and a
-- subscription pins the version it was sold. Editing a plan now means publishing a NEW
-- version; existing subscriptions keep pointing at the old one.
--
-- plan_limits is deliberately KEPT. It stays the source of truth for the v1 backfill and
-- the fallback for an organization with no subscription row, so planLimits.js keeps its
-- public contract (assertPlanCapacity / requirePlanCapacity) and every existing tenant
-- resolves byte-identical limits before and after this migration.
--
-- subscriptions is ALTERed, never recreated: the table carries live tenant state.

create table if not exists plan_versions (
  id bigserial primary key,
  plan_name text not null,
  version integer not null check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  effective_from timestamptz,
  -- Immutable limit snapshot. Kept as jsonb (not columns) so a future plan can add a
  -- dimension without a schema change rewriting historical versions.
  limits jsonb not null default '{}'::jsonb
    check (jsonb_typeof(limits) = 'object' and octet_length(limits::text) <= 8192),
  notes text not null default '' check (char_length(notes) <= 1000),
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_versions_plan_version_key unique (plan_name, version),
  -- A published version is immutable, so it must carry the moment it took effect.
  constraint plan_versions_published_has_effective_from
    check (status = 'draft' or effective_from is not null)
);

-- At most one active version per plan: version resolution for a NEW subscription must be
-- unambiguous, enforced by the database rather than by application ordering.
create unique index if not exists idx_plan_versions_one_active
  on plan_versions (plan_name) where status = 'active';
create index if not exists idx_plan_versions_plan_status
  on plan_versions (plan_name, status, version desc);

-- v1 backfill: one active version per existing plan, carrying that plan's CURRENT limits
-- verbatim. This is what makes "limits before == limits after" true by construction
-- rather than by convention.
insert into plan_versions (plan_name, version, status, effective_from, limits, notes, published_at)
select
  pl.plan_name,
  1,
  'active',
  coalesce(pl.created_at, now()),
  jsonb_build_object(
    'maxProducts', pl.max_products,
    'maxOrdersMonth', pl.max_orders_month,
    'maxMembers', pl.max_members,
    'maxStorageMb', pl.max_storage_mb,
    'maxCollections', pl.max_collections,
    'maxBlogPosts', pl.max_blog_posts
  ),
  'A26 v1 snapshot backfilled from plan_limits',
  now()
from plan_limits pl
on conflict (plan_name, version) do nothing;

-- Canonical lifecycle state set. The legacy CHECK allowed
-- (trialing, active, past_due, cancelled, unpaid); grace_period, suspended and expired
-- are new. 'unpaid' is dropped from the canonical set: no code path in this repo ever
-- wrote or read it (it existed only inside the 005 CHECK), so any row still carrying it
-- is legacy data. It maps to 'past_due' — the canonical entry state for a payment that
-- has failed but has not yet exhausted its grace window — which preserves the "billing
-- is broken, access not yet withdrawn" meaning without inventing a new semantic.
alter table subscriptions
  add column if not exists plan_version_id bigint references plan_versions(id) on delete restrict,
  add column if not exists trial_start timestamptz,
  add column if not exists trial_end timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists grace_until timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspension_reason text,
  add column if not exists last_transition_at timestamptz,
  add column if not exists last_transition_reason text;

update subscriptions set status = 'past_due' where status = 'unpaid';

alter table subscriptions drop constraint if exists subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check
  check (status in (
    'trialing', 'active', 'past_due', 'grace_period', 'suspended', 'cancelled', 'expired'
  ));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_suspension_reason_len') then
    alter table subscriptions add constraint subscriptions_suspension_reason_len
      check (suspension_reason is null or char_length(suspension_reason) <= 300);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_transition_reason_len') then
    alter table subscriptions add constraint subscriptions_transition_reason_len
      check (last_transition_reason is null or char_length(last_transition_reason) <= 300);
  end if;
end $$;

-- Existing trialing rows already carry their trial window in current_period_end (that is
-- what 005/auth.js wrote), so trial_end is derived from it rather than guessed.
update subscriptions
   set trial_end = current_period_end,
       trial_start = coalesce(current_period_start, created_at)
 where status = 'trialing' and trial_end is null;

-- Pin every existing subscription to the v1 version of the plan it is already on, so a
-- later v2 publish cannot move it.
update subscriptions s
   set plan_version_id = pv.id
  from plan_versions pv
 where pv.plan_name = s.plan and pv.version = 1 and s.plan_version_id is null;

create index if not exists idx_subscriptions_org_status
  on subscriptions (organization_id, status, updated_at desc);
-- Scan indexes for the lifecycle worker: due trials and expiring grace windows.
create index if not exists idx_subscriptions_trial_scan
  on subscriptions (trial_end) where status = 'trialing' and trial_end is not null;
create index if not exists idx_subscriptions_grace_scan
  on subscriptions (grace_until) where status = 'grace_period' and grace_until is not null;

-- Trial abuse prevention: a tenant's trial history is recorded so a second trial cannot
-- simply be started again. One row per organization per trial cycle.
create table if not exists organization_trials (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid,
  plan_name text not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  outcome text not null default 'running'
    check (outcome in ('running', 'converted', 'expired', 'cancelled')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_trials_org_id_key unique (organization_id, id)
);
-- At most one running trial per organization; history rows stay for the abuse check.
create unique index if not exists idx_organization_trials_one_running
  on organization_trials (organization_id) where outcome = 'running';
create index if not exists idx_organization_trials_org
  on organization_trials (organization_id, started_at desc);

-- Backfill trial history for tenants currently trialing, so the abuse check sees the
-- trial they are already in rather than treating it as their first.
insert into organization_trials (organization_id, subscription_id, plan_name, started_at, ends_at, outcome)
select s.organization_id, s.id, s.plan,
       coalesce(s.trial_start, s.created_at),
       coalesce(s.trial_end, s.current_period_end, s.created_at + interval '14 days'),
       'running'
  from subscriptions s
 where s.status = 'trialing'
   and not exists (
     select 1 from organization_trials t
      where t.organization_id = s.organization_id and t.outcome = 'running'
   );

comment on table plan_versions is
  'A26 immutable published plan limit snapshots. A subscription pins the version it was sold so later plan edits never rewrite existing terms.';
comment on table organization_trials is
  'A26 trial history per organization; the partial unique index makes a second concurrent trial impossible.';
