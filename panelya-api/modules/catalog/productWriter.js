const { assertPlanCapacity } = require('../../services/planLimits');
const { productParams, normalizeVariants } = require('./validation');
const { assertCategoryScope, fetchProduct } = require('./repository');
const { synchronizeProductRelations } = require('./service');

/**
 * Canonical transactional product creator used by both the manual product route
 * and trusted server-side ingestion workflows. The caller owns BEGIN/COMMIT.
 */
async function createProduct(client, {
  organization,
  input,
  actorId = null,
  actorType = 'admin',
  inventoryReason = 'Product form inventory adjustment',
}) {
  const variants = normalizeVariants(input.variants);
  const params = productParams(input);
  const requestedStock = params[4];
  const canonicalParams = [...params.slice(0, 4), ...params.slice(5)];

  await assertPlanCapacity(client, organization.id, 'products');
  await assertCategoryScope(client, organization.id, params[1]);
  const result = await client.query(
    `insert into products
     (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, images, details, tags, description, product_story, emoji, featured_in_category)
     values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [organization.id, ...canonicalParams]
  );

  await synchronizeProductRelations(client, {
    organizationId: organization.id,
    productId: result.rows[0].id,
    variants,
    defaultStock: requestedStock,
    productStatus: params[5],
    autoGenerateSku: input.auto_generate_sku === true,
    tenantPrefix: organization.slug,
    productName: params[0],
    actorId,
    actorType,
    inventoryReason,
    images: JSON.parse(params[8]),
    altText: params[0],
  });

  return fetchProduct(client, result.rows[0].id, organization.id);
}

module.exports = { createProduct };
