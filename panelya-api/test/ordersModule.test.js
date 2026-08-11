const assert = require('node:assert/strict');
const test = require('node:test');
const { orderDetailView, publicOrderView } = require('../modules/orders/presenter');
const { shouldKeepManualReservation } = require('../modules/orders/policy');
const { findOrderForTracking } = require('../modules/orders/repository');
const { safePaging, trackQuery } = require('../modules/orders/validation');

test('orders validation normalizes paging and public tracking aliases', () => {
  assert.deepEqual(safePaging('999', '-5'), { limit: 200, offset: 0 });
  assert.deepEqual(safePaging(undefined, undefined, 25), { limit: 25, offset: 0 });
  assert.deepEqual(trackQuery({ query: { code: '#1001', email: 'buyer@example.test' } }), {
    code: '#1001',
    email: 'buyer@example.test',
    orderCode: '#1001',
    customerEmail: 'buyer@example.test',
  });
});

test('manual reservation policy distinguishes reserve and consume modes', () => {
  assert.equal(shouldKeepManualReservation('iban', 'reserve'), true);
  assert.equal(shouldKeepManualReservation('iban', 'consume'), false);
  assert.equal(shouldKeepManualReservation('card', 'reserve'), false);
});

test('public order presenter exposes the stable customer view and normalizes collections', () => {
  const view = publicOrderView({
    id: 7,
    order_code: '#1007',
    customer_name: 'Müşteri',
    email: 'buyer@example.test',
    phone: '05550000000',
    address: 'İstanbul',
    items: null,
    timeline: [{ id: 1 }],
    customer_notes: null,
  });

  assert.equal(view.id, 7);
  assert.deepEqual(view.customer, {
    name: 'Müşteri',
    email: 'buyer@example.test',
    phone: '05550000000',
    address: 'İstanbul',
  });
  assert.deepEqual(view.items, []);
  assert.deepEqual(view.timeline, [{ id: 1 }]);
  assert.deepEqual(view.customer_notes, []);
  assert.equal(Object.hasOwn(view, 'customer_snapshot'), false);
});

test('order detail presenter prefers immutable customer and shipping snapshots', () => {
  const view = orderDetailView({
    id: 8,
    customer_id: 3,
    customer_name: 'Güncel',
    email: 'current@example.test',
    phone: '05551111111',
    address: 'Güncel adres',
    customer_snapshot: {
      id: 2,
      name: 'Sipariş Anı',
      email: 'snapshot@example.test',
      phone: '05552222222',
      address: 'Eski adres',
    },
    shipping_address_snapshot: { city: 'İstanbul' },
    items: null,
  });

  assert.equal(view.customer.name, 'Sipariş Anı');
  assert.equal(view.current_customer.name, 'Güncel');
  assert.deepEqual(view.shipping_address, { city: 'İstanbul' });
  assert.deepEqual(view.items, []);
});

test('tracking repository scopes order code and optional customer email to one tenant', async () => {
  let query;
  const client = {
    async query(text, params) {
      query = { text, params };
      return { rows: [{ id: 9 }] };
    },
  };

  const row = await findOrderForTracking(client, {
    organizationId: 12,
    orderCode: '#1009',
    customerEmail: 'buyer@example.test',
  });

  assert.equal(row.id, 9);
  assert.deepEqual(query.params, [12, '#1009', 'buyer@example.test']);
  assert.match(query.text, /o\.organization_id = \$1/);
  assert.match(query.text, /o\.order_code = \$2/);
  assert.match(query.text, /lower\(c\.email\) = \$3/);
});
