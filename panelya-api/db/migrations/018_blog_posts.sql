create table if not exists blog_posts (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  slug text not null,
  excerpt text not null default '',
  content text not null default '',
  image_url text not null default '',
  active boolean not null default true,
  sort_order integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_blog_posts_org_slug_unique
  on blog_posts(organization_id, slug);

create index if not exists idx_blog_posts_org_active_sort
  on blog_posts(organization_id, active, sort_order, published_at desc);
