begin;

alter table products
  add column if not exists product_story text not null default '';

commit;
