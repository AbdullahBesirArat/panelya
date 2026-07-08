-- 035_product_variant_is_active.sql
-- Urun varyanti "kaldirildi ama gecmis siparise bagli" durumunu temsil etmek
-- icin pasiflik alani. product_variants.status ('active'/'out') stok durumunu
-- ifade eder; kaldirilmis varyanti fiziksel silmeden gizlemek icin ayri bir
-- bayrak gerekir. Additive ve geri-guvenli (default true = mevcut tum
-- varyantlar aktif kalir). Geri donus: 035_..._down.sql
--
-- Amac: urun guncellemesinde varyantlar silinip yeniden yaratilmasin; boylece
-- order_items.variant_id bagi (on delete set null) kopmasin ve stok iadesi
-- dogru varyanta yazilsin.

alter table product_variants
  add column if not exists is_active boolean not null default true;

-- Aktif varyant sorgularini hizlandirmak icin kismi index.
create index if not exists idx_product_variants_active
  on product_variants (product_id)
  where is_active;
