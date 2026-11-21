const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SCOPES, checkoutIdempotencyKey, checkoutRequestFingerprint, assertReplayMatches,
} = require('../services/checkoutIdempotency');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const KEY = 'checkout-key-0001';

function body() {
  return {
    customer: { name: 'Ayşe Yılmaz', email: 'ayse@example.test', phone: '+905551112233', address: 'Sokak 1 / Kadıköy / İstanbul', city: 'İstanbul', district: 'Kadıköy', country: 'TR' },
    items: [{ product_id: 'p1', variant_id: 'v1', quantity: 2 }, { product_id: 'p2', variant_id: null, quantity: 1 }],
    cart_id: '33333333-3333-4333-8333-333333333333',
    cart_version: 7,
    shipping_fee: 49.9,
    paymentMethod: 'iban',
    invoice: { type: 'individual', full_name: 'Ayşe Yılmaz', vkn: '', tax_office: '', invoice_address: 'Sokak 1', email: 'ayse@example.test' },
    note: 'Kapıda bırakın',
    couponCode: 'YAZ10',
  };
}
const fp = (overrides = {}) => checkoutRequestFingerprint({
  organizationId: ORG_A, scope: SCOPES.orders, key: KEY, body: body(), ...overrides,
});

test('the fingerprint is deterministic and independent of property order', () => {
  const original = fp();
  assert.match(original, /^v1:[0-9a-f]{64}$/);
  assert.equal(fp(), original);
  const b = body();
  const shuffled = Object.fromEntries(Object.entries(b).reverse());
  shuffled.customer = Object.fromEntries(Object.entries(b.customer).reverse());
  assert.equal(fp({ body: shuffled }), original);
});

test('semantically equal requests share a fingerprint', () => {
  const original = fp();
  const equivalents = {
    'blank optional field vs omitted': (b) => { b.invoice.vkn = '   '; },
    'surrounding whitespace': (b) => { b.customer.name = '  Ayşe Yılmaz  '; },
    'decomposed unicode (NFC)': (b) => { b.customer.name = 'Ayşe Yılmaz'.normalize('NFD'); },
    'numeric representation': (b) => { b.shipping_fee = 49.90; },
    'item line order': (b) => { b.items.reverse(); },
    'idempotency fields in the body': (b) => { b.idempotencyKey = KEY; b.idempotency_key = KEY; },
  };
  for (const [label, mutate] of Object.entries(equivalents)) {
    const b = body();
    mutate(b);
    assert.equal(fp({ body: b }), original, label);
  }
});

test('null, undefined and omitted are the same "not provided"', () => {
  const a = body(); a.couponCode = null; a.note = undefined;
  const b = body(); delete b.couponCode; delete b.note;
  assert.equal(fp({ body: a }), fp({ body: b }));
});

test('every material checkout input changes the fingerprint', () => {
  const original = fp();
  const changes = {
    'coupon changed': (b) => { b.couponCode = 'KIS20'; },
    'coupon removed': (b) => { delete b.couponCode; },
    'note changed': (b) => { b.note = 'Zili çalmayın'; },
    'invoice vkn changed': (b) => { b.invoice.vkn = '1234567890'; },
    'invoice type changed': (b) => { b.invoice.type = 'company'; },
    'billing address changed': (b) => { b.invoice.invoice_address = 'Başka adres'; },
    'customer email changed': (b) => { b.customer.email = 'baska@example.test'; },
    'customer phone changed': (b) => { b.customer.phone = '+905559998877'; },
    'shipping address changed': (b) => { b.customer.address = 'Yeni adres'; },
    'shipping fee changed': (b) => { b.shipping_fee = 0; },
    'cart version changed': (b) => { b.cart_version = 8; },
    'cart id changed': (b) => { b.cart_id = '44444444-4444-4444-8444-444444444444'; },
    'item quantity changed': (b) => { b.items[0].quantity = 3; },
    'item variant changed': (b) => { b.items[0].variant_id = 'v9'; },
    'item added': (b) => { b.items.push({ product_id: 'p3', quantity: 1 }); },
    'payment method changed': (b) => { b.paymentMethod = 'card'; },
    'gift selection added': (b) => { b.gift_wrap = { option_id: 'gw-1', note: 'Doğum günün kutlu olsun' }; },
  };
  const seen = new Set([original]);
  for (const [label, mutate] of Object.entries(changes)) {
    const b = body();
    mutate(b);
    const next = fp({ body: b });
    assert.notEqual(next, original, label);
    seen.add(next);
  }
  assert.equal(seen.size, Object.keys(changes).length + 1, 'distinct changes produce distinct fingerprints');
});

test('the fingerprint is bound to tenant, endpoint namespace and key', () => {
  const original = fp();
  assert.notEqual(fp({ organizationId: ORG_B }), original);
  assert.notEqual(fp({ scope: SCOPES.paymentInitialize }), original);
  assert.notEqual(fp({ key: 'checkout-key-0002' }), original);
  assert.throws(() => fp({ scope: 'something-else' }), /scope/);
});

test('no key means no fingerprint and the raw payload is never part of the digest string', () => {
  assert.equal(fp({ key: null }), null);
  assert.doesNotMatch(fp(), /ayse|5551112233|YAZ10/i);
});

test('assertReplayMatches: matching replay passes and the internal column is stripped', () => {
  const expected = fp();
  const row = { id: 1, order_code: 'A-1', checkout_request_fingerprint: expected };
  const out = assertReplayMatches(row, expected);
  assert.equal(out, row);
  assert.equal('checkout_request_fingerprint' in out, false);
});

test('assertReplayMatches: a different request is a stable 409 and still never leaks the column', () => {
  const stored = fp();
  const changed = body();
  changed.couponCode = 'BASKA';
  const row = { id: 1, checkout_request_fingerprint: stored };
  assert.throws(() => assertReplayMatches(row, fp({ body: changed })), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.doesNotMatch(error.message, /YAZ10|ayse|v1:/i);
    return true;
  });
  assert.equal('checkout_request_fingerprint' in row, false);
});

test('assertReplayMatches: legacy rows without a fingerprint keep the historical replay; no row is a no-op', () => {
  const legacy = { id: 9, checkout_request_fingerprint: null };
  assert.equal(assertReplayMatches(legacy, fp()), legacy);
  assert.equal(assertReplayMatches(null, fp()), null);
  assert.equal(assertReplayMatches({ id: 2, checkout_request_fingerprint: fp() }, null).id, 2);
});

test('the idempotency key policy is unchanged', () => {
  const req = (value) => ({ get: () => value, body: {} });
  assert.equal(checkoutIdempotencyKey(req('')), null);
  assert.equal(checkoutIdempotencyKey(req('valid-key-1234')), 'valid-key-1234');
  assert.throws(() => checkoutIdempotencyKey(req('short')), (error) => error.status === 400);
  assert.throws(() => checkoutIdempotencyKey(req('bad key with spaces')), (error) => error.status === 400);
  assert.throws(() => checkoutIdempotencyKey(req('x'.repeat(129))), (error) => error.status === 400);
});
