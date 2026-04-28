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
      quantity: normalizeQuantity(item.quantity || item.qty || 1),
    }))
    .filter((item) => item.product_id > 0);

  if (!requested.length || requested.length > 50) {
    throw Object.assign(new Error('Siparis kalemi zorunlu'), { status: 400 });
  }

  const ids = [...new Set(requested.map((item) => item.product_id))];
  const params = [ids, organizationId];

  const result = await client.query(
    `select id, name, price, sale_price, status
     from products
     where id = any($1::int[]) and organization_id = $2`,
    params
  );
  const products = new Map(result.rows.map((product) => [Number(product.id), product]));

  return requested.map((item) => {
    const product = products.get(item.product_id);
    if (!product || product.status !== 'active') {
      throw Object.assign(new Error('Sepette gecersiz urun var'), { status: 400 });
    }

    return {
      product_id: item.product_id,
      name: product.name,
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
