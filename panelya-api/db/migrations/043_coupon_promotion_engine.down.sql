alter table orders no force row level security;

drop table if exists coupon_redemptions;
drop table if exists coupon_collections;
drop table if exists coupon_categories;
drop table if exists coupon_products;
drop table if exists coupons;

alter table orders
  drop column if exists promotion_snapshot,
  drop column if exists coupon_code,
  drop column if exists shipping_discount,
  drop column if exists coupon_discount,
  drop column if exists campaign_discount,
  drop column if exists discount_total,
  drop column if exists subtotal;

alter table orders force row level security;

