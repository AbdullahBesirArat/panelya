create index if not exists idx_orders_org_created_desc
  on orders (organization_id, created_at desc);

create index if not exists idx_orders_org_status_created_desc
  on orders (organization_id, status, created_at desc);

create index if not exists idx_orders_payment_pending_created
  on orders (created_at)
  where status = 'payment_pending';

create index if not exists idx_products_org_created_desc
  on products (organization_id, created_at desc);

create index if not exists idx_products_org_status_created_desc
  on products (organization_id, status, created_at desc);

create index if not exists idx_products_org_stock_updated_desc
  on products (organization_id, stock, updated_at desc);

create index if not exists idx_subscriptions_org_updated_created_desc
  on subscriptions (organization_id, updated_at desc, created_at desc);
