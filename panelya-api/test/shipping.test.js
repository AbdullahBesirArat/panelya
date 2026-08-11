const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  configuredQuotes, packageMetrics, priceRate, quoteCheckoutShipping, zoneMatches,
} = require('../modules/shipping/pricing');
const { manualProvider } = require('../modules/shipping/providers');
const { assertShipmentTransition } = require('../modules/shipping/service');
const { normalizeShipment, safeExternalUrl } = require('../modules/shipping/validation');

test('flat, free-threshold and weight rates are calculated in cents-safe money', () => {
  const metrics = { weightKg: 2.5 };
  assert.equal(priceRate({ calculation_type: 'flat', amount: 49.9 }, metrics, 100), 49.9);
  assert.equal(priceRate({ calculation_type: 'free_threshold', amount: 49.9, free_shipping_threshold: 500 }, metrics, 500), 0);
  assert.equal(priceRate({ calculation_type: 'weight_band', amount: 10, per_kg_amount: 4.2 }, metrics, 100), 20.5);
});

test('zone matching is Turkish-aware and empty city list means entire country', () => {
  assert.equal(zoneMatches({ countries: ['TR'], cities: ['İstanbul'] }, { country: 'tr', city: 'istanbul' }), true);
  assert.equal(zoneMatches({ countries: ['TR'], cities: ['Ankara'] }, { country: 'TR', city: 'İstanbul' }), false);
  assert.equal(zoneMatches({ countries: ['TR'], cities: [] }, { country: 'TR', city: 'İzmir' }), true);
});

test('package metrics add quantity, weight and greater of explicit/computed desi', () => {
  const metrics = packageMetrics(
    [{ product_id: 7, quantity: 2 }],
    [{ product_id: 7, weight_kg: 1.25, length_cm: 30, width_cm: 20, height_cm: 10, desi: 1, shipping_class: 'fragile' }]
  );
  assert.equal(metrics.weightKg, 2.5);
  assert.equal(metrics.desi, 4);
  assert.deepEqual([...metrics.shippingClasses], ['fragile']);
});

test('configured quotes apply zone, class and weight rules and sort by amount', () => {
  const common = {
    countries: ['TR'], cities: ['İstanbul'], min_subtotal: 0, max_subtotal: null,
    min_weight_kg: 0, max_weight_kg: 5, min_desi: 0, max_desi: null,
    shipping_class: 'fragile', provider: 'manual', currency: 'TRY', profile_id: 'p',
  };
  const quotes = configuredQuotes([
    { ...common, rate_id: 'expensive', rate_name: 'Express', calculation_type: 'flat', amount: 80 },
    { ...common, rate_id: 'cheap', rate_name: 'Standart', calculation_type: 'flat', amount: 40 },
  ], { country: 'TR', city: 'istanbul', subtotal: 100, metrics: { weightKg: 2, desi: 1, shippingClasses: new Set(['fragile']) } });
  assert.deepEqual(quotes.map((quote) => quote.rateId), ['cheap', 'expensive']);
});

test('checkout quote ignores client price and falls back to server store settings', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('product_shipping_attributes')) return { rows: [] };
      if (sql.includes('shipping_profiles')) return { rows: [] };
      throw new Error('unexpected query');
    },
  };
  const quote = await quoteCheckoutShipping(client, {
    organizationId: 'org-a', items: [{ product_id: 1, quantity: 1 }], subtotal: 300,
    city: 'İstanbul', settings: { shippingFee: 49.9, freeShippingThreshold: 500 },
  });
  assert.equal(quote.amount, 49.9);
  const free = await quoteCheckoutShipping(client, {
    organizationId: 'org-a', items: [{ product_id: 1, quantity: 1 }], subtotal: 500,
    city: 'İstanbul', settings: { shippingFee: 49.9, freeShippingThreshold: 500 },
  });
  assert.equal(free.amount, 0);
});

test('shipment input supports partial quantities but rejects duplicate lines and unsafe tracking URLs', () => {
  const input = normalizeShipment({
    order_id: 9, provider: 'manual', carrier_name: 'Manual Kargo',
    tracking_url: 'https://carrier.example/track/1', items: [{ order_item_id: 12, quantity: 1 }],
  });
  assert.equal(input.items[0].quantity, 1);
  assert.equal(safeExternalUrl('https://carrier.example/a'), 'https://carrier.example/a');
  assert.throws(() => safeExternalUrl('javascript:alert(1)'), /yalniz HTTPS/);
  assert.throws(() => normalizeShipment({
    order_id: 9, carrier_name: 'Manual',
    items: [{ order_item_id: 12, quantity: 1 }, { order_item_id: 12, quantity: 1 }],
  }), /iki kez/);
});

test('shipment state machine supports cancel and returned without reopening terminal states', () => {
  assert.doesNotThrow(() => assertShipmentTransition('pending', 'cancelled'));
  assert.doesNotThrow(() => assertShipmentTransition('delivered', 'returned'));
  assert.throws(() => assertShipmentTransition('cancelled', 'shipped'), /gecilemez/);
  assert.throws(() => assertShipmentTransition('returned', 'delivered'), /gecilemez/);
});

test('manual provider has complete adapter and rejects invalid webhook signatures', async () => {
  const provider = manualProvider();
  for (const method of ['quoteRates', 'createShipment', 'cancelShipment', 'getLabel', 'trackShipment', 'handleWebhook', 'verifyWebhook', 'createReturnShipment']) {
    assert.equal(typeof provider[method], 'function');
  }
  const payload = { event_id: 'evt-1', shipment_id: 'abc', status: 'delivered' };
  const signature = crypto.createHmac('sha256', 'secret').update(JSON.stringify(payload)).digest('hex');
  assert.equal(provider.verifyWebhook({ payload, signature, secret: 'secret' }), true);
  assert.equal(provider.verifyWebhook({ payload, signature: 'bad', secret: 'secret' }), false);
});

test('046 migration defines tenant RLS, multi-shipment quantities, webhook idempotency and protected labels', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/046_shipping_fulfillment.sql'), 'utf8');
  assert.match(migration, /create table if not exists shipping_profiles/i);
  assert.match(migration, /create table if not exists shipment_items/i);
  assert.match(migration, /quantity integer not null check \(quantity > 0\)/i);
  assert.match(migration, /carrier_webhook_events_org_key unique \(organization_id, provider, event_key\)/i);
  assert.match(migration, /alter table %I force row level security/i);
  assert.match(migration, /shipment_events are append-only/i);
  assert.match(migration, /shipping_labels/i);
});
