const MOVEMENT_TYPES = new Set([
  'initial', 'purchase', 'inbound', 'sale', 'return', 'adjustment',
  'reservation', 'reservation_release', 'cancellation', 'transfer',
]);

function groupOrderItems(items) {
  const grouped = new Map();
  for (const item of items || []) {
    const productId = Number(item.product_id || item.productId || item.id || 0);
    const variantId = Number(item.variant_id || item.variantId || 0) || null;
    const quantity = Number(item.quantity || item.qty || 1);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity <= 0) continue;
    const key = variantId ? `variant:${variantId}` : `product:${productId}`;
    const current = grouped.get(key) || {
      product_id: productId,
      variant_id: variantId,
      quantity: 0,
      unit_price: Number.isFinite(Number(item.unit_price)) ? Number(item.unit_price) : null,
    };
    current.quantity += quantity;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function stockError(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function normalizeSku(value) {
  const sku = String(value == null ? '' : value).trim();
  return sku ? sku.slice(0, 120) : null;
}

function skuPart(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLocaleUpperCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/İ/g, 'I')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (normalized || fallback || '').slice(0, 24);
}

async function generateSku(client, {
  organizationId,
  tenantPrefix,
  productName,
  productId,
  color,
  size,
  excludeVariantId = null,
}) {
  const base = [
    skuPart(tenantPrefix, 'ORG').slice(0, 8),
    skuPart(productName, `P${productId}`).slice(0, 18),
    skuPart(color, ''),
    skuPart(size, ''),
  ].filter(Boolean).join('-').slice(0, 100);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${organizationId}:${base}`]);
  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const candidate = `${base}${suffix === 1 ? '' : `-${suffix}`}`.slice(0, 120);
    const existing = await client.query(
      `select 1 from product_variants
        where organization_id = $1
          and normalized_sku = lower($2)
          and ($3::bigint is null or id <> $3)
        limit 1`,
      [organizationId, candidate, excludeVariantId]
    );
    if (!existing.rows[0]) return candidate;
  }
  throw Object.assign(new Error('Benzersiz SKU uretilemedi'), { status: 409 });
}

function movementKey(base, variantId) {
  const value = String(base || '').trim();
  return value ? `${value}:variant:${variantId}`.slice(0, 240) : null;
}

async function syncProductStock(client, productIds, { organizationId = null } = {}) {
  const ids = [...new Set((productIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const params = [ids];
  const productScope = organizationId ? `and p.organization_id = $${params.push(organizationId)}` : '';
  const variantScope = organizationId ? `and v.organization_id = $${params.length}` : '';
  const result = await client.query(
    `with requested as (
       select unnest($1::bigint[]) as product_id
     ), totals as (
       select requested.product_id,
              coalesce(sum(v.available) filter (where v.is_active), 0)::integer as available
       from requested
       left join product_variants v
         on v.product_id = requested.product_id ${variantScope}
       group by requested.product_id
     )
     update products p
        set stock = totals.available,
            status = case
              when totals.available <= 0 then 'out'
              when p.status = 'out' and totals.available > 0 then 'active'
              else p.status
            end,
            updated_at = now()
       from totals
      where p.id = totals.product_id ${productScope}
      returning p.id, p.name, p.stock, p.status`,
    params
  );
  return result.rows;
}

async function lockVariant(client, organizationId, variantId) {
  if (!organizationId) throw Object.assign(new Error('organizationId zorunlu'), { status: 500 });
  const result = await client.query(
    `select pv.id, pv.organization_id, pv.product_id, pv.color, pv.size, pv.sku,
            pv.is_active, pv.is_default, pv.status, pv.on_hand, pv.reserved,
            pv.available, p.name
       from product_variants pv
       join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
      where pv.organization_id = $1 and pv.id = $2
      for update of pv`,
    [organizationId, variantId]
  );
  const variant = result.rows[0];
  if (!variant) throw stockError(`Varyant bulunamadi: ${variantId}`);
  return variant;
}

async function applyInventoryMovement(client, {
  organizationId,
  variantId,
  movementType,
  onHandDelta = 0,
  reservedDelta = 0,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null,
  reason = null,
  actorType = null,
  actorId = null,
  syncProduct = true,
}) {
  if (!MOVEMENT_TYPES.has(movementType)) {
    throw Object.assign(new Error('Gecersiz stok hareketi'), { status: 400 });
  }
  if (!Number.isInteger(onHandDelta) || !Number.isInteger(reservedDelta)) {
    throw Object.assign(new Error('Stok hareket miktari tam sayi olmali'), { status: 400 });
  }

  const variant = await lockVariant(client, organizationId, variantId);
  const safeIdempotencyKey = String(idempotencyKey || '').trim() || null;
  if (safeIdempotencyKey) {
    const existing = await client.query(
      `select * from inventory_movements
        where organization_id = $1 and idempotency_key = $2
        limit 1`,
      [organizationId, safeIdempotencyKey]
    );
    if (existing.rows[0]) {
      const current = Number(variant.available);
      return {
        applied: false, movement: existing.rows[0], variant,
        productId: Number(variant.product_id), availableBefore: current, availableAfter: current,
      };
    }
  }

  const onHandAfter = Number(variant.on_hand) + onHandDelta;
  const reservedAfter = Number(variant.reserved) + reservedDelta;
  const availableBefore = Number(variant.available);
  const availableAfter = onHandAfter - reservedAfter;
  if (onHandAfter < 0 || reservedAfter < 0 || availableAfter < 0) {
    const option = [variant.color, variant.size].filter(Boolean).join(' / ');
    throw stockError(`${variant.name}${option ? ` (${option})` : ''} icin yeterli stok yok. Kullanilabilir stok: ${availableBefore}`);
  }

  const updated = await client.query(
    `update product_variants
        set on_hand = $1,
            reserved = $2,
            stock = $3,
            inventory_version = inventory_version + 1,
            status = case
              when $3 <= 0 then 'out'
              when status = 'out' and $3 > 0 then 'active'
              else status
            end,
            updated_at = now()
      where organization_id = $4 and id = $5
      returning *`,
    [onHandAfter, reservedAfter, availableAfter, organizationId, variantId]
  );
  const quantityDelta = availableAfter - availableBefore;
  const movement = await client.query(
    `insert into inventory_movements
       (organization_id, variant_id, movement_type, quantity_delta,
        on_hand_delta, reserved_delta, balance_after, on_hand_after,
        reserved_after, reference_type, reference_id, idempotency_key,
        reason, actor_type, actor_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [
      organizationId, variantId, movementType, quantityDelta,
      onHandDelta, reservedDelta, availableAfter, onHandAfter, reservedAfter,
      referenceType, referenceId == null ? null : String(referenceId),
      safeIdempotencyKey, reason, actorType, actorId == null ? null : String(actorId),
    ]
  );
  if (syncProduct) await syncProductStock(client, [variant.product_id], { organizationId });
  return {
    applied: true, movement: movement.rows[0], variant: updated.rows[0],
    productId: Number(variant.product_id), availableBefore, availableAfter,
  };
}

async function resolveInventoryItems(client, items, { organizationId, lock = false, activeOnly = true } = {}) {
  if (!organizationId) throw Object.assign(new Error('organizationId zorunlu'), { status: 500 });
  const grouped = groupOrderItems(items);
  if (!grouped.length) return [];
  const explicitIds = [...new Set(grouped.map((item) => item.variant_id).filter(Boolean))];
  const defaultProductIds = [...new Set(grouped.filter((item) => !item.variant_id).map((item) => item.product_id))];
  const activeFilter = activeOnly ? ' and pv.is_active' : '';
  const lockClause = lock ? ' for update of pv' : '';
  const explicit = explicitIds.length ? await client.query(
    `select pv.id, pv.product_id, pv.color, pv.size, pv.sku, pv.status,
            pv.is_active, pv.is_default, pv.available, p.name
       from product_variants pv
       join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
      where pv.organization_id = $1 and pv.id = any($2::bigint[])${activeFilter}
      order by pv.id${lockClause}`,
    [organizationId, explicitIds]
  ) : { rows: [] };
  const defaults = defaultProductIds.length ? await client.query(
    `select pv.id, pv.product_id, pv.color, pv.size, pv.sku, pv.status,
            pv.is_active, pv.is_default, pv.available, p.name
       from product_variants pv
       join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
      where pv.organization_id = $1
        and pv.product_id = any($2::bigint[])
        and pv.is_default${activeFilter}
      order by pv.id${lockClause}`,
    [organizationId, defaultProductIds]
  ) : { rows: [] };
  const explicitById = new Map(explicit.rows.map((row) => [Number(row.id), row]));
  const defaultByProduct = new Map(defaults.rows.map((row) => [Number(row.product_id), row]));
  const canonical = new Map();
  for (const item of grouped) {
    const variant = item.variant_id
      ? explicitById.get(Number(item.variant_id))
      : defaultByProduct.get(Number(item.product_id));
    if (!variant || Number(variant.product_id) !== Number(item.product_id)) {
      throw stockError(item.variant_id
        ? `Varyant bulunamadi: ${item.variant_id}`
        : `Urunun varsayilan stok birimi bulunamadi: ${item.product_id}`);
    }
    const key = Number(variant.id);
    const current = canonical.get(key) || { ...item, variant_id: key, variant, quantity: 0 };
    current.quantity += item.quantity;
    canonical.set(key, current);
  }
  return [...canonical.values()].sort((a, b) => a.variant_id - b.variant_id);
}

async function assertStockAvailable(client, items, { organizationId = null } = {}) {
  const canonical = await resolveInventoryItems(client, items, { organizationId, lock: true });
  for (const item of canonical) {
    if (Number(item.variant.available) < item.quantity) {
      const option = [item.variant.color, item.variant.size].filter(Boolean).join(' / ');
      throw stockError(`${item.variant.name}${option ? ` (${option})` : ''} icin yeterli stok yok. Kullanilabilir stok: ${item.variant.available}`);
    }
  }
  return canonical;
}

async function reserveStock(client, items, options = {}) {
  const { organizationId, referenceType = null, referenceId = null, idempotencyKey = null } = options;
  const canonical = await resolveInventoryItems(client, items, { organizationId, lock: true });
  const productIds = [];
  const results = [];
  for (const item of canonical) {
    results.push(await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'sale',
      onHandDelta: -item.quantity,
      referenceType,
      referenceId,
      idempotencyKey: movementKey(idempotencyKey, item.variant_id),
      reason: 'Stock consumed by order flow',
      syncProduct: false,
    }));
    productIds.push(item.product_id);
  }
  await syncProductStock(client, productIds, { organizationId });
  return results;
}

