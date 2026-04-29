function groupOrderItems(items) {
  const grouped = new Map();

  for (const item of items || []) {
    const productId = item.product_id || item.productId || item.id;
    if (!productId) continue;
    const variantId = item.variant_id || item.variantId || null;

    const key = variantId ? `variant:${variantId}` : `product:${productId}`;
    const quantity = Number(item.quantity || item.qty || 1);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const current = grouped.get(key) || {
      product_id: productId,
      variant_id: variantId,
      quantity: 0,
    };
    current.quantity += quantity;
    grouped.set(key, current);
  }

  return [...grouped.values()];
}

function stockError(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function stockPayload(items) {
  return JSON.stringify(items.map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id || null,
      quantity: item.quantity,
    })));
}

async function syncProductStock(client, productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (!ids.length) return;

  await client.query(
    `update products p
     set stock = coalesce(variant_stock.total_stock, p.stock),
         status = case
           when coalesce(variant_stock.total_stock, p.stock) <= 0 then 'out'
           when p.status = 'out' and coalesce(variant_stock.total_stock, p.stock) > 0 then 'active'
           else p.status
         end,
         updated_at = now()
     from (
       select product_id, sum(stock)::int as total_stock
       from product_variants
       where product_id = any($1::bigint[])
       group by product_id
     ) variant_stock
     where p.id = variant_stock.product_id`,
    [ids]
  );
}

async function reserveStock(client, items) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  const productItems = grouped.filter((item) => !item.variant_id);
  const variantItems = grouped.filter((item) => item.variant_id);
  const ids = productItems.map((item) => item.product_id);
  const variantIds = variantItems.map((item) => item.variant_id);

  const result = ids.length ? await client.query(
    'select id, name, stock from products where id = any($1::bigint[]) for update',
    [ids]
  ) : { rows: [] };
  const products = new Map(result.rows.map((product) => [String(product.id), product]));
  const variantResult = variantIds.length ? await client.query(
    `select pv.id, pv.product_id, pv.color, pv.size, pv.stock, p.name
     from product_variants pv
     join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
     where pv.id = any($1::bigint[]) for update`,
    [variantIds]
  ) : { rows: [] };
  const variants = new Map(variantResult.rows.map((variant) => [String(variant.id), variant]));

  for (const item of productItems) {
    const product = products.get(String(item.product_id));
    if (!product) throw stockError(`Urun bulunamadi: ${item.product_id}`);
    if (Number(product.stock) < item.quantity) {
      throw stockError(`${product.name} icin yeterli stok yok. Kalan stok: ${product.stock}`);
    }
  }

  for (const item of variantItems) {
    const variant = variants.get(String(item.variant_id));
    if (!variant) throw stockError(`Varyant bulunamadi: ${item.variant_id}`);
    if (Number(variant.stock) < item.quantity) {
      const optionLabel = [variant.color, variant.size].filter(Boolean).join(' / ');
      throw stockError(`${variant.name} (${optionLabel}) icin yeterli stok yok. Kalan stok: ${variant.stock}`);
    }
  }

  if (productItems.length) await client.query(
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
    [stockPayload(productItems)]
  );

  if (variantItems.length) {
    await client.query(
      `with requested as (
         select variant_id, quantity
         from jsonb_to_recordset($1::jsonb) as item(variant_id bigint, quantity int)
       )
       update product_variants pv
       set stock = pv.stock - requested.quantity,
           status = case when pv.stock - requested.quantity <= 0 then 'out' else pv.status end,
           updated_at = now()
       from requested
       where pv.id = requested.variant_id`,
      [stockPayload(variantItems)]
    );
    await syncProductStock(client, variantItems.map((item) => item.product_id));
  }
}

async function restoreStock(client, items) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  const productItems = grouped.filter((item) => !item.variant_id);
  const variantItems = grouped.filter((item) => item.variant_id);

  if (productItems.length) await client.query(
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
    [stockPayload(productItems)]
  );

  if (variantItems.length) {
    await client.query(
      `with requested as (
         select variant_id, quantity
         from jsonb_to_recordset($1::jsonb) as item(variant_id bigint, quantity int)
       )
       update product_variants pv
       set stock = pv.stock + requested.quantity,
           status = case when pv.status = 'out' and pv.stock + requested.quantity > 0 then 'active' else pv.status end,
           updated_at = now()
       from requested
       where pv.id = requested.variant_id`,
      [stockPayload(variantItems)]
    );
    await syncProductStock(client, variantItems.map((item) => item.product_id));
  }
}

async function orderItems(client, orderId) {
  const result = await client.query(
    'select product_id, variant_id, quantity from order_items where order_id = $1 and product_id is not null',
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
