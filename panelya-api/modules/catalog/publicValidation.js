const SORT_SQL = Object.freeze({
  recommended: 'p.featured_in_category desc, p.created_at desc, p.id desc',
  newest: 'p.created_at desc, p.id desc',
  best_selling: `coalesce((
    select sum(sold_item.quantity)
    from order_items sold_item
    join orders sold_order
      on sold_order.id = sold_item.order_id
     and sold_order.organization_id = sold_item.organization_id
    where sold_item.organization_id = p.organization_id
      and sold_item.product_id = p.id
      and sold_order.payment_status = 'paid'
  ), 0) desc, p.created_at desc, p.id desc`,
  oldest: 'p.created_at asc, p.id asc',
  price_asc: 'coalesce(nullif(p.sale_price, 0), p.price) asc, p.id asc',
  price_desc: 'coalesce(nullif(p.sale_price, 0), p.price) desc, p.id desc',
  name_asc: 'catalog_search_normalize(p.name) asc, p.id asc',
});
const SORT_ALIASES = Object.freeze({
  'price-asc': 'price_asc',
  'price-desc': 'price_desc',
  'name-asc': 'name_asc',
});

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw validationError(`${name} gecersiz`);
  }
  return number;
}

function boundedText(value, maximum, name) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  if (text.length > maximum) throw validationError(`${name} cok uzun`);
  return text;
}

function textList(value, name) {
  const source = Array.isArray(value) ? value : [value];
  const values = source.flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length > 20 || values.some((item) => item.length > 80)) {
    throw validationError(`${name} gecersiz`);
  }
  return [...new Set(values)];
}

function optionalPrice(value, name) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100000000) {
    throw validationError(`${name} gecersiz`);
  }
  return number;
}

function optionalAvailability(value) {
  if (value == null || value === '' || value === 'all') return null;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'in_stock', 'available'].includes(normalized)) return true;
  if (['0', 'false', 'out_of_stock', 'unavailable'].includes(normalized)) return false;
  throw validationError('availability gecersiz');
}

function activeOnly(value) {
  if (value == null || value === '' || value === 'all') return false;
  if (String(value).toLowerCase() === 'active') return true;
  throw validationError('status gecersiz');
}

function parseCatalogQuery(query = {}) {
  const requestedSort = boundedText(query.sort || 'recommended', 30, 'sort').toLowerCase();
  const sort = SORT_ALIASES[requestedSort] || requestedSort;
  if (!Object.prototype.hasOwnProperty.call(SORT_SQL, sort)) throw validationError('sort gecersiz');
  const minPrice = optionalPrice(query.minPrice ?? query.min_price, 'minPrice');
  const maxPrice = optionalPrice(query.maxPrice ?? query.max_price, 'maxPrice');
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw validationError('Fiyat araligi gecersiz');
  }

  return Object.freeze({
    q: boundedText(query.q, 120, 'q'),
    page: boundedInteger(query.page, 1, 1, 100000, 'page'),
    pageSize: boundedInteger(query.pageSize ?? query.page_size ?? query.limit, 24, 1, 60, 'pageSize'),
    sort,
    activeOnly: activeOnly(query.status),
    category: boundedText(query.category ?? query.category_id, 120, 'category'),
    collection: boundedText(query.collection ?? query.collection_slug, 120, 'collection'),
    colors: textList(query.color ?? query.colors, 'color'),
    sizes: textList(query.size ?? query.sizes, 'size'),
    minPrice,
    maxPrice,
    availability: optionalAvailability(query.availability ?? query.inStock ?? query.in_stock),
    tag: boundedText(query.tag, 80, 'tag'),
  });
}

module.exports = { SORT_SQL, parseCatalogQuery, validationError };
