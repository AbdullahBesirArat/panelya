const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expireInventoryReservationsWithReport } = require('../services/inventoryReservations');

const {
  workerConfig,
  runExpiryOnce,
  startInventoryExpiryWorker,
} = require('../services/inventoryExpiryWorker');

const quietLogger = { info() {}, warn() {} };

test('R10: the worker is OFF unless explicitly enabled', () => {
  assert.equal(workerConfig({}).enabled, false);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_WORKER_ENABLED: 'false' }).enabled, false);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_WORKER_ENABLED: '1' }).enabled, false);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_WORKER_ENABLED: 'true' }).enabled, true);
});

test('R10: interval, batch limit and dry-run are parsed and clamped', () => {
  const defaults = workerConfig({});
  assert.equal(defaults.intervalMs, 60_000);
  assert.equal(defaults.limit, 100);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.graceMinutes, 1440);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_IBAN_GRACE_MINUTES: '0' }).graceMinutes, 1440);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_IBAN_GRACE_MINUTES: '0.5' }).graceMinutes, 1);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_IBAN_GRACE_MINUTES: '999999' }).graceMinutes, 10080);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_INTERVAL_MS: '1' }).intervalMs, 10_000);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_INTERVAL_MS: '999999999' }).intervalMs, 3_600_000);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_INTERVAL_MS: 'abc' }).intervalMs, 60_000);
  assert.equal(workerConfig({ INVENTORY_RESERVATION_EXPIRE_LIMIT: '0' }).limit, 100);
  assert.equal(workerConfig({ INVENTORY_RESERVATION_EXPIRE_LIMIT: '5' }).limit, 5);
  assert.equal(workerConfig({ INVENTORY_RESERVATION_EXPIRE_LIMIT: '99999' }).limit, 500);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_DRY_RUN: 'true' }).dryRun, true);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_DRY_RUN: 'yes' }).dryRun, false);
});

test('R10: a missed cancellation leaves stock and promotion untouched and logs the skip', async () => {
  const queries = [];
  const output = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('select eligibility.reason')) return { rows: [] };
      if (sql.startsWith('select r.id')) {
        return { rows: [{ id: 'reservation', organization_id: 'tenant', order_id: 'order' }] };
      }
      if (sql.startsWith('update orders')) return { rowCount: 0 };
      assert.ok(['begin', 'commit'].includes(sql), `unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const result = await runExpiryOnce({
    expire: () => expireInventoryReservationsWithReport({
      pool: { connect: async () => client }, organizationId: 'tenant',
    }),
    logger: { info: (message) => output.push(message), warn: assert.fail },
  });
  assert.deepEqual(result, { expired: 0, skipped: { cancel_update_missed: 1 } });
  assert.equal(queries.at(-1), 'commit');
  assert.match(output[0], /skipped=1.*cancel_update_missed/);
});

test('R10: a real run expires with the configured batch size and reports the count', async () => {
  const calls = [];
  const result = await runExpiryOnce({
    config: { dryRun: false, limit: 7 },
    expire: async (options) => { calls.push(options); return ['a', 'b']; },
    count: async () => { throw new Error('count must not run in a real run'); },
    logger: quietLogger,
  });
  assert.deepEqual(calls, [{ limit: 7 }]);
  assert.equal(result.expired, 2);
});

test('R10: dry-run only counts; it never expires anything', async () => {
  let expireCalled = false;
  const result = await runExpiryOnce({
    config: { dryRun: true, limit: 100 },
    expire: async () => { expireCalled = true; return []; },
    count: async () => 4,
    logger: quietLogger,
  });
  assert.equal(expireCalled, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.due, 4);
});

test('R10: overlapping runs are skipped, and the lock is released after an error', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = runExpiryOnce({
    config: { dryRun: false, limit: 1 },
    expire: async () => { await gate; return []; },
    logger: quietLogger,
  });
  const overlapping = await runExpiryOnce({
    config: { dryRun: false, limit: 1 },
    expire: async () => { throw new Error('must not run concurrently'); },
    logger: quietLogger,
  });
  assert.equal(overlapping.skipped, true);
  release();
  await slow;

  const failed = await runExpiryOnce({
    config: { dryRun: false, limit: 1 },
    expire: async () => { throw new Error('boom'); },
    logger: { info() {}, warn() {} },
  });
  assert.equal(failed.error, true);
  const afterFailure = await runExpiryOnce({
    config: { dryRun: false, limit: 1 },
    expire: async () => ['x'],
    logger: quietLogger,
  });
  assert.equal(afterFailure.expired, 1, 'a failed run must not wedge the worker');
});

test('R10: start returns null (no timers) when disabled, and under test unless enabled', () => {
  const timers = [];
  const fakeSet = (fn, ms) => { const handle = { fn, ms, unref() {} }; timers.push(handle); return handle; };
  assert.equal(startInventoryExpiryWorker({ env: {}, setIntervalFn: fakeSet, setTimeoutFn: fakeSet }), null);
  assert.equal(startInventoryExpiryWorker({
    env: { NODE_ENV: 'test' }, setIntervalFn: fakeSet, setTimeoutFn: fakeSet,
  }), null);
  assert.equal(timers.length, 0);
});

test('R10: start schedules an unref-ed interval when enabled', () => {
  const timers = [];
  const fakeSet = (fn, ms) => {
    const handle = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
    timers.push(handle);
    return handle;
  };
  const handle = startInventoryExpiryWorker({
    env: { INVENTORY_EXPIRY_WORKER_ENABLED: 'true', INVENTORY_EXPIRY_INTERVAL_MS: '30000' },
    setIntervalFn: fakeSet,
    setTimeoutFn: fakeSet,
  });
  assert.ok(handle);
  assert.ok(timers.length >= 2, 'a startup tick and a recurring interval');
  assert.ok(timers.every((timer) => timer.unrefCalled), 'timers must not keep the process alive');
  assert.ok(timers.some((timer) => timer.ms === 30_000));
});

test('R10: server.js starts the worker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /startInventoryExpiryWorker\(\);/);
});
