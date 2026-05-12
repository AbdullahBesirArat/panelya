begin;

alter table products
  add column if not exists featured_in_category boolean not null default false;

create index if not exists idx_products_featured_in_category
  on products(organization_id, category_id)
  where featured_in_category = true;

commit;
