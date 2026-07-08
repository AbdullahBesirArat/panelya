-- Rollback 035_product_variant_is_active.sql
drop index if exists idx_product_variants_active;

alter table product_variants
  drop column if exists is_active;
