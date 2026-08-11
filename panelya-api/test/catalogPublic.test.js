const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildCatalogFilter } = require('../modules/catalog/publicRepository');
const { catalogCacheKey, responseEtag } = require('../modules/catalog/publicCache');
const { SORT_SQL, parseCatalogQuery } = require('../modules/catalog/publicValidation');

test('catalog query applies safe pagination defaults and aliases', () => {
  const query = parseCatalogQuery({ limit: '12', category_id: '4', colors: 'Mavi,Beyaz', max_price: '2500' });
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 12);
  assert.equal(query.category, '4');
  assert.deepEqual(query.colors, ['Mavi', 'Beyaz']);
  assert.equal(query.maxPrice, 2500);
});

test('catalog page size is capped and invalid pages are rejected', () => {
  assert.throws(() => parseCatalogQuery({ pageSize: '61' }), /pageSize gecersiz/);
  assert.throws(() => parseCatalogQuery({ page: '0' }), /page gecersiz/);
  assert.throws(() => parseCatalogQuery({ page: '1.5' }), /page gecersiz/);
});

test('catalog rejects arbitrary sort values and invalid prices', () => {
  assert.throws(() => parseCatalogQuery({ sort: 'created_at desc; drop table products' }), /sort/);
  assert.throws(() => parseCatalogQuery({ minPrice: 'abc' }), /minPrice/);
  assert.throws(() => parseCatalogQuery({ minPrice: '50', maxPrice: '10' }), /Fiyat araligi/);
  assert.ok(Object.values(SORT_SQL).every((sql) => !sql.includes(';')));
});

test('multiple catalog filters use bind placeholders, never raw user input', () => {
  const query = parseCatalogQuery({
    q: "elbise' or true --",
    category: 'elbise',
    collection: 'yaz',
    color: ['Mavi', 'Beyaz'],
    size: 'M,L',
    minPrice: '100',
    maxPrice: '2000',
    availability: 'in_stock',
    tag: 'yeni',
  });
  const filter = buildCatalogFilter('00000000-0000-0000-0000-000000000001', query);
  assert.doesNotMatch(filter.where, /elbise' or true|\byaz\b|\bMavi\b/);
  assert.ok(filter.params.includes("elbise' or true --"));
  assert.ok(filter.params.some((value) => Array.isArray(value) && value.includes('Mavi')));
  assert.match(filter.where, /product_collections/);
  assert.match(filter.where, /selected_variant/);
});

test('disjunctive facet filters exclude only their own selected dimension', () => {
  const query = parseCatalogQuery({ category: '2', collection: 'summer', color: 'Mavi', size: 'M' });
  const categoryFilter = buildCatalogFilter('org', query, { excludeFacet: 'category' });
  const colorFilter = buildCatalogFilter('org', query, { excludeFacet: 'color' });
  assert.doesNotMatch(categoryFilter.where, /p\.category_id/);
  assert.match(categoryFilter.where, /selected_collection/);
  assert.match(colorFilter.where, /p\.category_id/);
  assert.deepEqual(colorFilter.params.some((value) => Array.isArray(value) && value.includes('Mavi')), false);
  assert.deepEqual(colorFilter.params.some((value) => Array.isArray(value) && value.includes('M')), true);
});

test('catalog cache keys isolate tenant, domain and normalized query', () => {
  const base = { organizationId: 'org-a', organizationSlug: 'a', host: 'shop.example', query: { page: 1, q: '' } };
  const first = catalogCacheKey(base);
  assert.equal(first, catalogCacheKey({ ...base, query: { q: '', page: 1 } }));
  assert.notEqual(first, catalogCacheKey({ ...base, organizationId: 'org-b' }));
  assert.notEqual(first, catalogCacheKey({ ...base, host: 'other.example' }));
  assert.notEqual(first, catalogCacheKey({ ...base, query: { page: 2, q: '' } }));
});

test('catalog ETag includes tenant cache identity and response body', () => {
  assert.notEqual(responseEtag('tenant-a', { total: 1 }), responseEtag('tenant-b', { total: 1 }));
  assert.notEqual(responseEtag('tenant-a', { total: 1 }), responseEtag('tenant-a', { total: 2 }));
});

test('catalog migration defines Turkish search and measured-query indexes', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/040_public_catalog_search.sql'), 'utf8');
  assert.match(migration, /requires pg_trgm/i);
  assert.match(migration, /requires unaccent/i);
  assert.match(migration, /catalog_search_normalize/i);
  assert.match(migration, /gin_trgm_ops/i);
  assert.match(migration, /effective_price/i);
});

test('A32 customer search query and migration share the normalized trigram access path', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/071_customer_search_query_indexes.sql'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../routes/customers.js'), 'utf8');
  assert.match(migration, /idx_customers_search_trgm/);
  assert.match(migration, /gin_trgm_ops/);
  assert.match(migration, /idx_customers_org_created_desc/);
  assert.match(route, /catalog_search_normalize\(c\.organization_id::text \|\| ' ' \|\| c\.name/);
  assert.match(route, /catalog_search_normalize\(\$1::text\)/);
  assert.doesNotMatch(route, /c\.name ilike \$2 or c\.email ilike/);
});
