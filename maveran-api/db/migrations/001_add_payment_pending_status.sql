alter table orders drop constraint if exists orders_status_check;

alter table orders
  add constraint orders_status_check
  check (status in ('new', 'payment_pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid'));
