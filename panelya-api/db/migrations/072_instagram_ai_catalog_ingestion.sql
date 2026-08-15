-- A34: Instagram -> AI -> catalog ingestion staging model.
-- The migration runner owns the transaction; do not add BEGIN/COMMIT here.

alter table media_references
  drop constraint if exists media_references_resource_type_check;
alter table media_references
  add constraint media_references_resource_type_check
  check (resource_type in (
    'product', 'category', 'collection', 'blog_post', 'slider_item', 'theme',
    'instagram_product_draft'
  ));

create table instagram_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null default 'instagram' check (provider = 'instagram'),
  external_account_id text,
  username text,
  account_type text check (account_type is null or account_type in ('Business', 'Media_Creator')),
  status text not null default 'active' check (status in ('active', 'expired', 'disconnected', 'error')),
  access_token_ciphertext text,
  token_expires_at timestamptz,
  granted_scopes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(granted_scopes) = 'array' and octet_length(granted_scopes::text) <= 4096),
  provider_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_metadata) = 'object' and octet_length(provider_metadata::text) <= 16384),
  last_synced_at timestamptz,
  sync_cursor text check (sync_cursor is null or length(sync_cursor) <= 2048),
  defaults jsonb not null default '{"default_stock":5,"product_status":"draft"}'::jsonb
    check (jsonb_typeof(defaults) = 'object' and octet_length(defaults::text) <= 4096),
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_connections_org_id_key unique (organization_id, id),
  constraint instagram_connections_org_account_key unique (organization_id, provider, external_account_id)
);

create index idx_instagram_connections_org_status
  on instagram_connections (organization_id, status, updated_at desc);

create table instagram_oauth_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_id uuid not null references app_users(id) on delete cascade,
  state_hash char(64) not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint instagram_oauth_states_org_id_key unique (organization_id, id),
  check (expires_at > created_at)
);

create index idx_instagram_oauth_states_expiry
  on instagram_oauth_states (expires_at) where used_at is null;

create table instagram_media_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid not null,
  external_media_id text not null check (length(external_media_id) between 1 and 200),
  permalink text check (permalink is null or length(permalink) <= 2048),
  caption text check (caption is null or length(caption) <= 10000),
  caption_hash char(64) not null check (caption_hash ~ '^[0-9a-f]{64}$'),
  media_type text not null check (media_type in ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM')),
  media_product_type text check (media_product_type is null or length(media_product_type) <= 80),
  provider_timestamp timestamptz,
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object' and octet_length(source_metadata::text) <= 65536),
  visual_analysis_limited boolean not null default false,
  source_changed boolean not null default false,
  status text not null default 'discovered' check (status in (
    'discovered', 'analyzing', 'needs_review', 'ready', 'applied', 'skipped', 'error'
  )),
  classification text check (classification is null or classification in ('product', 'non_product', 'uncertain')),
  classification_confidence numeric(5,4)
    check (classification_confidence is null or classification_confidence between 0 and 1),
  resulting_product_id bigint,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_media_items_org_id_key unique (organization_id, id),
  constraint instagram_media_items_external_key unique (organization_id, connection_id, external_media_id),
  constraint instagram_media_items_connection_fk foreign key (organization_id, connection_id)
    references instagram_connections(organization_id, id) on delete cascade,
  constraint instagram_media_items_product_fk foreign key (organization_id, resulting_product_id)
    references products(organization_id, id) on delete set null (resulting_product_id)
);

create index idx_instagram_media_items_org_status
  on instagram_media_items (organization_id, status, provider_timestamp desc, created_at desc);
create index idx_instagram_media_items_connection_seen
  on instagram_media_items (organization_id, connection_id, last_seen_at desc);

