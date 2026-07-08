function normalizeQuantity(value) {
  const quantity = Number(value || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw Object.assign(new Error('Gecersiz sepet adedi'), { status: 400 });
  }
  return quantity;
}

async function priceCartItems(client, rawItems, { organizationId = null } = {}) {
  if (!organizationId) {
    throw Object.assign(new Error('organizationId zorunlu'), { status: 500 });
  }

  const requested = (rawItems || [])
    .map((item) => ({
      product_id: Number(item.product_id || item.id || 0),
      variant_id: Number(item.variant_id || item.variantId || 0) || null,
      selected_color: String(item.color || item.selected_color || '').trim().slice(0, 80),
      selected_size: String(item.size || item.selected_size || '').trim().slice(0, 80),
      quantity: normalizeQuantity(item.quantity || item.qty || 1),
    }))
    .filter((item) => item.product_id > 0);

  if (!requested.length || requested.length > 50) {
    throw Object.assign(new Error('Siparis kalemi zorunlu'), { status: 400 });
  }

  const ids = [...new Set(requested.map((item) => item.product_id))];
  const params = [ids, organizationId];

  const productsResult = await client.query(
    `select id, name, price, sale_price, status
     from products
     where id = any($1::int[]) and organization_id = $2`,
    params
  );
  const products = new Map(productsResult.rows.map((product) => [Number(product.id), product]));

  const variantIds = [...new Set(requested.map((item) => item.variant_id).filter(Boolean))];
  const variantsResult = variantIds.length
    ? await client.query(
      `select id, product_id, color, size, sku, stock, status
       from product_variants
       where id = any($1::bigint[]) and organization_id = $2 and is_active`,
      [variantIds, organizationId]
    )
    : { rows: [] };
  const variants = new Map(variantsResult.rows.map((variant) => [Number(variant.id), variant]));

  return requested.map((item) => {
    const product = products.get(item.product_id);
    if (!product || product.status !== 'active') {
      throw Object.assign(new Error('Sepette gecersiz urun var'), { status: 400 });
    }

    const variant = item.variant_id ? variants.get(item.variant_id) : null;
    if (item.variant_id && (!variant || Number(variant.product_id) !== item.product_id || variant.status !== 'active')) {
      throw Object.assign(new Error('Secilen renk/beden stokta yok'), { status: 400 });
    }

    return {
      product_id: item.product_id,
      variant_id: variant ? Number(variant.id) : null,
      name: product.name,
      selected_color: variant ? variant.color : item.selected_color,
      selected_size: variant ? variant.size : item.selected_size,
      sku: variant ? variant.sku : '',
      quantity: item.quantity,
      unit_price: Number(product.sale_price ?? product.price),
    };
  });
}

function cartTotal(items) {
  return items.reduce(
    (sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 1),
    0
  );
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function campaignDiscount(campaign, subtotal) {
  if (!campaign || subtotal <= 0) return 0;

  const type = String(campaign.type || '').trim().toLowerCase();
  const value = Number(campaign.value || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;

  if (['percentage', 'percent', 'yuzde', 'oran'].includes(type)) {
    return roundMoney(Math.min(subtotal, subtotal * Math.min(value, 100) / 100));
  }
  if (['fixed', 'amount', 'sabit', 'tl'].includes(type)) {
    return roundMoney(Math.min(subtotal, value));
  }
  return 0;
}

async function selectActiveCampaign(client, organizationId, subtotal) {
  const result = await client.query(
    `select id, name, type, value, end_date
     from campaigns
     where organization_id = $1
       and active = true
       and (end_date is null or end_date >= current_date)
     order by end_date nulls last, id desc
     limit 10`,
    [organizationId]
  );

  return result.rows.find((campaign) => campaignDiscount(campaign, subtotal) > 0) || null;
}

async function calculateCartPricing(client, items, { organizationId, shippingFee = 0 } = {}) {
  const subtotal = roundMoney(cartTotal(items));
  const campaign = await selectActiveCampaign(client, organizationId, subtotal);
  const discount = campaignDiscount(campaign, subtotal);
  const discountedSubtotal = roundMoney(Math.max(0, subtotal - discount));
  const safeShippingFee = roundMoney(Math.max(0, Number(shippingFee || 0)));
  const total = roundMoney(discountedSubtotal + safeShippingFee);

  return {
    subtotal,
    discount,
    discountedSubtotal,
    shippingFee: safeShippingFee,
    total,
    campaign: campaign ? {
      id: campaign.id,
      name: campaign.name,
      type: campaign.type,
      value: campaign.value,
    } : null,
  };
}

module.exports = {
  calculateCartPricing,
  campaignDiscount,
  cartTotal,
  priceCartItems,
  selectActiveCampaign,
};
