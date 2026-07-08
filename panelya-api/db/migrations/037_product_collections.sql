create table if not exists product_collections (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  collection_id bigint not null references collections(id) on delete cascade,
  product_id bigint not null references products(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_product_collections_unique
  on product_collections (organization_id, collection_id, product_id);

create index if not exists idx_product_collections_product
  on product_collections (organization_id, product_id);

insert into product_collections (organization_id, collection_id, product_id)
select c.organization_id, c.id, p.id
from collections c
join products p on p.organization_id = c.organization_id
where exists (
  select 1
  from regexp_split_to_table(coalesce(p.tags, ''), ',') as tag(value)
  where lower(trim(tag.value)) = lower(c.slug)
)
on conflict (organization_id, collection_id, product_id) do nothing;
