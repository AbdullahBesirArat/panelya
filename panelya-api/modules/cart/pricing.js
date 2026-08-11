const { calculateCartPricing } = require('../../services/cartPricing');

const MAX_ITEMS = 50;
const MAX_QTY = 99;
// 'out' is a stock state set automatically when availability reaches zero, not an
// unpublish state ('draft'), so an out-of-stock line is still a real catalog line
// that stays in the cart. Truly unsellable lines use a status outside this set.
const SELLABLE_STATUSES = new Set(['active', 'out']);

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function emptyTotals() {
  return {
    itemCount: 0, subtotal: 0, discountTotal: 0, shippingTotal: 0,
    taxTotal: 0, grandTotal: 0, couponCode: '', pricingSnapshot: {},
  };
}

// Server-authoritative cart revalidation. Client-supplied prices are never
// trusted: catalog price, stock and the promotion/coupon engine are recomputed
// on every read. Unsellable lines (deleted/unpublished) are dropped; out-of-stock
// and price/quantity drift are surfaced as adjustments instead of throwing, so one
// stale line cannot break the cart and an out-of-stock line is preserved (never
// silently emptied) with checkout left to enforce availability.
// Shipping and tax stay 0 here (address-dependent) and are finalised at checkout.
async function repriceCart(client, organizationId, rawItems, { couponCode = '', customerId = null } = {}) {
  const items = (rawItems || []).slice(0, MAX_ITEMS);
  const adjustments = [];
  if (!items.length) {
    return { items: [], adjustments, coupon: null, couponCode: '', totals: emptyTotals() };
  }

  const productIds = [...new Set(items.map((i) => Number(i.product_id)).filter(Boolean))];
  const variantIds = [...new Set(items.map((i) => Number(i.variant_id)).filter(Boolean))];

  const productsResult = await client.query(
    `select id, name, price, sale_price, status from products
      where organization_id = $1 and id = any($2::bigint[])`,
    [organizationId, productIds]
  );
  const products = new Map(productsResult.rows.map((p) => [Number(p.id), p]));

  const variantsResult = variantIds.length
    ? await client.query(
      `select id, product_id, color, size, sku, available as stock, status, is_active
         from product_variants where organization_id = $1 and id = any($2::bigint[])`,
      [organizationId, variantIds]
    )
    : { rows: [] };
  const variants = new Map(variantsResult.rows.map((v) => [Number(v.id), v]));

  const priced = [];
  for (const item of items) {
    const productId = Number(item.product_id);
    const variantId = Number(item.variant_id);
    const requestedQty = Number(item.quantity) || 1;
    const product = products.get(productId);
    const variant = variants.get(variantId);

    if (!product || !SELLABLE_STATUSES.has(product.status) || !variant
        || Number(variant.product_id) !== productId
        || !SELLABLE_STATUSES.has(variant.status) || !variant.is_active) {
      adjustments.push({ code: 'ITEM_REMOVED', product_id: productId, variant_id: variantId, message: 'Urun artik satista degil ve sepetten cikarildi' });
      continue;
    }

    const unitPrice = roundMoney(product.sale_price ?? product.price);
    const previousPrice = item.unit_price_snapshot != null ? roundMoney(item.unit_price_snapshot) : null;
    if (previousPrice != null && previousPrice !== unitPrice) {
      adjustments.push({ code: 'PRICE_CHANGED', product_id: productId, variant_id: variantId, from: previousPrice, to: unitPrice, message: 'Urun fiyati guncellendi' });
    }

    const stock = Number(variant.stock) || 0;
    let quantity = Math.min(requestedQty, MAX_QTY);
    if (stock <= 0) {
      // Preserve out-of-stock lines rather than dropping them: the cart is never
      // silently emptied, the shopper is told, and checkout enforces availability
      // (order pricing rejects an 'out' product) so the cart stays intact to adjust.
      adjustments.push({ code: 'ITEM_OUT_OF_STOCK', product_id: productId, variant_id: variantId, message: 'Urun stokta kalmadi' });
    } else if (quantity > stock) {
      quantity = stock;
      adjustments.push({ code: 'QUANTITY_REDUCED', product_id: productId, variant_id: variantId, from: requestedQty, to: quantity, message: `Stok nedeniyle adet ${quantity} olarak guncellendi` });
    }

    priced.push({
      product_id: productId,
      variant_id: variantId,
      name: product.name,
      selected_color: variant.color,
      selected_size: variant.size,
      sku: variant.sku,
      quantity,
      unit_price: unitPrice,
    });
  }

  if (!priced.length) {
    return { items: [], adjustments, coupon: null, couponCode: '', totals: emptyTotals() };
  }

  const pricingOptions = { organizationId, shippingFee: 0, customerId, guestEmail: '', lockCoupon: false };
  let pricing;
  try {
    pricing = await calculateCartPricing(client, priced, { ...pricingOptions, couponCode });
  } catch (error) {
    if (!couponCode) throw error;
    adjustments.push({ code: 'COUPON_INVALID', message: error.message || 'Kupon artik gecerli degil' });
    pricing = await calculateCartPricing(client, priced, { ...pricingOptions, couponCode: '' });
  }

  const couponApplied = Boolean(pricing.coupon && pricing.coupon.applied);
  if (couponCode && !couponApplied
      && !adjustments.some((adjustment) => adjustment.code === 'COUPON_INVALID')) {
    adjustments.push({ code: 'COUPON_INVALID', message: (pricing.coupon && pricing.coupon.reason) || 'Kupon artik gecerli degil' });
  }

  const totals = {
    itemCount: priced.reduce((sum, i) => sum + i.quantity, 0),
    subtotal: roundMoney(pricing.subtotal),
    discountTotal: roundMoney(pricing.discount),
    shippingTotal: 0,
    taxTotal: 0,
    grandTotal: roundMoney(pricing.total),
    couponCode: couponApplied ? String(pricing.coupon.code || couponCode) : '',
    pricingSnapshot: pricing,
  };

  return { items: priced, adjustments, coupon: pricing.coupon || null, couponCode: totals.couponCode, totals };
}

module.exports = { repriceCart, roundMoney, emptyTotals, MAX_ITEMS, MAX_QTY };
