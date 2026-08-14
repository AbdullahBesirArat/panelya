do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    raise exception 'A12 requires pg_trgm; provision it with DATABASE_ADMIN_URL before migrations';
  end if;
  if not exists (select 1 from pg_extension where extname = 'unaccent') then
    raise exception 'A12 requires unaccent; provision it with DATABASE_ADMIN_URL before migrations';
  end if;
end $$;

create or replace function catalog_search_normalize(value text)
returns text
language sql
immutable
parallel safe
as $$
  select public.unaccent(
    'public.unaccent'::regdictionary,
    lower(translate(coalesce(value, ''), 'Iİı', 'iii'))
  )
$$;

create index if not exists idx_products_catalog_scope_created
  on products (organization_id, status, created_at desc, id desc);

create index if not exists idx_products_catalog_effective_price
  on products (organization_id, status, (coalesce(nullif(sale_price, 0), price)), id);

create index if not exists idx_products_catalog_search_trgm
  on products using gin (
    catalog_search_normalize(name || ' ' || tags || ' ' || description) gin_trgm_ops
  );

create index if not exists idx_product_variants_catalog_active
  on product_variants (organization_id, product_id, is_active, status, stock);

create index if not exists idx_product_variants_catalog_color
  on product_variants (organization_id, catalog_search_normalize(color), product_id)
  where is_active and trim(color) <> '';

create index if not exists idx_product_variants_catalog_size
  on product_variants (organization_id, catalog_search_normalize(size), product_id)
  where is_active and trim(size) <> '';

create index if not exists idx_collections_catalog_lookup
  on collections (organization_id, active, slug, id);
