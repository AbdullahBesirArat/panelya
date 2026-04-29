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
       where id = any($1::bigint[]) and organization_id = $2`,
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

module.exports = {
  cartTotal,
  priceCartItems,
};
