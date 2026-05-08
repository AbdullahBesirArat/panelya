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

async function syncProductStock(client, productIds, { organizationId = null } = {}) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (!ids.length) return;

  const params = [ids];
  const filters = ['product_id = any($1::bigint[])'];
  const productFilters = ['p.id = variant_stock.product_id'];
  if (organizationId) {
    params.push(organizationId);
    filters.push(`organization_id = $${params.length}`);
    productFilters.push(`p.organization_id = $${params.length}`);
  }

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
       where ${filters.join(' and ')}
       group by product_id
     ) variant_stock
     where ${productFilters.join(' and ')}`,
    params
  );
}

async function reserveStock(client, items, { organizationId = null } = {}) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  const productItems = grouped.filter((item) => !item.variant_id);
  const variantItems = grouped.filter((item) => item.variant_id);
  const ids = productItems.map((item) => item.product_id);
  const variantIds = variantItems.map((item) => item.variant_id);

  const productParams = [ids];
  const productScope = organizationId ? ' and organization_id = $2' : '';
  if (organizationId) productParams.push(organizationId);
  const result = ids.length ? await client.query(
    `select id, name, stock from products where id = any($1::bigint[])${productScope} for update`,
    productParams
  ) : { rows: [] };
  const products = new Map(result.rows.map((product) => [String(product.id), product]));
  const variantParams = [variantIds];
  const variantScope = organizationId ? ' and pv.organization_id = $2' : '';
  if (organizationId) variantParams.push(organizationId);
  const variantResult = variantIds.length ? await client.query(
    `select pv.id, pv.product_id, pv.color, pv.size, pv.stock, p.name
     from product_variants pv
     join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
     where pv.id = any($1::bigint[])${variantScope} for update`,
    variantParams
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

  if (productItems.length) {
    const updateParams = [stockPayload(productItems)];
    const updateScope = organizationId ? ' and p.organization_id = $2' : '';
    if (organizationId) updateParams.push(organizationId);
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
     where p.id = requested.product_id${updateScope}`,
      updateParams
    );
  }

  if (variantItems.length) {
    const updateParams = [stockPayload(variantItems)];
    const updateScope = organizationId ? ' and pv.organization_id = $2' : '';
    if (organizationId) updateParams.push(organizationId);
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
       where pv.id = requested.variant_id${updateScope}`,
      updateParams
    );
    await syncProductStock(client, variantItems.map((item) => item.product_id), { organizationId });
  }
}

async function assertStockAvailable(client, items, { organizationId = null } = {}) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  const productItems = grouped.filter((item) => !item.variant_id);
  const variantItems = grouped.filter((item) => item.variant_id);
  const ids = productItems.map((item) => item.product_id);
  const variantIds = variantItems.map((item) => item.variant_id);

  const productParams = [ids];
  const productScope = organizationId ? ' and organization_id = $2' : '';
  if (organizationId) productParams.push(organizationId);
  const result = ids.length ? await client.query(
    `select id, name, stock from products where id = any($1::bigint[])${productScope} for update`,
    productParams
  ) : { rows: [] };
  const products = new Map(result.rows.map((product) => [String(product.id), product]));

  const variantParams = [variantIds];
  const variantScope = organizationId ? ' and pv.organization_id = $2' : '';
  if (organizationId) variantParams.push(organizationId);
  const variantResult = variantIds.length ? await client.query(
    `select pv.id, pv.product_id, pv.color, pv.size, pv.stock, p.name
     from product_variants pv
     join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
     where pv.id = any($1::bigint[])${variantScope} for update`,
    variantParams
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
}

async function restoreStock(client, items, { organizationId = null } = {}) {
  const grouped = groupOrderItems(items);
  if (!grouped.length) return;

  const productItems = grouped.filter((item) => !item.variant_id);
  const variantItems = grouped.filter((item) => item.variant_id);

  if (productItems.length) {
    const updateParams = [stockPayload(productItems)];
    const updateScope = organizationId ? ' and p.organization_id = $2' : '';
    if (organizationId) updateParams.push(organizationId);
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
     where p.id = requested.product_id${updateScope}`,
      updateParams
    );
  }

  if (variantItems.length) {
    const updateParams = [stockPayload(variantItems)];
    const updateScope = organizationId ? ' and pv.organization_id = $2' : '';
    if (organizationId) updateParams.push(organizationId);
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
       where pv.id = requested.variant_id${updateScope}`,
      updateParams
    );
    await syncProductStock(client, variantItems.map((item) => item.product_id), { organizationId });
  }
}

async function orderItems(client, orderId, { organizationId = null } = {}) {
  const params = [orderId];
  let scopeJoin = '';
  let scopeWhere = '';
  if (organizationId) {
    params.push(organizationId);
    scopeJoin = ' join orders o on o.id = oi.order_id';
    scopeWhere = ` and o.organization_id = $${params.length}`;
  }

  const result = await client.query(
    `select oi.product_id, oi.variant_id, oi.quantity
     from order_items oi${scopeJoin}
     where oi.order_id = $1 and oi.product_id is not null${scopeWhere}`,
    params
  );
  return result.rows;
}

async function syncStockForStatusChange(client, orderId, previousStatus, nextStatus, { organizationId = null } = {}) {
  if (previousStatus === nextStatus) return;

  const items = await orderItems(client, orderId, { organizationId });
  if (nextStatus === 'cancelled' && previousStatus !== 'cancelled') {
    await restoreStock(client, items, { organizationId });
  }

  if (previousStatus === 'cancelled' && nextStatus !== 'cancelled') {
    await assertStockAvailable(client, items, { organizationId });
    await reserveStock(client, items, { organizationId });
  }
}

module.exports = {
  assertStockAvailable,
  reserveStock,
  restoreStock,
  syncProductStock,
  syncStockForStatusChange,
};
