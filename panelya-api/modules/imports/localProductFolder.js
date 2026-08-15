const { createProduct } = require('../catalog/productWriter');

const DEFAULT_VARIANT_STOCK = 5;
const PLACEHOLDER_PRICE = 1;

function cleanText(value) {
  return String(value || '').trim();
}

function uniqueValues(values, field) {
  const entries = [...new Set((Array.isArray(values) ? values : [])
    .map(cleanText)
    .filter(Boolean))];
  if (!entries.length) {
    throw Object.assign(new Error(`${field} zorunlu`), { code: 'LOCAL_FOLDER_FIELD_REQUIRED' });
  }
  return entries;
}

function captionPrice(input) {
  const price = Number(input.price);
  if (input.priceSource === 'caption' && Number.isFinite(price) && price > 0) {
    return { price, priceSource: 'caption', priceNeedsReview: false };
  }
  return { price: PLACEHOLDER_PRICE, priceSource: 'placeholder', priceNeedsReview: true };
}

function buildLocalProductFolderPlan(input = {}) {
  const name = cleanText(input.name);
  if (!name) throw Object.assign(new Error('name zorunlu'), { code: 'LOCAL_FOLDER_FIELD_REQUIRED' });
  const colors = uniqueValues(input.colors, 'colors');
  const sizes = uniqueValues(input.sizes, 'sizes');
  const price = captionPrice(input);
  const variants = colors.flatMap((color) => sizes.map((size) => ({
    color,
    size,
    stock: DEFAULT_VARIANT_STOCK,
    status: 'active',
  })));
  const totalStock = variants.length * DEFAULT_VARIANT_STOCK;
  const warnings = [
    ...(price.priceNeedsReview ? ['PLACEHOLDER_PRICE_REVIEW_REQUIRED'] : []),
    ...((Array.isArray(input.warnings) ? input.warnings : []).map(cleanText).filter(Boolean)),
  ];
  const details = {
    short_description: cleanText(input.shortDescription),
    story: '',
    measurements: cleanText(input.measurements),
    fabric_info: cleanText(input.fabricInfo),
    delivery_note: cleanText(input.deliveryNote),
    source: 'local_folder_import',
    price_source: price.priceSource,
    price_needs_review: price.priceNeedsReview,
    import_warnings: [...new Set(warnings)],
  };
  const productWriterInput = {
    name,
    category_id: input.categoryId == null ? null : Number(input.categoryId),
    price: price.price,
    sale_price: null,
    stock: totalStock,
    status: 'draft',
    colors,
    sizes,
    variants,
    images: Array.isArray(input.images) ? input.images.map(cleanText).filter(Boolean) : [],
    details,
    tags: cleanText(input.tags),
    description: cleanText(input.description),
    product_story: cleanText(input.productStory),
    emoji: cleanText(input.emoji),
    featured_in_category: false,
    auto_generate_sku: true,
  };
  const receipt = {
    productStatus: 'draft',
    price: price.price,
    priceSource: price.priceSource,
    priceNeedsReview: price.priceNeedsReview,
    colors,
    sizes,
    variantCount: variants.length,
    stockPerVariant: DEFAULT_VARIANT_STOCK,
    totalStock,
    warnings: details.import_warnings,
    autoCreatedColors: Array.isArray(input.autoCreatedColors) ? input.autoCreatedColors : [],
  };
  return { productWriterInput, receipt };
}

async function executeLocalProductFolderImport(client, {
  organization,
  input,
  actorId = null,
  actorType = 'import',
} = {}) {
  if (!organization || !organization.id) {
    throw Object.assign(new Error('organization zorunlu'), { code: 'LOCAL_FOLDER_FIELD_REQUIRED' });
  }
  const plan = buildLocalProductFolderPlan(input);
  const product = await createProduct(client, {
    organization,
    input: plan.productWriterInput,
    actorId,
    actorType,
    inventoryReason: 'Local folder product import',
  });
  return {
    product,
    receipt: { ...plan.receipt, productId: Number(product.id) },
  };
}

module.exports = {
  DEFAULT_VARIANT_STOCK,
  PLACEHOLDER_PRICE,
  buildLocalProductFolderPlan,
  executeLocalProductFolderImport,
};
