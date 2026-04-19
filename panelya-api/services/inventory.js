function groupOrderItems(items) {
  const grouped = new Map();

  for (const item of items || []) {
    const productId = item.product_id || item.productId || item.id;
    if (!productId) continue;

    const key = String(productId);
    const quantity = Number(item.quantity || item.qty || 1);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    grouped.set(key, (grouped.get(key) || 0) + quantity);
  }

  return [...grouped.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
}

function stockError(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function stockPayload(items) {
  return JSON.stringify(items.map((item) => ({
    product_id: item.product_id,
    quantity: item.quantity,
  })));
}

async function reserveStock(client, items) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  const ids = grouped.map((item) => item.product_id);
  const result = await client.query(
    'select id, name, stock from products where id = any($1::bigint[]) for update',
    [ids]
  );
  const products = new Map(result.rows.map((product) => [String(product.id), product]));

  for (const item of grouped) {
    const product = products.get(String(item.product_id));
    if (!product) throw stockError(`Urun bulunamadi: ${item.product_id}`);
    if (Number(product.stock) < item.quantity) {
      throw stockError(`${product.name} icin yeterli stok yok. Kalan stok: ${product.stock}`);
    }
  }

  await client.query(
    `with requested as (
       select product_id, quantity
       from jsonb_to_recordset($1::jsonb) as item(product_id bigint, quantity int)
     )
     update products p
     set stock = p.stock - requested.quantity,
         status = case when p.stock - requested.quantity <= 0 then 'out' else p.status end,
         updated_at = now()
     from requested
     where p.id = requested.product_id`,
    [stockPayload(grouped)]
  );
}

async function restoreStock(client, items) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  await client.query(
    `with requested as (
       select product_id, quantity
       from jsonb_to_recordset($1::jsonb) as item(product_id bigint, quantity int)
     )
     update products p
     set stock = p.stock + requested.quantity,
         status = case when p.status = 'out' and p.stock + requested.quantity > 0 then 'active' else p.status end,
         updated_at = now()
     from requested
     where p.id = requested.product_id`,
    [stockPayload(grouped)]
  );
}

async function orderItems(client, orderId) {
  const result = await client.query(
    'select product_id, quantity from order_items where order_id = $1 and product_id is not null',
    [orderId]
  );
  return result.rows;
}

async function syncStockForStatusChange(client, orderId, previousStatus, nextStatus) {
  if (previousStatus === nextStatus) return;

  const items = await orderItems(client, orderId);
  if (nextStatus === 'cancelled' && previousStatus !== 'cancelled') {
    await restoreStock(client, items);
  }

  if (previousStatus === 'cancelled' && nextStatus !== 'cancelled') {
    await reserveStock(client, items);
  }
}

module.exports = {
  reserveStock,
  restoreStock,
  syncStockForStatusChange,
};
