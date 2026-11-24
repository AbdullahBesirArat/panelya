const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { expireInventoryReservationsWithReport, inventoryExpiryMethods } = require('../services/inventoryReservations');

const {
  workerConfig,
  workerMode,
  runExpiryOnce,
  startInventoryExpiryWorker,
} = require('../services/inventoryExpiryWorker');

const { inventoryWorkerHealthSnapshot, inventoryWorkerPrometheus } = require('../services/metrics');
const quietLogger = { info() {}, warn() {} };

for (const mode of ['commit', 'rollback', 'no hook', 'disabled methods']) {
  test(`expiry audit transaction: ${mode}`, async () => {
    const calls = [];
    const failure = new Error('audit insert failed');
    let succeeded = 'previous';
    let pendingSuccess = succeeded;
    const client = Object.assign(new EventEmitter(), {
      async query(sql) {
        if (/^select (o.payment_method|r.id)/.test(sql)) return { rows: [] };
        if (sql.startsWith('update inventory_worker_health')) {
          calls.push('heartbeat');
          pendingSuccess = 'current';
          return;
        }
        calls.push(sql);
        if (sql === 'commit') succeeded = pendingSuccess;
        if (sql === 'rollback') pendingSuccess = succeeded;
      },
      release() { calls.push('release'); },
    });
    const methods = mode === 'disabled methods' ? [] : ['card'];
    const report = { methods, due: 0, skipped: {}, byMethod: {}, expired: [] };
    const pool = {
      connect: async () => client,
      async query(sql) {
        if (sql.startsWith('select o.payment_method')) return { rows: [] };
        calls.push(sql.includes('last_failed_at') ? 'failed' : 'started');
      },
    };
    const beforeCommit = mode === 'no hook' ? undefined : async (store, snapshot) => {
      assert.equal(store, client);
      assert.deepEqual(snapshot, report);
      calls.push('audit');
      if (mode === 'rollback') throw failure;
    };
    const run = expireInventoryReservationsWithReport({
      pool, methods, beforeCommit, updateHeartbeat: mode !== 'disabled methods',
    });
    if (mode === 'rollback') {
      await assert.rejects(run, (error) => error === failure);
      assert.deepEqual(calls, ['started', 'begin', 'heartbeat', 'audit', 'rollback', 'release', 'failed']);
      assert.equal(succeeded, 'previous');
      assert.equal(pendingSuccess, 'previous');
    } else {
      assert.deepEqual(await run, report);
      const expected = mode === 'disabled methods' ? ['begin'] : ['started', 'begin', 'heartbeat'];
      if (beforeCommit) expected.push('audit');
      assert.deepEqual(calls, [...expected, 'commit', 'release']);
      assert.equal(succeeded, mode === 'disabled methods' ? 'previous' : 'current');
    }
  });
}

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
  assert.equal(defaults.cardGrace, 60);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_CARD_GRACE_MINUTES: '0' }).cardGrace, 60);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_CARD_GRACE_MINUTES: '0.5' }).cardGrace, 1);
  assert.equal(workerConfig({ INVENTORY_EXPIRY_CARD_GRACE_MINUTES: '999999' }).cardGrace, 1440);
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
  const client = Object.assign(new EventEmitter(), {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('select o.payment_method as method')) return { rows: [] };
      if (sql.startsWith('select r.id')) {
        return { rows: [{ id: 'reservation', organization_id: 'tenant', order_id: 'order', method: 'card' }] };
      }
      if (sql.startsWith('update orders')) return { rowCount: 0 };
      assert.ok(['begin', 'commit'].includes(sql), `unexpected SQL: ${sql}`);
    },
    release() {},
  });
  const result = await runExpiryOnce({
    config: { methods: ['card'] },
    expire: (policy) => expireInventoryReservationsWithReport({
      ...policy,
      pool: { connect: async () => client }, organizationId: 'tenant',
    }),
    logger: { info: (message) => output.push(message), warn: assert.fail },
  });
  assert.deepEqual(result, {
    expired: 0, methods: ['card'], skipped: { cancel_update_missed: 1 },
    byMethod: { card: { due: 0, skipped: { cancel_update_missed: 1 }, expired: 0 } },
  });
  const [, count, claim, cancel, commit] = queries;
  for (const query of [count, claim, cancel]) {
    assert.deepEqual(query.params[3], ['card']);
    assert.match(query.sql, /payment_method = any\(\$4::text\[\]\)/);
  }
  assert.equal(claim.params[4], 100);
  assert.deepEqual(cancel.params.slice(4), ['order', 'reservation']);
  assert.match(cancel.sql, /o\.id = \$5 and r\.id = \$6 and eligibility\.reason is null/);
  assert.equal(commit.sql, 'commit');
  assert.match(output[0], /skipped=1.*cancel_update_missed/);
});

