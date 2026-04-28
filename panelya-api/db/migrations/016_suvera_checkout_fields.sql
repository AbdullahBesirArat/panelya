alter table orders
  add column if not exists payment_method text not null default 'card',
  add column if not exists note text not null default '',
  add column if not exists gift_wrap boolean not null default false,
  add column if not exists shipping_fee numeric(12,2) not null default 0;

alter table orders
  drop constraint if exists orders_payment_method_check;

update orders
set payment_method = 'iban'
where payment_method in ('manual', 'transfer');

alter table orders
  add constraint orders_payment_method_check
  check (payment_method in ('card', 'iban'));
