const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateToken, hashToken, verifyToken, isValidTokenFormat, safeEqualHex,
} = require('../modules/cart/token');
const { normalizeQuantity, serializeCart } = require('../modules/cart/service');
const { abandonSettings, expireStaleCarts } = require('../modules/cart/abandoned');
const { roundMoney, emptyTotals } = require('../modules/cart/pricing');

test('guest token is high-entropy, opaque and hashed deterministically', () => {
  const token = generateToken();
  assert.ok(isValidTokenFormat(token));
  assert.equal(token.length >= 43, true);
  assert.notEqual(generateToken(), generateToken());
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashToken(token), hash); // deterministic
});

test('token verification is timing-safe and rejects tampering / bad formats', () => {
  const token = generateToken();
  const hash = hashToken(token);
  const tamperedSuffix = token.endsWith('x') ? 'y' : 'x';
  assert.equal(verifyToken(token, hash), true);
  assert.equal(verifyToken(`${token.slice(0, -1)}${tamperedSuffix}`, hash), false);
  assert.equal(verifyToken(token, hash.slice(0, -1) + '0'), false);
  assert.equal(verifyToken('', hash), false);
  assert.equal(verifyToken(token, null), false);
  assert.equal(hashToken('short token with spaces!'), null);
  assert.equal(isValidTokenFormat('nope nope'), false);
  assert.equal(safeEqualHex('aa', 'aabb'), false); // length mismatch never throws
});

test('quantity normalization enforces 1..99 integer bounds', () => {
  assert.equal(normalizeQuantity(1), 1);
  assert.equal(normalizeQuantity('5'), 5);
  assert.equal(normalizeQuantity(99), 99);
  for (const bad of [0, -1, 100, 1.5, 'abc', NaN]) {
    assert.throws(() => normalizeQuantity(bad), (error) => error.code === 'INVALID_QUANTITY');
  }
});

test('serializeCart exposes version/totals and never leaks the guest token hash', () => {
  const cartRow = {
    id: 'cart-1', status: 'active', version: 4, currency: 'TRY', item_count: 2,
    subtotal: 200, discount_total: 20, shipping_total: 0, tax_total: 0, grand_total: 180,
    coupon_code: 'E2E20', last_activity_at: 'now', expires_at: 'later', converted_order_id: null,
    guest_token_hash: 'a'.repeat(64), customer_account_id: null,
  };
  const view = serializeCart(cartRow, [{
    product_id: 7, variant_id: 9, quantity: 2, unit_price_snapshot: 100, line_total_snapshot: 200,
    product_name_snapshot: 'Bluz', sku_snapshot: 'SKU', color_snapshot: 'Siyah', size_snapshot: 'M',
  }], [{ code: 'PRICE_CHANGED' }]);
  assert.equal(view.version, 4);
  assert.equal(view.coupon_applied, true);
  assert.equal(view.items[0].line_total, 200);
  assert.equal(view.adjustments[0].code, 'PRICE_CHANGED');
  assert.equal(JSON.stringify(view).includes('a'.repeat(64)), false);
  assert.equal(JSON.stringify(view).includes('guest_token'), false);
});

test('abandoned settings default safely and clamp tenant input', () => {
  assert.deepEqual(abandonSettings(null), { enabled: false, inactivityMinutes: 60, maxReminders: 1, cooldownHours: 24 });
  const tuned = abandonSettings({ abandoned_cart: { enabled: true, inactivity_minutes: 5, max_reminders: 99, cooldown_hours: 0.5 } });
  assert.equal(tuned.enabled, true);
  assert.equal(tuned.inactivityMinutes, 15); // floored to the 15-minute minimum
  assert.equal(tuned.maxReminders, 5); // capped
  assert.equal(tuned.cooldownHours, 1); // floored to the 1-hour minimum
  assert.equal(abandonSettings({ abandoned_cart: { enabled: true } }).cooldownHours, 24); // unset -> default
  assert.equal(typeof expireStaleCarts, 'function');
});

test('money helper rounds to cents and empty totals are zeroed', () => {
  assert.equal(roundMoney(10.005), 10.01);
  assert.equal(roundMoney('3.1'), 3.1);
  assert.equal(emptyTotals().grandTotal, 0);
  assert.equal(emptyTotals().itemCount, 0);
});
