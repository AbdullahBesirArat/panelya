const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  decryptIdentity, encryptIdentity, maskedIdentity, normalizeIdentity, sanitizeInvoiceForLog,
} = require('../modules/invoicing/sensitive');
const { normalizeInvoiceProfile } = require('../modules/invoicing/validation');
const { calculateTaxSnapshot, cents } = require('../modules/invoicing/taxEngine');
const { manualExportProvider } = require('../modules/invoicing/providers');
const { invoicesCsv } = require('../modules/invoicing/service');
const { calculateRefundQuote } = require('../modules/returns/refundCalculator');

const ENV = { INVOICE_IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

test('individual/company invoice profiles remain distinct and company fields are required', () => {
  const individual = normalizeInvoiceProfile({}, { name: 'Ada Yilmaz', email: 'ada@example.test', address: 'Istanbul adresi 1' });
  assert.equal(individual.type, 'individual');
  assert.equal(individual.identityNumber, '');
  const company = normalizeInvoiceProfile({
    type: 'company', legal_name: 'Ornek A.S.', vkn: '1234567890', tax_office: 'Sisli',
    invoice_address: 'Istanbul kurumsal adresi', email: 'muhasebe@example.test',
  });
  assert.equal(company.identityKind, 'vkn');
  assert.throws(() => normalizeInvoiceProfile({ type: 'company' }, { email: 'a@b.co', address: 'Adres yeterince uzun' }), /Unvan/);
});

test('identity data is format-validated, encrypted, masked and redacted from logs', () => {
  assert.equal(normalizeIdentity('123 456 789 01', 'tckn'), '12345678901');
  assert.throws(() => normalizeIdentity('01234567890', 'tckn'), /formati/);
  const protectedValue = encryptIdentity('1234567890', 'vkn', ENV);
  assert.notEqual(protectedValue.ciphertext.includes('1234567890'), true);
  assert.equal(decryptIdentity(protectedValue.ciphertext, 'vkn', ENV), '1234567890');
  assert.equal(maskedIdentity('vkn', protectedValue.last4), 'VKN ******7890');
  const logged = sanitizeInvoiceForLog({ identity_number: '1234567890', nested: { identity_ciphertext: protectedValue.ciphertext }, legalName: 'Ornek' });
  assert.deepEqual(logged, { identity_number: '[REDACTED]', nested: { identity_ciphertext: '[REDACTED]' }, legalName: 'Ornek' });
});

test('tax-inclusive rounding preserves net + tax = gross with discount and shipping tax', () => {
  const tax = calculateTaxSnapshot({
    policy: 'inclusive', defaultRate: 0.20, shippingRate: 0.20, shippingFee: 30,
    items: [{ product_id: 1, variant_id: 10, unit_price: 100, quantity: 2 }],
    allocations: [{ product_id: 1, variant_id: 10, discount: 10 }], rates: [],
  });
  assert.equal(cents(tax.totals.net) + cents(tax.totals.tax), cents(tax.totals.gross));
  assert.equal(tax.totals.gross, 220);
  assert.equal(tax.items[0].discount_allocation, 10);
  assert.equal(tax.shipping.gross, 30);
});

test('tax-exclusive policy adds item and shipping tax to gross exactly once', () => {
  const tax = calculateTaxSnapshot({
    policy: 'exclusive', defaultRate: 0.20, shippingRate: 0.10, shippingFee: 30,
    items: [{ product_id: 1, variant_id: 10, unit_price: 100, quantity: 1 }],
    allocations: [{ product_id: 1, variant_id: 10, discount: 10 }], rates: [],
  });
  assert.deepEqual(tax.totals, { net: 120, tax: 21, gross: 141, currency: 'TRY' });
  assert.equal(cents(tax.totals.net) + cents(tax.totals.tax), cents(tax.totals.gross));
});

test('partial refund uses immutable line tax and does not double-add inclusive tax', () => {
  const inclusive = calculateRefundQuote({
    order: { total: 200, shipping_fee: 0, tax_total: 33.34, tax_snapshot: { policy: 'inclusive', shipping: { tax: 0 } }, promotion_snapshot: {} },
    orderItems: [{ id: 1, product_id: 1, variant_id: 1, unit_price: 100, quantity: 2, tax_amount: 33.34 }],
    requestedItems: [{ orderItemId: 1, quantity: 1 }],
  });
  assert.equal(inclusive.tax, 16.67);
  assert.equal(inclusive.amount, 100);
  const exclusive = calculateRefundQuote({
    order: { total: 240, shipping_fee: 0, tax_total: 40, tax_snapshot: { policy: 'exclusive', shipping: { tax: 0 } }, promotion_snapshot: {} },
    orderItems: [{ id: 1, product_id: 1, variant_id: 1, unit_price: 100, quantity: 2, tax_amount: 40 }],
    requestedItems: [{ orderItemId: 1, quantity: 1 }],
  });
  assert.equal(exclusive.tax, 20);
  assert.equal(exclusive.amount, 120);
});

test('manual/export provider exposes complete fail-closed adapter boundary', async () => {
  const provider = manualExportProvider('manual');
  for (const method of ['createInvoice', 'cancelInvoice', 'getDocument', 'getStatus', 'verifyWebhook']) {
    assert.equal(typeof provider[method], 'function');
  }
  assert.equal((await provider.createInvoice({ invoice: { id: 'invoice-1' } })).status, 'draft');
  assert.equal(provider.verifyWebhook({}), false);
});

test('CSV export neutralizes spreadsheet formulas', () => {
  const csv = invoicesCsv([{
    invoice_number: '=CMD()', order_code: 'ORDER-1', invoice_type: 'sale', status: 'issued',
    issued_at: '2026-01-01', net_total: 100, tax_total: 20, gross_total: 120, currency: 'TRY',
  }]);
  assert.match(csv, /"'=CMD\(\)"/);
});

test('047 migration protects immutable snapshots, encrypted identity storage, RLS and idempotency', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/047_invoicing_tax.sql'), 'utf8');
  assert.match(migration, /identity_ciphertext text/i);
  assert.doesNotMatch(migration, /\btckn\s+text|\bvkn\s+text/i);
  assert.match(migration, /trg_orders_invoice_snapshot_immutable/i);
  assert.match(migration, /trg_order_items_tax_snapshot_immutable/i);
  assert.match(migration, /invoices_org_idempotency_key unique/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /invoice_documents/i);
});
