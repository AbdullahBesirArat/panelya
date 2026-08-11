-- A32: the admin customer list searches name/email/phone together with an infix
-- term. The existing single-column B-tree indexes cannot support that query shape.
create index if not exists idx_customers_search_trgm
  on customers using gin (
    (catalog_search_normalize(organization_id::text || ' ' || name || ' ' || email || ' ' || phone)) gin_trgm_ops
  );

-- The same endpoint's empty-search/default path is tenant-scoped and newest-first.
create index if not exists idx_customers_org_created_desc
  on customers (organization_id, created_at desc);
