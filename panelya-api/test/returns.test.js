const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calculateRefundQuote } = require('../modules/returns/refundCalculator');
const { createRefundProvider } = require('../modules/returns/refundProviders');
const {
  normalizeDecision,
  normalizeReceipt,
  normalizeReturnRequest,
} = require('../modules/returns/validation');
const { assertRequestEligibility, returnWindowDays } = require('../modules/returns/service');

test('cancellation is accepted only before shipment', () => {
  assert.doesNotThrow(() => assertRequestEligibility({
    order: { fulfillment_status: 'ready_to_ship' }, requestType: 'cancellation',
  }));
  assert.throws(() => assertRequestEligibility({
    order: { fulfillment_status: 'shipped' }, requestType: 'cancellation',
  }), (error) => error.code === 'CANCELLATION_TOO_LATE');
});

test('return window is calculated from delivery and bounded by settings', () => {
  const deliveredAt = '2026-01-01T00:00:00.000Z';
  const deadline = assertRequestEligibility({
    order: { fulfillment_status: 'delivered' }, requestType: 'return', deliveredAt, days: 14,
    now: new Date('2026-01-14T23:59:59.000Z'),
  });
  assert.equal(deadline.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.throws(() => assertRequestEligibility({
    order: { fulfillment_status: 'delivered' }, requestType: 'exchange', deliveredAt, days: 14,
    now: new Date('2026-01-15T00:00:00.001Z'),
  }), (error) => error.code === 'RETURN_WINDOW_EXPIRED');
  assert.equal(returnWindowDays({ shoppingNotes: { returns: { days: 999 } } }), 365);
});

test('customer request rejects duplicate lines and invalid quantity', () => {
  assert.throws(() => normalizeReturnRequest({
    order_id: 1, type: 'return', reason_code: 'wrong_size',
    items: [
      { order_item_id: 2, quantity: 1 },
      { order_item_id: 2, quantity: 1 },
    ],
  }), /iki kez/);
  assert.throws(() => normalizeReturnRequest({
    order_id: 1, type: 'return', reason_code: 'wrong_size',
    items: [{ order_item_id: 2, quantity: 0 }],
  }), /pozitif/);
});

test('approve/reject and receipt inputs require explicit safe values', () => {
  assert.deepEqual(normalizeDecision({ status: 'approved' }).status, 'approved');
  assert.throws(() => normalizeDecision({ status: 'rejected' }), /zorunlu/);
  assert.throws(() => normalizeReceipt({ items: [{ return_item_id: 1, received_quantity: 1, restock_quantity: 2, condition: 'unused' }] }), /asamaz/);
});

test('partial refund prorates discount and tax in cents', () => {
  const quote = calculateRefundQuote({
    order: {
      total: 210, shipping_fee: 0, tax_total: 20, currency: 'TRY',
      promotion_snapshot: { allocations: [{ product_id: 7, variant_id: 70, discount: 10 }] },
    },
    orderItems: [{ id: 5, product_id: 7, variant_id: 70, unit_price: 100, quantity: 2 }],
    requestedItems: [{ orderItemId: 5, quantity: 1 }],
  });
  assert.equal(quote.itemGross, 100);
  assert.equal(quote.discount, 5);
  assert.equal(quote.tax, 10);
  assert.equal(quote.amount, 105);
  assert.deepEqual(quote.allocations.map((item) => item.type), ['item', 'discount', 'tax']);
});

test('full refund includes shipping once and never exceeds paid total', () => {
  const quote = calculateRefundQuote({
    order: { total: 115, shipping_fee: 15, tax_total: 0, promotion_snapshot: {} },
    orderItems: [{ id: 1, product_id: 1, variant_id: 1, unit_price: 100, quantity: 1 }],
    requestedItems: [{ orderItemId: 1, quantity: 1 }], refundShipping: true,
  });
  assert.equal(quote.amount, 115);
  assert.throws(() => calculateRefundQuote({
    order: { total: 115, shipping_fee: 15, tax_total: 0, promotion_snapshot: {} },
    orderItems: [{ id: 1, product_id: 1, variant_id: 1, unit_price: 100, quantity: 1 }],
    requestedItems: [{ orderItemId: 1, quantity: 1 }], refundShipping: true,
    previousRefundTotal: 1,
  }), (error) => error.code === 'REFUND_AMOUNT_EXCEEDED');
});

test('manual provider exposes the complete adapter and idempotent reference', async () => {
  const provider = createRefundProvider('manual');
  const first = await provider.createRefund({ idempotencyKey: 'refund:stable:123' });
  const retry = await provider.createRefund({ idempotencyKey: 'refund:stable:123' });
  assert.equal(first.status, 'succeeded');
  assert.equal(first.providerRef, retry.providerRef);
  assert.equal((await provider.getRefundStatus({ providerRef: first.providerRef })).status, 'succeeded');
  assert.equal(provider.verifyWebhook({}), false);
  await assert.rejects(provider.handleWebhook({}), (error) => error.code === 'REFUND_WEBHOOK_UNSUPPORTED');
});

test('iyzico refund fails closed without an officially verified contract', () => {
  assert.throws(() => createRefundProvider('iyzico'), (error) => (
    error.status === 501 && error.code === 'IYZICO_REFUND_NOT_CONFIGURED'
  ));
});

test('045 migration defines tenant RLS, refund idempotency and append-only audit', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '045_returns_refunds.sql'), 'utf8');
  assert.match(migration, /create table if not exists return_requests/);
  assert.match(migration, /create table if not exists refunds/);
  assert.match(migration, /unique \(organization_id, idempotency_key\)/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /return_events are append-only/);
  assert.match(migration, /refunded_total numeric\(12,2\)/);
});