async function restoreStock(client, items, options = {}) {
  const { organizationId, referenceType = null, referenceId = null, idempotencyKey = null } = options;
  const canonical = await resolveInventoryItems(client, items, { organizationId, lock: true, activeOnly: false });
  const productIds = [];
  const results = [];
  for (const item of canonical) {
    results.push(await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'cancellation',
      onHandDelta: item.quantity,
      referenceType,
      referenceId,
      idempotencyKey: movementKey(idempotencyKey, item.variant_id),
      reason: 'Stock restored by order flow',
      syncProduct: false,
    }));
    productIds.push(item.product_id);
  }
  await syncProductStock(client, productIds, { organizationId });
  return results;
}

async function setInventoryBalance(client, {
  organizationId,
  productId,
  variantId,
  stock,
  reason = 'Administrative stock adjustment',
  actorType = 'admin',
  actorId = null,
  idempotencyKey = null,
  syncProduct = true,
}) {
  const target = Number(stock);
  if (!Number.isInteger(target) || target < 0) {
    throw Object.assign(new Error('Gecersiz stok miktari'), { status: 400 });
  }
  const canonical = await resolveInventoryItems(client, [{ product_id: productId, variant_id: variantId, quantity: 1 }], {
    organizationId,
    lock: true,
    activeOnly: false,
  });
  const item = canonical[0];
  const currentAvailable = Number(item.variant.available);
  const delta = target - currentAvailable;
  if (delta === 0) {
    return {
      applied: false, variant: item.variant, movement: null,
      productId: Number(item.variant.product_id), availableBefore: currentAvailable, availableAfter: currentAvailable,
    };
  }
  return applyInventoryMovement(client, {
    organizationId,
    variantId: item.variant_id,
    movementType: 'adjustment',
    onHandDelta: delta,
    idempotencyKey: movementKey(idempotencyKey, item.variant_id),
    reason,
    actorType,
    actorId,
    syncProduct,
  });
}

async function setInventoryBalances(client, updates, options = {}) {
  const results = [];
  const productIds = [];
  for (const update of [...(updates || [])].sort((a, b) => Number(a.variant_id || 0) - Number(b.variant_id || 0))) {
    results.push(await setInventoryBalance(client, {
      ...options,
      productId: update.product_id,
      variantId: update.variant_id,
      stock: update.stock,
      syncProduct: false,
    }));
    productIds.push(update.product_id);
  }
  const products = await syncProductStock(client, productIds, { organizationId: options.organizationId });
  return { results, products };
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
    await restoreStock(client, items, { organizationId, referenceType: 'order', referenceId: orderId });
  }
  if (previousStatus === 'cancelled' && nextStatus !== 'cancelled') {
    await reserveStock(client, items, { organizationId, referenceType: 'order', referenceId: orderId });
  }
}

module.exports = {
  MOVEMENT_TYPES,
  applyInventoryMovement,
  assertStockAvailable,
  groupOrderItems,
  generateSku,
  normalizeSku,
  reserveStock,
  resolveInventoryItems,
  restoreStock,
  setInventoryBalance,
  setInventoryBalances,
  syncProductStock,
  syncStockForStatusChange,
};
