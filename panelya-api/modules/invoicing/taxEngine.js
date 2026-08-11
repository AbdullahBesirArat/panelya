function cents(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw Object.assign(new Error('Vergi tutari gecersiz'), { status: 400 });
  return Math.round(number * 100);
}

function money(value) { return Math.round(value) / 100; }

function discountByLine(items, allocations = []) {
  const lineGross = items.map((item) => cents(item.unit_price) * Number(item.quantity));
  const discounts = items.map(() => 0);
  const groups = new Map();
  items.forEach((item, index) => {
    const key = `${Number(item.product_id)}:${Number(item.variant_id || 0)}`;
    groups.set(key, [...(groups.get(key) || []), index]);
  });
  for (const allocation of allocations) {
    const key = `${Number(allocation.product_id)}:${Number(allocation.variant_id || 0)}`;
    const indexes = groups.get(key) || [];
    const base = indexes.reduce((sum, index) => sum + lineGross[index], 0);
    let remaining = cents(allocation.discount);
    indexes.forEach((index, position) => {
      const share = position === indexes.length - 1 ? remaining : Math.min(remaining, Math.round(cents(allocation.discount) * lineGross[index] / base));
      discounts[index] += share;
      remaining -= share;
    });
  }
  return discounts.map((discount, index) => Math.min(discount, lineGross[index]));
}

// A24.5: the gift-wrap fee is a non-item charge like shipping, but it is a goods-side
// charge rather than a carriage charge, so it is taxed at the tenant's default product
// rate under the same inclusive/exclusive policy. It carries no discount allocation:
// promotions apply to items and shipping, never to the wrap.
function calculateTaxSnapshot({ items, allocations = [], shippingFee = 0, giftWrapFee = 0, policy = 'inclusive', defaultRate = 0.2, shippingRate = 0.2, rates = [] }) {
  const rateByVariant = new Map();
  const rateByProduct = new Map();
  for (const row of rates) {
    if (row.variant_id) rateByVariant.set(Number(row.variant_id), Number(row.tax_rate));
    else rateByProduct.set(Number(row.product_id), Number(row.tax_rate));
  }
  const discounts = discountByLine(items, allocations);
  const lineSnapshots = items.map((item, index) => {
    const rate = rateByVariant.get(Number(item.variant_id)) ?? rateByProduct.get(Number(item.product_id)) ?? Number(defaultRate);
    const base = Math.max(cents(item.unit_price) * Number(item.quantity) - discounts[index], 0);
    const net = policy === 'inclusive' ? Math.round(base / (1 + rate)) : base;
    const tax = policy === 'inclusive' ? base - net : Math.round(net * rate);
    const gross = net + tax;
    return {
      ...item,
      tax_rate: rate,
      discount_allocation: money(discounts[index]),
      net_amount: money(net),
      tax_amount: money(tax),
      gross_amount: money(gross),
      tax_snapshot: { version: 1, policy, rate, net: money(net), tax: money(tax), gross: money(gross), discount: money(discounts[index]) },
    };
  });
  const shippingBase = cents(shippingFee);
  const shippingNet = policy === 'inclusive' ? Math.round(shippingBase / (1 + Number(shippingRate))) : shippingBase;
  const shippingTax = policy === 'inclusive' ? shippingBase - shippingNet : Math.round(shippingNet * Number(shippingRate));
  const giftBase = cents(giftWrapFee);
  const giftNet = policy === 'inclusive' ? Math.round(giftBase / (1 + Number(defaultRate))) : giftBase;
  const giftTax = policy === 'inclusive' ? giftBase - giftNet : Math.round(giftNet * Number(defaultRate));
  const itemsNet = lineSnapshots.reduce((sum, item) => sum + cents(item.net_amount), 0);
  const itemsTax = lineSnapshots.reduce((sum, item) => sum + cents(item.tax_amount), 0);
  const itemsGross = lineSnapshots.reduce((sum, item) => sum + cents(item.gross_amount), 0);
  const totals = {
    net: money(itemsNet + shippingNet + giftNet), tax: money(itemsTax + shippingTax + giftTax),
    gross: money(itemsGross + shippingNet + shippingTax + giftNet + giftTax), currency: 'TRY',
  };
  return {
    version: 1, policy, currency: 'TRY', items: lineSnapshots,
    shipping: { rate: Number(shippingRate), net: money(shippingNet), tax: money(shippingTax), gross: money(shippingNet + shippingTax) },
    giftWrap: { rate: Number(defaultRate), net: money(giftNet), tax: money(giftTax), gross: money(giftNet + giftTax) },
    totals,
  };
}

async function calculateCheckoutTax(client, { organizationId, items, pricing, giftWrapFee = 0 }) {
  const legal = await client.query(
    `select price_tax_policy, default_tax_rate, shipping_tax_rate
       from organization_legal_profiles where organization_id = $1`, [organizationId]
  );
  const settings = legal.rows[0] || { price_tax_policy: 'inclusive', default_tax_rate: 0.20, shipping_tax_rate: 0.20 };
  const productIds = [...new Set(items.map((item) => Number(item.product_id)))];
  const rates = await client.query(
    `select product_id, variant_id, tax_rate from product_tax_settings
      where organization_id = $1 and product_id = any($2::bigint[])`, [organizationId, productIds]
  );
  return calculateTaxSnapshot({
    items, allocations: pricing.allocations, shippingFee: pricing.shippingFee, giftWrapFee,
    policy: settings.price_tax_policy, defaultRate: settings.default_tax_rate,
    shippingRate: settings.shipping_tax_rate, rates: rates.rows,
  });
}

module.exports = { calculateCheckoutTax, calculateTaxSnapshot, cents, discountByLine, money };
