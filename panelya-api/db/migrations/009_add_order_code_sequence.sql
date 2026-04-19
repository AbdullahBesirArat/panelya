create sequence if not exists order_code_seq
  as bigint
  start with 1001;

select setval(
  'order_code_seq',
  (
    select coalesce(
      max(nullif(regexp_replace(order_code, '\D', '', 'g'), '')::bigint),
      1000
    )
    from orders
  ),
  true
);
