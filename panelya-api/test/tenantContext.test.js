const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const db = require('../db');

function mockClient() {
  const client = {
    calls: [],
    released: false,
    query(text, params) {
      client.calls.push({ text, params });
      return Promise.resolve({ rows: [] });
    },
    release() { client.released = true; },
  };
  return client;
}

async function withMockedConnect(client, run) {
  const original = db.pool.connect;
  db.pool.connect = async () => client;
  try {
    return await run();
  } finally {
    db.pool.connect = original;
  }
}

test('withTransaction commits on success and always releases the client', async () => {
  const client = mockClient();
  const result = await withMockedConnect(client, () =>
    db.withTransaction(async (c) => { await c.query('SELECT 1'); return 42; }));
  assert.equal(result, 42);
  assert.deepEqual(client.calls.map((c) => c.text), ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.equal(client.released, true);
});

test('withTransaction rolls back and rethrows on error', async () => {
  const client = mockClient();
  await withMockedConnect(client, async () => {
    await assert.rejects(
      () => db.withTransaction(async () => { throw new Error('boom'); }),
      /boom/,
    );
  });
  assert.deepEqual(client.calls.map((c) => c.text), ['BEGIN', 'ROLLBACK']);
  assert.equal(client.released, true);
});

test('withTenantContext sets a transaction-local org id via a bind parameter', async () => {
  const client = mockClient();
  await withMockedConnect(client, () =>
    db.withTenantContext('org-123', async (c) => { await c.query('SELECT * FROM products'); }));

  assert.equal(client.calls[0].text, 'BEGIN');
  const setCfg = client.calls.find((c) => /set_config\(/.test(c.text));
  assert.ok(setCfg, 'set_config is called');
  assert.ok(setCfg.text.includes('$1'), 'org id is a bind parameter, not interpolated');
  assert.ok(/,\s*true\)/.test(setCfg.text), 'is_local => true (transaction-scoped)');
  assert.equal(setCfg.params[0], 'org-123');
  assert.equal(client.calls[client.calls.length - 1].text, 'COMMIT');
  assert.equal(client.released, true);
});

test('withTenantContext rejects a missing organization id', async () => {
  await assert.rejects(() => db.withTenantContext('', async () => {}), /organizationId/);
  await assert.rejects(() => db.withTenantContext(null, async () => {}), /organizationId/);
  await assert.rejects(() => db.withTenantContext(undefined, async () => {}), /organizationId/);
});

test('request context reuses one transaction and commits after a successful response', async () => {
  const client = mockClient();
  const response = new EventEmitter();
  response.statusCode = 200;

  await withMockedConnect(client, () => new Promise((resolve, reject) => {
    db.requestContextMiddleware({ auth: { actorType: 'app', role: 'owner' } }, response, () => {
      void (async () => {
        await db.activateTenantContext('org-request');
        await db.query('SELECT * FROM products');
        response.emit('finish');
        setImmediate(resolve);
      })().catch(reject);
    });
  }));

  assert.deepEqual(client.calls.map((call) => call.text), [
    'begin',
    "select set_config('app.current_organization_id', $1, true)",
    'SELECT * FROM products',
    'commit',
  ]);
  assert.equal(client.released, true);
});

test('request context rolls back on an error response and refuses tenant switching', async () => {
  const client = mockClient();
  const response = new EventEmitter();
  response.statusCode = 403;

  await withMockedConnect(client, () => new Promise((resolve, reject) => {
    db.requestContextMiddleware({ auth: { actorType: 'app', role: 'owner' } }, response, () => {
      void (async () => {
        await db.activateTenantContext('org-a');
        await assert.rejects(db.activateTenantContext('org-b'), /degistirilemez/);
        response.emit('finish');
        setImmediate(resolve);
      })().catch(reject);
    });
  }));

  assert.equal(client.calls.at(-1).text, 'rollback');
  assert.equal(client.released, true);
});
