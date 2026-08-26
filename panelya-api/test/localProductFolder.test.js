const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_VARIANT_STOCK,
  PLACEHOLDER_PRICE,
  buildLocalProductFolderPlan,
} = require('../modules/imports/localProductFolder');

function baseInput(overrides = {}) {
  return {
    name: 'Kol Detaylı Boy Tunik',
    categoryId: 14,
    price: null,
    priceSource: 'placeholder',
    colors: ['Lacivert #243f8f', 'Gül Kurusu #9a626a'],
    sizes: ['S/M', 'L/XL'],
    images: ['/api/media/navy/detail', '/api/media/rose/detail'],
    shortDescription: 'Kısa ürün özeti.',
    description: 'Ana ürün açıklaması.',
    productStory: 'Yalnız editorial ürün hikayesi.',
    ...overrides,
  };
}

test('local-folder imports assign exactly five units to every color-size variant', () => {
  const plan = buildLocalProductFolderPlan(baseInput());

  assert.equal(DEFAULT_VARIANT_STOCK, 5);
  assert.equal(plan.productWriterInput.variants.length, 4);
  assert.ok(plan.productWriterInput.variants.every((variant) => variant.stock === 5));
  assert.equal(plan.productWriterInput.stock, 20);
  assert.equal(plan.receipt.variantCount, 4);
  assert.equal(plan.receipt.stockPerVariant, 5);
  assert.equal(plan.receipt.totalStock, 20);
});

test('local-folder imports preserve explicit per-color size combinations', () => {
  const plan = buildLocalProductFolderPlan(baseInput({
    colors: ['Siyah', 'Vizon'],
    sizes: ['S', 'M', 'L'],
    variants: [
      { color: 'Siyah', size: 'M', stock: 99 },
      { color: 'Siyah', size: 'L', stock: 99 },
      { color: 'Vizon', size: 'S', stock: 99 },
      { color: 'Vizon', size: 'M', stock: 99 },
    ],
    sourceFolder: '046-puane-32468-takim',
    sourceCaptionChecksum: 'abc123',
  }));

  assert.deepEqual(plan.productWriterInput.variants.map(({ color, size, stock }) => ({ color, size, stock })), [
    { color: 'Siyah', size: 'M', stock: 5 },
    { color: 'Siyah', size: 'L', stock: 5 },
    { color: 'Vizon', size: 'S', stock: 5 },
    { color: 'Vizon', size: 'M', stock: 5 },
  ]);
  assert.equal(plan.productWriterInput.stock, 20);
  assert.equal(plan.productWriterInput.details.source_folder, '046-puane-32468-takim');
  assert.equal(plan.productWriterInput.details.source_caption_checksum, 'abc123');
});

test('local-folder content fields never copy product story into unknown facts', () => {
  const plan = buildLocalProductFolderPlan(baseInput({
    measurements: undefined,
    fabricInfo: undefined,
    deliveryNote: undefined,
  }));

  assert.equal(plan.productWriterInput.product_story, 'Yalnız editorial ürün hikayesi.');
  assert.notEqual(plan.productWriterInput.product_story, plan.productWriterInput.details.measurements);
  assert.equal(plan.productWriterInput.details.measurements, '');
  assert.equal(plan.productWriterInput.details.fabric_info, '');
  assert.equal(plan.productWriterInput.details.delivery_note, '');
  assert.equal(plan.productWriterInput.details.story, '');
});

test('unknown price uses the one-lira placeholder and remains draft', () => {
  const plan = buildLocalProductFolderPlan(baseInput());

  assert.equal(PLACEHOLDER_PRICE, 1);
  assert.equal(plan.productWriterInput.price, 1);
  assert.equal(plan.productWriterInput.status, 'draft');
  assert.equal(plan.receipt.priceSource, 'placeholder');
  assert.equal(plan.receipt.priceNeedsReview, true);
  assert.ok(plan.receipt.warnings.includes('PLACEHOLDER_PRICE_REVIEW_REQUIRED'));
});

test('caption price is preserved without weakening draft-only import safety', () => {
  const plan = buildLocalProductFolderPlan(baseInput({ price: 1299, priceSource: 'caption' }));

  assert.equal(plan.productWriterInput.price, 1299);
  assert.equal(plan.productWriterInput.status, 'draft');
  assert.equal(plan.receipt.priceSource, 'caption');
  assert.equal(plan.receipt.priceNeedsReview, false);
});

test('local-folder execution delegates product and inventory creation to productWriter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/imports/localProductFolder.js'), 'utf8');

  assert.match(source, /createProduct\(client/);
  assert.doesNotMatch(source, /update\s+product_variants/i);
  assert.doesNotMatch(source, /insert\s+into\s+inventory/i);
  assert.doesNotMatch(source, /insert\s+into\s+products/i);
});
