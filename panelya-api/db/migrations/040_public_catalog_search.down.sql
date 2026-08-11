drop index if exists idx_collections_catalog_lookup;
drop index if exists idx_product_variants_catalog_size;
drop index if exists idx_product_variants_catalog_color;
drop index if exists idx_product_variants_catalog_active;
drop index if exists idx_products_catalog_search_trgm;
drop index if exists idx_products_catalog_effective_price;
drop index if exists idx_products_catalog_scope_created;
drop function if exists catalog_search_normalize(text);

-- pg_trgm and unaccent may be shared by other features; rollback intentionally
-- leaves both extensions installed.
