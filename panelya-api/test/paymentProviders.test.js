const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { initializePayment, providerName, retrievePayment } = require('../services/paymentProviders');

function withEnv(env, fn) {
  const prev = {
    PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    NODE_ENV: process.env.NODE_ENV,
    IYZICO_API_KEY: process.env.IYZICO_API_KEY,
    IYZICO_SECRET_KEY: process.env.IYZICO_SECRET_KEY,
    IYZICO_BASE_URL: process.env.IYZICO_BASE_URL,
  };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('production-benzeri ortamda bilinmeyen PAYMENT_PROVIDER reddedilir (mock fallback yok)', () => {
  withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'stripe' }, () => {
    assert.throws(() => providerName(), (err) => err.code === 'PAYMENT_PROVIDER_MISCONFIGURED');
  });
});

test('gecersiz PAYMENT_PROVIDER development ortaminda da reddedilir (yanlis yapilandirma)', () => {
  withEnv({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'iyzicoo' }, () => {
    assert.throws(() => providerName(), (err) => err.code === 'PAYMENT_PROVIDER_MISCONFIGURED');
  });
});

test('production ortaminda PAYMENT_PROVIDER tanimsizsa hata verir (mock varsayilana dusmez)', () => {
  withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: undefined }, () => {
    assert.throws(() => providerName(), (err) => /tanimlanmalidir/.test(err.message));
  });
});

test('production ortaminda PAYMENT_PROVIDER=mock reddedilir', () => {
  withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'mock' }, () => {
    assert.throws(() => providerName(), (err) => err.code === 'PAYMENT_PROVIDER_MISCONFIGURED');
  });
});

test('production disinda acikca mock secilirse mock doner', () => {
  withEnv({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'MOCK' }, () => {
    assert.equal(providerName(), 'mock');
  });
});

test('development/test ortaminda PAYMENT_PROVIDER tanimsizsa guvenli mock varsayilani calisir', () => {
  withEnv({ NODE_ENV: 'test', PAYMENT_PROVIDER: undefined }, () => {
    assert.equal(providerName(), 'mock');
  });
});

test('iyzico gecerli deger olarak kabul edilir', () => {
  withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'iyzico' }, () => {
    assert.equal(providerName(), 'iyzico');
  });
});

test('manual production ortaminda bilinen offline provider sayilir', () => {
  withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'manual' }, () => {
    assert.equal(providerName(), 'manual');
  });
});

test('manual provider kartli odeme initialize istegini guvenli reddeder', async () => {
  await withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'manual' }, async () => {
    await assert.rejects(
      initializePayment({
        req: { protocol: 'https', get: () => 'api.example.test' },
        order: { order_code: 'ORD-1', total: 100 },
        customer: {},
        items: [],
      }),
      (err) => err.status === 400
        && err.code === 'CARD_PAYMENT_PROVIDER_INACTIVE'
        && /Kartli odeme saglayicisi aktif degil/.test(err.message)
    );
  });
});

test('manual provider callback retrieve yolunda mock basari uretmez', async () => {
  await withEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'manual' }, async () => {
    await assert.rejects(
      retrievePayment({ token: 'manual-token', conversationId: 'ORD-1' }),
      (err) => err.status === 400 && err.code === 'CARD_PAYMENT_PROVIDER_INACTIVE'
    );
  });
});

test('iyzico provider eksik env ile initialize edilirse mevcut hata korunur', async () => {
  await withEnv({
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'iyzico',
    IYZICO_API_KEY: undefined,
    IYZICO_SECRET_KEY: undefined,
    IYZICO_BASE_URL: undefined,
  }, async () => {
    await assert.rejects(
      initializePayment({
        req: { protocol: 'https', get: () => 'api.example.test' },
        order: { order_code: 'ORD-1', total: 100 },
        customer: { name: 'Test User' },
        items: [],
      }),
      (err) => err.status === 500 && /Iyzico API bilgileri eksik/.test(err.message)
    );
  });
});

test('payment initialize yalniz iban/havale seciminde offline manual order olusturur', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  assert.match(routeSource, /const offlinePayment = checkoutOptions\.paymentMethod === 'iban'/);
  assert.match(routeSource, /const provider = offlinePayment\s*\?\s*'manual'\s*:\s*providerName\(\)/);
  assert.match(routeSource, /const payment = offlinePayment\s*\?\s*\{ token: null, paymentPageUrl: null, failureUrl: null \}\s*:\s*await initializePayment/s);
});
