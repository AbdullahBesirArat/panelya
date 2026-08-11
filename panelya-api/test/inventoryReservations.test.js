const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  guestReferenceHash,
  reservationTtlMinutes,
} = require('../services/inventoryReservations');
const { checkoutIdempotencyKey, findCheckoutReplay } = require('../services/checkoutIdempotency');

test('reservation TTL is bounded and guest references are tenant-isolated hashes', () => {
  assert.equal(reservationTtlMinutes(5), 5);
  assert.equal(reservationTtlMinutes(10080), 10080);
  assert.equal(reservationTtlMinutes(4), 15);
  assert.equal(reservationTtlMinutes(10081), 15);
  assert.equal(guestReferenceHash('org-a', ''), null);
  assert.equal(guestReferenceHash('org-a', ' USER@Example.Test '), guestReferenceHash('org-a', 'user@example.test'));
  assert.notEqual(guestReferenceHash('org-a', 'user@example.test'), guestReferenceHash('org-b', 'user@example.test'));
  assert.match(guestReferenceHash('org-a', 'user@example.test'), /^[a-f0-9]{64}$/);
});

test('checkout idempotency keys accept safe retry tokens and reject unsafe input', () => {
  assert.equal(checkoutIdempotencyKey({ get: () => 'checkout_123', body: {} }), 'checkout_123');
  assert.equal(checkoutIdempotencyKey({ get: () => '', body: { idempotencyKey: '' } }), null);
  assert.throws(
    () => checkoutIdempotencyKey({ get: () => 'short', body: {} }),
    (error) => error.status === 400
  );
  assert.throws(
    () => checkoutIdempotencyKey({ get: () => 'checkout key with spaces', body: {} }),
    (error) => error.status === 400
  );
});

test('checkout replay lookup is tenant-scoped and includes reservation server time', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 1, reservation_status: 'active', server_time: 'now' }] };
    },
  };
  const replay = await findCheckoutReplay(client, 'org-a', 'checkout_123');
  assert.equal(replay.id, 1);
  assert.deepEqual(calls[0].params, ['org-a', 'checkout_123']);
  assert.match(calls[0].sql, /orders\.organization_id = \$1/);
  assert.match(calls[0].sql, /now\(\) as server_time/);
});

test('042 migration defines expiring tenant reservations and a multi-instance worker contract', () => {
  const up = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '042_inventory_reservations.sql'), 'utf8');
  const down = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '042_inventory_reservations.down.sql'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'inventoryReservations.js'), 'utf8');

  assert.match(up, /status in \('active', 'consumed', 'released', 'expired'\)/);
  assert.match(up, /unique \(organization_id, order_id\)/);
  assert.match(up, /idx_inventory_reservations_org_idempotency/);
  assert.match(up, /inventory_reservation_items_variant_org_fk/);
  assert.match(up, /inventory_worker_health/);
  assert.match(service, /order by expires_at, id[\s\S]*for update skip locked/);
  assert.match(service, /order by item\.variant_id/);
  assert.match(service, /consume:\$\{reservation\.id\}:revision:/);
  assert.match(down, /drop table if exists inventory_reservation_items/);
  assert.match(down, /drop column if exists checkout_idempotency_key/);
});

