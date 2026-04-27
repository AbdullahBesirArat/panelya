alter table categories
  add column if not exists image_url text not null default '';

create table if not exists collections (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  slug text not null,
  description text not null default '',
  image_url text not null default '',
  link_url text not null default 'urunler.html',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_collections_org_slug_unique on collections (organization_id, slug);
create index if not exists idx_collections_org_active_sort on collections (organization_id, active, sort_order, id);