create table instagram_product_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  media_item_id uuid not null,
  revision integer not null default 1 check (revision between 1 and 10000),
  status text not null default 'pending' check (status in (
    'pending', 'analyzing', 'needs_review', 'ready', 'applying', 'applied', 'discarded', 'error'
  )),
  ai_provider text,
  ai_model text,
  prompt_version text,
  analysis_fingerprint char(64) check (analysis_fingerprint is null or analysis_fingerprint ~ '^[0-9a-f]{64}$'),
  analysis_started_at timestamptz,
  analysis_completed_at timestamptz,
  analysis_attempts smallint not null default 0 check (analysis_attempts between 0 and 5),
  analysis_available_at timestamptz not null default now(),
  analysis_locked_at timestamptz,
  analysis_usage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(analysis_usage) = 'object' and octet_length(analysis_usage::text) <= 8192),
  analysis_duration_ms integer check (analysis_duration_ms is null or analysis_duration_ms >= 0),
  product_name text check (product_name is null or length(product_name) <= 200),
  price numeric(12,2) check (price is null or price >= 0),
  price_explicit boolean not null default false,
  sale_price numeric(12,2) check (sale_price is null or sale_price >= 0),
  category_id bigint,
  category_confidence numeric(5,4) check (category_confidence is null or category_confidence between 0 and 1),
  colors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(colors) = 'array' and octet_length(colors::text) <= 16384),
  sizes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sizes) = 'array' and octet_length(sizes::text) <= 16384),
  fabric_info text check (fabric_info is null or length(fabric_info) <= 2000),
  measurements jsonb not null default '[]'::jsonb
    check (jsonb_typeof(measurements) = 'array' and octet_length(measurements::text) <= 16384),
  short_description text check (short_description is null or length(short_description) <= 1000),
  description text check (description is null or length(description) <= 5000),
  product_story text check (product_story is null or length(product_story) <= 5000),
  tags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(tags) = 'array' and octet_length(tags::text) <= 8192),
  warnings jsonb not null default '[]'::jsonb
    check (jsonb_typeof(warnings) = 'array' and octet_length(warnings::text) <= 16384),
  confidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(confidence) = 'object' and octet_length(confidence::text) <= 16384),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 32768),
  default_stock integer not null default 5 check (default_stock between 0 and 1000000),
  variant_stock jsonb not null default '{}'::jsonb
    check (jsonb_typeof(variant_stock) = 'object' and octet_length(variant_stock::text) <= 32768),
  error_code text check (error_code is null or length(error_code) <= 100),
  error_message text check (error_message is null or length(error_message) <= 1000),
  user_reviewed_at timestamptz,
  user_reviewed_by uuid references app_users(id) on delete set null,
  resulting_product_id bigint,
  apply_idempotency_key text check (apply_idempotency_key is null or length(apply_idempotency_key) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_product_drafts_org_id_key unique (organization_id, id),
  constraint instagram_product_drafts_media_key unique (organization_id, media_item_id),
  constraint instagram_product_drafts_apply_key unique (organization_id, apply_idempotency_key),
  constraint instagram_product_drafts_media_fk foreign key (organization_id, media_item_id)
    references instagram_media_items(organization_id, id) on delete cascade,
  constraint instagram_product_drafts_category_fk foreign key (organization_id, category_id)
    references categories(organization_id, id) on delete set null (category_id),
  constraint instagram_product_drafts_product_fk foreign key (organization_id, resulting_product_id)
    references products(organization_id, id) on delete set null (resulting_product_id),
  check (sale_price is null or price is null or sale_price <= price)
);

create index idx_instagram_product_drafts_claim
  on instagram_product_drafts (status, analysis_available_at, created_at)
  where status = 'pending';
create index idx_instagram_product_drafts_org_status
  on instagram_product_drafts (organization_id, status, updated_at desc);

create table instagram_product_draft_images (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  draft_id uuid not null,
  external_media_id text not null check (length(external_media_id) between 1 and 200),
  position integer not null check (position between 0 and 19),
  asset_id uuid not null,
  detail_url text not null check (length(detail_url) <= 2048),
  card_url text not null check (length(card_url) <= 2048),
  thumbnail_url text not null check (length(thumbnail_url) <= 2048),
  binding_type text not null default 'general' check (binding_type in ('general', 'color')),
  bound_color text check (bound_color is null or length(bound_color) <= 120),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  analysis_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(analysis_metadata) = 'object' and octet_length(analysis_metadata::text) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_product_draft_images_org_id_key unique (organization_id, id),
  constraint instagram_product_draft_images_position_key unique (organization_id, draft_id, position),
  constraint instagram_product_draft_images_source_key unique (organization_id, draft_id, external_media_id),
  constraint instagram_product_draft_images_draft_fk foreign key (organization_id, draft_id)
    references instagram_product_drafts(organization_id, id) on delete cascade,
  constraint instagram_product_draft_images_asset_fk foreign key (organization_id, asset_id)
    references upload_assets(organization_id, id) on delete restrict,
  check ((binding_type = 'general' and bound_color is null) or (binding_type = 'color' and bound_color is not null))
);

create index idx_instagram_product_draft_images_draft
  on instagram_product_draft_images (organization_id, draft_id, position);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'instagram_connections',
    'instagram_oauth_states',
    'instagram_media_items',
    'instagram_product_drafts',
    'instagram_product_draft_images'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid) with check (app_rls_bypassed() or organization_id = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid)',
      table_name || '_tenant_policy', table_name
    );
  end loop;
end $$;

comment on column instagram_connections.access_token_ciphertext is
  'AES-256-GCM ciphertext only; plaintext Instagram tokens must never be persisted.';
comment on column instagram_media_items.source_metadata is
  'Bounded, temporary official-provider media metadata; never a final product image URL.';
