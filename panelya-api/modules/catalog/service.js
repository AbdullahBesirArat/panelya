const { syncProductVariants } = require('../../services/productVariants');
const { syncMediaReferences } = require('../../services/mediaAssets');

async function synchronizeProductRelations(client, {
  organizationId,
  productId,
  variants,
  defaultStock = 0,
  productStatus = 'active',
  autoGenerateSku = false,
  tenantPrefix = '',
  productName = '',
  actorId = null,
  images,
  altText,
}) {
  const canonicalVariants = (variants || []).length ? variants : [{
    color: '',
    size: '',
    sku: null,
    stock: defaultStock,
    status: Number(defaultStock) > 0 && productStatus !== 'out' ? 'active' : 'out',
    is_default: true,
  }];
  await syncProductVariants(client, organizationId, productId, canonicalVariants, {
    autoGenerateSku,
    tenantPrefix,
    productName,
    actorId,
  });
  await syncMediaReferences(client, {
    organizationId,
    resourceType: 'product',
    resourceId: productId,
    fieldName: 'images',
    values: images,
    altText,
  });
}

module.exports = { synchronizeProductRelations };
