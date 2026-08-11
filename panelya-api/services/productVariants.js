const { generateSku, normalizeSku, setInventoryBalance, syncProductStock } = require('./inventory');

function variantKey(color, size) {
  return `${String(color || '').trim().toLocaleLowerCase('tr-TR')}::${String(size || '').trim().toLocaleLowerCase('tr-TR')}`;
}

async function syncProductVariants(client, organizationId, productId, variants, options = {}) {
  const existingResult = await client.query(
    `select id, color, size, is_default
       from product_variants
      where organization_id = $1 and product_id = $2
      for update`,
    [organizationId, productId]
  );
  const existingByKey = new Map();
  for (const row of existingResult.rows) existingByKey.set(variantKey(row.color, row.size), row);

  const incomingKeys = new Set();
  for (const rawVariant of variants || []) {
    const variant = {
      ...rawVariant,
      color: String(rawVariant.color || '').trim(),
      size: String(rawVariant.size || '').trim(),
      sku: normalizeSku(rawVariant.sku),
      stock: Math.max(0, Math.floor(Number(rawVariant.stock) || 0)),
      is_default: Boolean(rawVariant.is_default),
    };
    const key = variantKey(variant.color, variant.size);
    incomingKeys.add(key);
    const existing = existingByKey.get(key);
    if (!variant.sku && options.autoGenerateSku) {
      variant.sku = await generateSku(client, {
        organizationId,
        tenantPrefix: options.tenantPrefix,
        productName: options.productName,
        productId,
        color: variant.color,
        size: variant.size,
        excludeVariantId: existing?.id || null,
      });
    }
    let variantId;

    if (existing) {
      await client.query(
        `update product_variants
            set sku = $1,
                status = $2,
                is_active = true,
                is_default = $3,
                updated_at = now()
          where id = $4 and organization_id = $5`,
        [variant.sku, variant.status, variant.is_default, existing.id, organizationId]
      );
      variantId = existing.id;
    } else {
      const inserted = await client.query(
        `insert into product_variants
           (organization_id, product_id, color, size, sku, stock, status,
            is_active, is_default, on_hand, reserved, incoming, low_stock_threshold)
         values ($1,$2,$3,$4,$5,0,'out',true,$6,0,0,0,0)
         returning id`,
        [organizationId, productId, variant.color, variant.size, variant.sku, variant.is_default]
      );
      variantId = inserted.rows[0].id;
    }

    await setInventoryBalance(client, {
      organizationId,
      productId,
      variantId,
      stock: variant.stock,
      reason: 'Product form inventory adjustment',
      actorType: options.actorType || 'admin',
      actorId: options.actorId || null,
      syncProduct: false,
    });
  }

  for (const [key, existing] of existingByKey) {
    if (incomingKeys.has(key)) continue;
    // A13 ledger history makes physical deletion unsafe even without an order.
    // Removed options become inactive and remain addressable for audits/returns.
    await client.query(
      `update product_variants
          set is_active = false, is_default = false, updated_at = now()
        where id = $1 and organization_id = $2`,
      [existing.id, organizationId]
    );
  }

  await syncProductStock(client, [productId], { organizationId });
}

module.exports = { variantKey, syncProductVariants };
