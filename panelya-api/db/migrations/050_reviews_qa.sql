-- A22: product reviews, ratings, helpful votes and product Q&A with tenant
-- moderation. Every table is tenant-scoped with FORCE RLS and tenant-aware
-- composite foreign keys. Content is stored as plain text (never HTML);
-- verified-purchase is server-derived; the published rating aggregate lives on
-- products and is recomputed transactionally by the service.

-- Published aggregate read model on products (published reviews only).
alter table products
  add column if not exists review_count integer not null default 0
    check (review_count >= 0),
  add column if not exists review_rating_avg numeric(3,2) not null default 0
    check (review_rating_avg >= 0 and review_rating_avg <= 5);

create table if not exists product_reviews (
  id bigserial primary key,
  organization_id uuid not null,
  product_id bigint not null,
  customer_account_id bigint not null,
  order_item_id bigint,
  rating smallint not null check (rating between 1 and 5),
  title text not null default '' check (char_length(title) <= 160),
  body text not null default '' check (char_length(body) <= 4000),
  status text not null default 'pending'
    check (status in ('pending','published','rejected','hidden')),
  verified_purchase boolean not null default false,
  helpful_count integer not null default 0 check (helpful_count >= 0),
  not_helpful_count integer not null default 0 check (not_helpful_count >= 0),
  flagged_reason text not null default '' check (char_length(flagged_reason) <= 200),
  rejection_reason text not null default '' check (char_length(rejection_reason) <= 500),
  moderated_by uuid references app_users(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_reviews_org_id_key unique (organization_id, id),
  -- Business rule: one review per customer account per product.
  constraint product_reviews_one_per_customer unique (organization_id, product_id, customer_account_id),
  constraint product_reviews_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade,
  constraint product_reviews_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete cascade,
  constraint product_reviews_order_item_fk foreign key (organization_id, order_item_id)
    references order_items (organization_id, id) on delete set null
);
create index if not exists idx_product_reviews_product_status
  on product_reviews (organization_id, product_id, status, created_at desc);

create table if not exists review_media (
  organization_id uuid not null,
  review_id bigint not null,
  upload_asset_id uuid not null,
  attached_at timestamptz not null default now(),
  primary key (review_id, upload_asset_id),
  foreign key (organization_id, review_id)
    references product_reviews (organization_id, id) on delete cascade,
  foreign key (organization_id, upload_asset_id)
    references upload_assets (organization_id, id) on delete restrict
);

create table if not exists review_votes (
  id bigserial primary key,
  organization_id uuid not null,
  review_id bigint not null,
  -- Opaque per-voter identity (customer account or guest cart token, hashed), so a
  -- single actor gets a single vote without storing a raw identifier.
  voter_hash char(64) not null check (voter_hash ~ '^[0-9a-f]{64}$'),
  customer_account_id bigint,
  vote_type text not null check (vote_type in ('helpful','not_helpful')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_votes_org_id_key unique (organization_id, id),
  constraint review_votes_unique_voter unique (organization_id, review_id, voter_hash),
  constraint review_votes_review_fk foreign key (organization_id, review_id)
    references product_reviews (organization_id, id) on delete cascade,
  constraint review_votes_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete set null
);

create table if not exists product_questions (
  id bigserial primary key,
  organization_id uuid not null,
  product_id bigint not null,
  customer_account_id bigint,
  asker_name text not null default '' check (char_length(asker_name) <= 120),
  -- Guest contact is hashed (rate-limit/dedup only); raw PII never persisted here.
  contact_email_hash char(64),
  body text not null check (char_length(body) between 1 and 2000),
  status text not null default 'pending'
    check (status in ('pending','published','rejected','hidden')),
  answer_count integer not null default 0 check (answer_count >= 0),
  flagged_reason text not null default '' check (char_length(flagged_reason) <= 200),
  rejection_reason text not null default '' check (char_length(rejection_reason) <= 500),
  moderated_by uuid references app_users(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_questions_org_id_key unique (organization_id, id),
  constraint product_questions_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade,
  constraint product_questions_account_fk foreign key (organization_id, customer_account_id)
    references customer_accounts (organization_id, id) on delete set null
);
create index if not exists idx_product_questions_product_status
  on product_questions (organization_id, product_id, status, created_at desc);

create table if not exists product_answers (
  id bigserial primary key,
  organization_id uuid not null,
  question_id bigint not null,
  body text not null check (char_length(body) between 1 and 4000),
  author_type text not null check (author_type in ('store','customer')),
  author_user_id uuid references app_users(id) on delete set null,
  author_account_id bigint,
  is_official boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending','published','rejected','hidden')),
  moderated_by uuid references app_users(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_answers_org_id_key unique (organization_id, id),
  constraint product_answers_question_fk foreign key (organization_id, question_id)
    references product_questions (organization_id, id) on delete cascade,
  constraint product_answers_account_fk foreign key (organization_id, author_account_id)
    references customer_accounts (organization_id, id) on delete set null
);
create index if not exists idx_product_answers_question
  on product_answers (organization_id, question_id, status, created_at);

do $$
declare table_name text;
begin
  foreach table_name in array array['product_reviews','review_media','review_votes','product_questions','product_answers'] loop
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