test('R10: a real run expires with the configured batch size and reports the count', async () => {
  const calls = [];
  const result = await runExpiryOnce({
    config: { methods: ['card'], dryRun: false, limit: 7 },
    expire: async (options) => { calls.push(options); return ['a', 'b']; },
    count: async () => { throw new Error('count must not run in a real run'); },
    logger: quietLogger,
  });
  assert.deepEqual(calls, [{ methods: ['card'], graceMinutes: undefined, cardGrace: undefined, limit: 7 }]);
  assert.equal(result.expired, 2);
});

test('R10: dry-run only counts; it never expires anything', async () => {
  let expireCalled = false;
  const result = await runExpiryOnce({
    config: { methods: ['card'], dryRun: true, limit: 100 },
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
    config: { methods: ['card'], dryRun: false, limit: 1 },
    expire: async () => { await gate; return []; },
    logger: quietLogger,
  });
  const overlapping = await runExpiryOnce({
    config: { methods: ['card'], dryRun: false, limit: 1 },
    expire: async () => { throw new Error('must not run concurrently'); },
    logger: quietLogger,
  });
  assert.equal(overlapping.skipped, true);
  release();
  await slow;

  const failed = await runExpiryOnce({
    config: { methods: ['card'], dryRun: false, limit: 1 },
    expire: async () => { throw new Error('boom'); },
    logger: { info() {}, warn() {} },
  });
  assert.equal(failed.error, true);
  const afterFailure = await runExpiryOnce({
    config: { methods: ['card'], dryRun: false, limit: 1 },
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

test('R10: both expiry CLIs refuse production apply before database setup', () => {
  const { spawnSync } = require('node:child_process');
  for (const script of ['expire-inventory-reservations.js', 'expire-pending-orders.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), '--apply'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', INVENTORY_EXPIRY_CLI_ALLOW_PRODUCTION: 'false' },
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--apply in production requires INVENTORY_EXPIRY_CLI_ALLOW_PRODUCTION=true/);
  }
});

test('R10: expiry methods default to none and malformed lists fail closed', (t) => {
  const original = process.env.INVENTORY_EXPIRY_METHODS;
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    delete process.env.INVENTORY_EXPIRY_METHODS;
    assert.deepEqual(inventoryExpiryMethods(), []);
    for (const [value, expected] of [
      ['', []], ['  ', []], ['none', []], ['iban', ['iban']], ['card', ['card']],
      ['iban,card', ['iban', 'card']], [' IBAN , card ', ['iban', 'card']],
      ['card,iban,card', ['iban', 'card']],
    ]) assert.deepEqual(inventoryExpiryMethods(value), expected);
    assert.equal(warn.mock.callCount(), 0);
    const invalid = ['iban,secret', 'none,card', 'none,none', 'iban,', ',card', 'iban,,card',
      'iban '.repeat(30), null, ['card']];
    for (const value of invalid) assert.deepEqual(inventoryExpiryMethods(value), []);
    assert.equal(warn.mock.callCount(), invalid.length);
    for (const call of warn.mock.calls) {
      assert.deepEqual(call.arguments, [
        'Invalid INVENTORY_EXPIRY_METHODS configuration. Expiry is disabled for all methods.',
      ]);
    }
  } finally {
    if (original === undefined) delete process.env.INVENTORY_EXPIRY_METHODS;
    else process.env.INVENTORY_EXPIRY_METHODS = original;
  }
});

test('R10: health and metrics expose effective methods and worker mode', () => {
  const enabled = { INVENTORY_EXPIRY_WORKER_ENABLED: 'true' };
  const row = { last_succeeded_at: new Date(), processed_count: 3 };
  for (const [env, mode, status] of [
    [{}, 'disabled', 'disabled'],
    [{ ...enabled, INVENTORY_EXPIRY_DRY_RUN: 'true' }, 'dry_run', 'dry_run'],
    [enabled, 'no_methods', 'no_methods'],
    [{ ...enabled, INVENTORY_EXPIRY_METHODS: 'iban' }, 'write', 'healthy'],
  ]) {
    const config = workerConfig(env);
    assert.equal(workerMode(config), mode);
    const snapshot = inventoryWorkerHealthSnapshot(row, { config });
    assert.equal(snapshot.status, status);
    assert.equal(snapshot.healthy, mode === 'write');
    assert.equal(snapshot.heartbeatStatus, 'healthy');
    assert.equal(snapshot.processedCount, 3);
    assert.deepEqual(snapshot.methods, config.methods);
    const metrics = inventoryWorkerPrometheus(snapshot);
    assert.ok(metrics.includes('{mode="' + mode + '"} 1'));
    assert.ok(metrics.includes('{method="iban"} ' + Number(mode === 'write')));
  }
});

test('R10: an enabled write tick with no methods never calls the writer', async () => {
  const config = workerConfig({ INVENTORY_EXPIRY_WORKER_ENABLED: 'true' });
  assert.deepEqual(await runExpiryOnce({ config, expire: assert.fail, count: assert.fail }), {
    expired: 0, skipped: {}, methods: [], byMethod: {},
  });
});
