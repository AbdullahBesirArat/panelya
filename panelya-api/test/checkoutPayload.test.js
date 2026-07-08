const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCheckoutOptions, normalizePaymentMethod } = require('../services/checkoutPayload');

const STORE_SETTINGS = { shippingFee: 49.9, freeShippingThreshold: 500 };

test('kargo ucreti magaza ayarindan alinir, istemci shipping_fee: 0 yollasa bile', () => {
  const options = normalizeCheckoutOptions(
    { items: [], shipping_fee: 0 },
    STORE_SETTINGS,
    200
  );
  assert.equal(options.shippingFee, 49.9);
});

test('istemci yuksek shipping_fee yollasa bile ayar degeri kullanilir', () => {
  const options = normalizeCheckoutOptions(
    { shippingFee: 9999 },
    STORE_SETTINGS,
    200
  );
  assert.equal(options.shippingFee, 49.9);
});

test('freeShippingThreshold gecilince kargo 0 olur', () => {
  const options = normalizeCheckoutOptions(
    { shipping_fee: 49.9 },
    STORE_SETTINGS,
    500
  );
  assert.equal(options.shippingFee, 0);
});

test('esik altinda kargo tam ucret olur', () => {
  const options = normalizeCheckoutOptions({}, STORE_SETTINGS, 499.99);
  assert.equal(options.shippingFee, 49.9);
});

test('shipping_fee ve shippingFee alanlari hesabi degistirmez (subtotal ayni)', () => {
  const base = normalizeCheckoutOptions({}, STORE_SETTINGS, 300);
  const withSnake = normalizeCheckoutOptions({ shipping_fee: 0 }, STORE_SETTINGS, 300);
  const withCamel = normalizeCheckoutOptions({ shippingFee: 12345 }, STORE_SETTINGS, 300);
  assert.equal(base.shippingFee, 49.9);
  assert.equal(withSnake.shippingFee, 49.9);
  assert.equal(withCamel.shippingFee, 49.9);
});

test('eski istemci shipping_fee gonderse bile hata firlatilmaz', () => {
  assert.doesNotThrow(() => {
    normalizeCheckoutOptions({ shipping_fee: -5 }, STORE_SETTINGS, 100);
  });
});

test('ayar yoksa kargo 0 olur', () => {
  const options = normalizeCheckoutOptions({ shipping_fee: 99 }, {}, 100);
  assert.equal(options.shippingFee, 0);
});

test('paymentEnabled false iken kartli odeme reddedilir', () => {
  assert.throws(
    () => normalizeCheckoutOptions(
      { payment_method: 'card' },
      { ...STORE_SETTINGS, paymentEnabled: false },
      100
    ),
    (error) => error.status === 400 && /Kartli odeme/.test(error.message)
  );
});

test('paymentEnabled false iken iban/havale secenegi kabul edilir', () => {
  const options = normalizeCheckoutOptions(
    { payment_method: 'iban' },
    { ...STORE_SETTINGS, paymentEnabled: false },
    100
  );
  assert.equal(options.paymentMethod, 'iban');
  assert.equal(options.shippingFee, 49.9);
});

test('normalizePaymentMethod havale/eft varyantlarini iban olarak eslestirir', () => {
  assert.equal(normalizePaymentMethod({ payment_method: 'havale' }), 'iban');
  assert.equal(normalizePaymentMethod({ paymentMethod: 'bank_transfer' }), 'iban');
  assert.equal(normalizePaymentMethod({ provider: 'manual' }), 'iban');
  assert.equal(normalizePaymentMethod({ provider: 'card' }), 'card');
  assert.equal(normalizePaymentMethod({}), 'card');
});
