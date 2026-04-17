alter table orders
  add column if not exists payment_provider text not null default 'manual',
  add column if not exists payment_token text,
  add column if not exists payment_id text,
  add column if not exists payment_error text;

create index if not exists idx_orders_payment_token on orders(payment_token);
