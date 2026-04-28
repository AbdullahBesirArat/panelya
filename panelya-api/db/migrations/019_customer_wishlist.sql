create table if not exists customer_wishlist (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_email text not null,
  product_id bigint not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, customer_email, product_id)
);

create index if not exists idx_customer_wishlist_org_email
  on customer_wishlist (organization_id, lower(customer_email), created_at desc);

create index if not exists idx_customer_wishlist_product
  on customer_wishlist (product_id);
