const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  assertTransition,
  canMutateNote,
  deliverPendingOrderNotifications,
  packingListSnapshot,
  projectLegacyStatus,
  transitionOrderOperation,
  transitionsFor,
} = require('../services/orderOperations');

test('order, payment and fulfillment state machines allow only declared transitions', () => {
  assert.equal(assertTransition('order', 'pending_payment', 'paid'), true);
  assert.equal(assertTransition('payment', 'authorized', 'paid'), true);
  assert.equal(assertTransition('fulfillment', 'ready_to_ship', 'shipped'), true);
  assert.throws(
    () => assertTransition('order', 'paid', 'delivered'),
    (error) => error.code === 'ORDER_TRANSITION_INVALID'
      && error.details.validTransitions.includes('processing')
  );
  assert.deepEqual(transitionsFor('order', 'refunded'), []);
  assert.equal(projectLegacyStatus('ready_to_ship'), 'processing');
});

test('optimistic order transition rejects a stale version before side effects', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rows: [{
        id: '7', organization_id: 'org-a', status: 'payment_pending', order_status: 'pending_payment',
        payment_status: 'pending', fulfillment_status: 'unfulfilled', version: 4,
      }] };
    },
  };
  let inventoryCalls = 0;
  await assert.rejects(
    transitionOrderOperation(client, {
      organizationId: 'org-a', orderId: '7', changes: { order: 'paid' }, expectedVersion: 3,
      transitionInventory: async () => { inventoryCalls += 1; },
      transitionPromotion: async () => {},
    }),
    (error) => error.code === 'ORDER_VERSION_CONFLICT' && error.details.currentVersion === 4
  );
  assert.equal(inventoryCalls, 0);
  assert.equal(queries.length, 1);
});

test('note edit policy is author-limited for members and unrestricted for managers', () => {
  const now = new Date('2026-08-02T12:00:00Z');
  const recent = { author_user_id: 'user-a', created_at: '2026-08-02T11:00:00Z' };
  const old = { author_user_id: 'user-a', created_at: '2026-07-30T11:00:00Z' };
  assert.equal(canMutateNote(recent, { id: 'user-a', role: 'member' }, now), true);
  assert.equal(canMutateNote(recent, { id: 'user-b', role: 'member' }, now), false);
  assert.equal(canMutateNote(old, { id: 'user-a', role: 'member' }, now), false);
  assert.equal(canMutateNote(old, { id: 'user-b', role: 'admin' }, now), true);
});

test('packing list omits price by default and keeps immutable customer/variant snapshot', () => {
  const snapshot = packingListSnapshot({
    id: '1',
    order_code: 'SV-100',
    customer_snapshot: { name: 'Snapshot Customer' },
    shipping_address_snapshot: { address: 'Snapshot Address' },
    gift_wrap: true,
    note: 'Hediye notu',
    items: [{
      product_id: '2', variant_id: '3', name: 'Elbise', sku: 'SKU-3', color: 'Siyah', size: 'M',
      quantity: 2, unit_price: '100.00', line_total: '200.00',
    }],
  });
  assert.equal(snapshot.customer.name, 'Snapshot Customer');
  assert.equal(snapshot.shippingAddress.address, 'Snapshot Address');
  assert.equal(snapshot.items[0].variant, 'Siyah / M');
  assert.equal(Object.hasOwn(snapshot.items[0], 'unitPrice'), false);
  const priced = packingListSnapshot({ ...snapshot, id: '1', order_code: 'SV-100', items: [{ name: 'Elbise', quantity: 1, unit_price: '100', line_total: '100' }] }, true);
  assert.equal(priced.items[0].unitPrice, '100');
});

test('notification delivery invokes sender only after the claim transaction commits', async () => {
  const sequence = [];
  const row = {
    outbox_id: '9', order_id: '7', organization_id: 'org-a', order_code: 'SV-7',
    status: 'paid', customer_name: 'Ada', email: 'ada@example.test', phone: '', address: '',
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).trim().toLowerCase();
      if (normalized === 'begin') sequence.push('begin');
      else if (normalized === 'commit') sequence.push('commit');
      else if (normalized === 'rollback') sequence.push('rollback');
      else if (normalized.startsWith('select ob.id')) return { rows: [row] };
      else if (normalized.startsWith('update order_notification_outbox')) sequence.push('claim');
      return { rows: [] };
    },
    release() { sequence.push('release'); },
  };
  const pool = {
    async connect() { return client; },
    async query() { sequence.push('mark-sent'); return { rows: [] }; },
  };
  await deliverPendingOrderNotifications({
    pool,
    send: async () => {
      assert.ok(sequence.indexOf('commit') > -1);
      sequence.push('send');
    },
  });
  assert.ok(sequence.indexOf('send') > sequence.indexOf('commit'));
  assert.ok(sequence.indexOf('mark-sent') > sequence.indexOf('send'));
});

test('044 migration separates states, applies RLS and makes order events append-only', () => {
  const up = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '044_order_operations_timeline.sql'), 'utf8');
  const down = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '044_order_operations_timeline.down.sql'), 'utf8');
  assert.match(up, /add column if not exists order_status/);
  assert.match(up, /add column if not exists payment_status/);
  assert.match(up, /add column if not exists fulfillment_status/);
  assert.match(up, /order_events are append-only/);
  assert.match(up, /order_notification_outbox/);
  assert.match(up, /force row level security/);
  assert.doesNotMatch(up, /payment_callback_events[\s\S]{0,120}internal_metadata/i);
  assert.match(down, /drop table if exists order_events/);
  assert.match(down, /drop column if exists order_status/);
});
