const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  allocateDiscount,
  normalizeCouponCode,
  promotionOrderColumns,
} = require('../services/promotionEngine');
const { couponPayload } = require('../services/coupons');

test('coupon codes normalize case-insensitively and reject brute-force-unfriendly input', () => {
  assert.equal(normalizeCouponCode('  yaz_20 '), 'YAZ_20');
  assert.equal(normalizeCouponCode(''), '');
  assert.throws(() => normalizeCouponCode('a b c'), (error) => error.code === 'COUPON_INVALID');
  assert.throws(() => normalizeCouponCode('x'), (error) => error.status === 400);
});

test('admin coupon validation bounds percentage, dates, limits and scopes', () => {
  const payload = couponPayload({
    code: 'SAVE20',
    name: 'Save twenty',
    discountType: 'percentage',
    value: 20,
    minimumSubtotal: 100,
    totalUsageLimit: 10,
    perCustomerLimit: 1,
    includeProductIds: [2, 2, -1, '3'],
    excludeProductIds: [4],
    stackingPolicy: 'with_campaign',
  });
  assert.deepEqual(payload.includeProductIds, [2, 3]);
  assert.deepEqual(payload.excludeProductIds, [4]);
  assert.equal(payload.stackingPolicy, 'with_campaign');
  assert.throws(() => couponPayload({ code: 'BAD100', name: 'Bad', discountType: 'percentage', value: 101 }), /degeri gecersiz/);
  assert.throws(() => couponPayload({
    code: 'DATES', name: 'Dates', discountType: 'fixed', value: 1,
    startsAt: '2026-08-03T00:00:00Z', endsAt: '2026-08-02T00:00:00Z',
  }), /Bitis tarihi/);
});

test('refund allocation is deterministic, cent-exact and never exceeds a line', () => {
  const items = [
    { product_id: 1, variant_id: 11, quantity: 1, unit_price: 33.33 },
    { product_id: 2, variant_id: 22, quantity: 2, unit_price: 33.34 },
  ];
  const allocations = allocateDiscount(items, 10.01, null, 'coupon');
  assert.equal(allocations.reduce((sum, row) => Math.round((sum + row.discount) * 100) / 100, 0), 10.01);
  assert.ok(allocations.every((row) => row.discount >= 0 && row.discount <= row.line_subtotal));
  assert.deepEqual(allocations.map((row) => row.product_id), [1, 2]);
});

test('order promotion snapshot separates product, shipping and source breakdown', () => {
  const columns = promotionOrderColumns({
    subtotal: 200,
    discount: 35,
    campaignDiscount: 10,
    couponDiscount: 20,
    shippingDiscount: 5,
    shippingFeeBeforeDiscount: 30,
    shippingFee: 25,
    total: 190,
    coupon: { applied: true, normalizedCode: 'SAVE20' },
    breakdown: [{ source: 'coupon', label: 'Save', amount: 25 }],
    allocations: [{ product_id: 1, discount: 20 }],
  });
  assert.equal(columns.couponCode, 'SAVE20');
  assert.equal(columns.discountTotal, 35);
  assert.equal(columns.snapshot.shippingFeeBeforeDiscount, 30);
  assert.deepEqual(columns.snapshot.allocations, [{ product_id: 1, discount: 20 }]);
});

test('043 migration keeps coupon limits, scopes, RLS and order snapshot rollback together', () => {
  const up = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '043_coupon_promotion_engine.sql'), 'utf8');
  const down = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '043_coupon_promotion_engine.down.sql'), 'utf8');
  assert.match(up, /discount_type in \('percentage','fixed','free_shipping'\)/);
  assert.match(up, /stacking_policy in \('exclusive','with_campaign','best_discount'\)/);
  assert.match(up, /coupon_products/);
  assert.match(up, /coupon_categories/);
  assert.match(up, /coupon_collections/);
  assert.match(up, /status in \('reserved','redeemed','released'\)/);
  assert.match(up, /promotion_snapshot jsonb/);
  assert.match(up, /force row level security/);
  assert.match(down, /drop column if exists promotion_snapshot/);
});

