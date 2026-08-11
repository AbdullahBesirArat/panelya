const PRODUCT_STATUSES = ['active', 'draft', 'out'];
const VARIANT_STATUSES = ['active', 'out'];

function normalizeProductIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200);
}

function normalizeStockUpdates(rawUpdates) {
  const updates = Array.isArray(rawUpdates) ? rawUpdates : [];
  const seen = new Set();
  return updates.map((raw) => {
    const productId = Number(raw.product_id || raw.productId || raw.id || 0);
    const variantId = Number(raw.variant_id || raw.variantId || 0) || null;
    const stock = Number(raw.stock);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isFinite(stock) || stock < 0) return null;
    if (variantId != null && (!Number.isInteger(variantId) || variantId < 1)) return null;
    const key = `${productId}:${variantId || ''}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { product_id: productId, variant_id: variantId, stock: Math.floor(stock) };
  }).filter(Boolean).slice(0, 200);
}

function safePaging(limit, offset, defaultLimit = 50) {
  return {
    limit: Math.min(Math.max(Number(limit) || defaultLimit, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

function normalizeText(value, limit = 120) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeVariants(rawVariants) {
  if (!Array.isArray(rawVariants)) return [];
  const seen = new Set();
  const variants = [];
  for (const rawVariant of rawVariants.slice(0, 300)) {
    const color = normalizeText(rawVariant.color || rawVariant.selected_color || '', 80);
    const size = normalizeText(rawVariant.size || rawVariant.selected_size || '', 80);
    const sku = normalizeText(rawVariant.sku || '', 120);
    const stock = Number(rawVariant.stock || 0);
    const status = VARIANT_STATUSES.includes(rawVariant.status) ? rawVariant.status : 'active';
    if (!color && !size) continue;
    if (!Number.isFinite(stock) || stock < 0) continue;
    const key = `${color.toLowerCase()}::${size.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ color, size, sku, stock: Math.floor(stock), status: Math.floor(stock) <= 0 ? 'out' : status });
  }
  return variants;
}

function productParams(body, options = {}) {
  const price = Number(body.price);
  const salePrice = body.sale_price == null || body.sale_price === '' ? null : Number(body.sale_price);
  const variants = normalizeVariants(body.variants);
  const stock = variants.length ? variants.reduce((sum, variant) => sum + variant.stock, 0) : Number(body.stock || 0);
  const status = PRODUCT_STATUSES.includes(body.status) ? body.status : 'draft';
  if (!String(body.name || '').trim() || !Number.isFinite(price) || price <= 0) {
    throw Object.assign(new Error('Urun adi ve gecerli fiyat zorunlu'), { status: 400 });
  }
  if (Number.isFinite(salePrice) && salePrice > price) {
    throw Object.assign(new Error('Indirimli fiyat normal fiyattan yuksek olamaz'), { status: 400 });
  }
  return [
    String(body.name).trim().slice(0, 200),
    body.category_id ? Number(body.category_id) : null,
    price,
    Number.isFinite(salePrice) ? salePrice : null,
    Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0,
    status,
    JSON.stringify(Array.isArray(body.colors) ? body.colors.slice(0, 20) : []),
    JSON.stringify(Array.isArray(body.sizes) ? body.sizes.slice(0, 30) : []),
    JSON.stringify(Array.isArray(body.images) ? body.images.slice(0, 20) : []),
    JSON.stringify(body.details && typeof body.details === 'object' ? body.details : {}),
    String(body.tags || '').slice(0, 500),
    String(body.description || '').slice(0, 5000),
    String(body.product_story || '').slice(0, 5000),
    options.preserveMissingEmoji && !Object.prototype.hasOwnProperty.call(body, 'emoji') ? null : String(body.emoji || '').slice(0, 16),
    Boolean(body.featured_in_category),
  ];
}

module.exports = {
  PRODUCT_STATUSES,
  normalizeProductIds,
  normalizeStockUpdates,
  safePaging,
  normalizeVariants,
  productParams,
};
