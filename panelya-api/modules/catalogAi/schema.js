const CATALOG_ANALYSIS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'classification_confidence', 'facts', 'generated', 'image_bindings', 'warnings'],
  properties: {
    classification: { type: 'string', enum: ['product', 'non_product', 'uncertain'] },
    classification_confidence: { type: 'number', minimum: 0, maximum: 1 },
    facts: {
      type: 'object', additionalProperties: false,
      required: ['name', 'price', 'sale_price', 'category_id', 'colors', 'sizes', 'fabric', 'measurements'],
      properties: {
        name: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
        price: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
        sale_price: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
        category_id: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        colors: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
        sizes: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 80 } },
        fabric: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] },
        measurements: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 300 } },
      },
    },
    generated: {
      type: 'object', additionalProperties: false,
      required: ['short_description', 'description', 'product_story', 'tags'],
      properties: {
        short_description: { type: 'string', maxLength: 1000 },
        description: { type: 'string', maxLength: 5000 },
        product_story: { type: 'string', maxLength: 5000 },
        tags: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 80 } },
      },
    },
    image_bindings: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        required: ['position', 'color', 'confidence'],
        properties: {
          position: { type: 'integer', minimum: 0, maximum: 19 },
          color: { anyOf: [{ type: 'string', maxLength: 80 }, { type: 'null' }] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    warnings: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 300 } },
  },
});

function text(value, max) { return String(value || '').trim().slice(0, max); }
function list(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}
function confidence(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function normalizeCatalogAnalysis(raw, { categoryIds = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('AI katalog cevabi gecersiz'), { code: 'AI_OUTPUT_INVALID', status: 502 });
  const facts = raw.facts && typeof raw.facts === 'object' ? raw.facts : {};
  const generated = raw.generated && typeof raw.generated === 'object' ? raw.generated : {};
  const allowedCategories = new Set(categoryIds.map(Number).filter(Number.isInteger));
  const requestedCategory = Number(facts.category_id);
  const categoryId = allowedCategories.has(requestedCategory) ? requestedCategory : null;
  const price = money(facts.price);
  let salePrice = money(facts.sale_price);
  if (salePrice != null && (price == null || salePrice > price)) salePrice = null;
  const warnings = list(raw.warnings, 30, 300);
  if (price == null && !warnings.includes('Fiyat kaynaktan acikca dogrulanamadi.')) warnings.push('Fiyat kaynaktan acikca dogrulanamadi.');
  if (requestedCategory && !categoryId) warnings.push('Onerilen kategori mevcut workspace kategorileriyle eslesmedi.');
  const classification = ['product', 'non_product', 'uncertain'].includes(raw.classification) ? raw.classification : 'uncertain';
  const colors = list(facts.colors, 20, 80);
  const bindings = (Array.isArray(raw.image_bindings) ? raw.image_bindings : []).map((item) => {
    const position = Number(item?.position);
    const color = text(item?.color, 80);
    if (!Number.isInteger(position) || position < 0 || position > 19 || (color && !colors.includes(color))) return null;
    return { position, color: color || null, confidence: confidence(item?.confidence) };
  }).filter(Boolean).slice(0, 20);
  return {
    classification,
    classificationConfidence: confidence(raw.classification_confidence),
    facts: {
      name: text(facts.name, 200) || null,
      price,
      priceExplicit: price != null,
      salePrice,
      categoryId,
      colors,
      sizes: list(facts.sizes, 30, 80),
      fabric: text(facts.fabric, 2000) || null,
      measurements: list(facts.measurements, 30, 300),
    },
    generated: {
      shortDescription: text(generated.short_description, 1000),
      description: text(generated.description, 5000),
      productStory: text(generated.product_story, 5000),
      tags: list(generated.tags, 30, 80),
    },
    imageBindings: bindings,
    warnings: warnings.slice(0, 30),
  };
}

module.exports = { CATALOG_ANALYSIS_SCHEMA, normalizeCatalogAnalysis };
