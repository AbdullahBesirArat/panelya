-- A28: versioned themes, publication history and rollback.
--
-- Design decisions worth stating, because they are what make this safe:
--
--   * A published version is IMMUTABLE. The trigger below refuses to change `config` (or
--     schema_version / validation_hash) once status has left 'draft'. Editing a live theme
--     means creating a new draft, so history is never rewritten under a rollback.
--   * Exactly ONE published version per tenant, enforced by a partial unique index rather
--     than by service code, so two concurrent publishes cannot both win.
--   * At most ONE editable draft per tenant, for the same reason: two admins editing what
--     they each think is "the" draft is a silent-overwrite generator.
--   * theme_publications is append-only history. A rollback is a NEW publication row that
--     points at the version it restored, not a mutation of the old one.

create table if not exists theme_versions (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  version_number integer not null check (version_number >= 1),
  schema_version integer not null check (schema_version >= 1),
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 262144),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- sha256 of the canonical serialization; integrity + optimistic concurrency, not a secret.
  validation_hash char(64) check (validation_hash is null or validation_hash ~ '^[0-9a-f]{64}$'),
  validation_result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(validation_result) = 'object' and octet_length(validation_result::text) <= 16384),
  based_on_version_id bigint,
  created_by uuid references app_users(id) on delete set null,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint theme_versions_org_id_key unique (organization_id, id),
  constraint theme_versions_org_version_key unique (organization_id, version_number),
  constraint theme_versions_based_on_fk foreign key (organization_id, based_on_version_id)
    references theme_versions (organization_id, id) on delete set null,
  constraint theme_versions_published_has_timestamp
    check (status <> 'published' or published_at is not null)
);

-- The single-published guarantee, and the single-draft guarantee.
create unique index if not exists idx_theme_versions_one_published
  on theme_versions (organization_id) where status = 'published';
create unique index if not exists idx_theme_versions_one_draft
  on theme_versions (organization_id) where status = 'draft';
create index if not exists idx_theme_versions_org_history
  on theme_versions (organization_id, version_number desc);

-- Immutability of a published/archived snapshot, enforced in the database so no code path
-- (including a future one) can quietly rewrite what a tenant already published.
create or replace function theme_versions_guard_immutable() returns trigger
  language plpgsql
as $$
begin
  if old.status <> 'draft' then
    if new.config is distinct from old.config
       or new.schema_version is distinct from old.schema_version
       or new.validation_hash is distinct from old.validation_hash
       or new.version_number is distinct from old.version_number then
      raise exception 'published theme version is immutable'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_theme_versions_immutable on theme_versions;
create trigger trg_theme_versions_immutable
  before update on theme_versions
  for each row execute function theme_versions_guard_immutable();

-- Append-only publication history. A rollback records which version it restored and which
-- publication it reverted, so "why is this live" is answerable from the table alone.
create table if not exists theme_publications (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  theme_version_id bigint not null,
  previous_theme_version_id bigint,
  rollback_of_publication_id bigint references theme_publications(id) on delete set null,
  action text not null check (action in ('publish', 'rollback')),
  reason text check (reason is null or char_length(reason) <= 500),
  config_hash char(64) check (config_hash is null or config_hash ~ '^[0-9a-f]{64}$'),
  published_by uuid references app_users(id) on delete set null,
  published_at timestamptz not null default now(),
  constraint theme_publications_org_id_key unique (organization_id, id),
  constraint theme_publications_version_fk foreign key (organization_id, theme_version_id)
    references theme_versions (organization_id, id) on delete cascade
);
create index if not exists idx_theme_publications_org
  on theme_publications (organization_id, published_at desc, id desc);

-- Short-lived, scoped preview grants. Only the sha256 of the token is stored; the raw
-- value is returned once and never persisted or logged.
create table if not exists theme_preview_tokens (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  theme_version_id bigint not null,
  token_hash char(64) not null check (token_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null default 'theme_preview' check (purpose = 'theme_preview'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint theme_preview_tokens_org_id_key unique (organization_id, id),
  constraint theme_preview_tokens_version_fk foreign key (organization_id, theme_version_id)
    references theme_versions (organization_id, id) on delete cascade,
  constraint theme_preview_tokens_expiry_future check (expires_at > created_at)
);
create unique index if not exists idx_theme_preview_tokens_hash
  on theme_preview_tokens (token_hash);
create index if not exists idx_theme_preview_tokens_expiry
  on theme_preview_tokens (expires_at);

do $$
declare table_name text;
begin
  foreach table_name in array array['theme_versions', 'theme_publications', 'theme_preview_tokens'] loop
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

comment on table theme_versions is
  'A28 versioned themes. A published version is immutable (trigger) and there is exactly one published and at most one draft per tenant (partial unique indexes).';
comment on table theme_publications is
  'A28 append-only publish/rollback history. A rollback is a new row referencing the restored version, never a mutation of an old one.';
