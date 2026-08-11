'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RUNTIME_TIMEOUTS,
  boundedNumber,
  poolOptions,
  queryLabel,
} = require('../db');
const { boundedInteger, REQUEST_TIMEOUT_MS } = require('../middleware/requestTimeout');

test('runtime DB pool is bounded and applies statement/query/idle transaction timeouts', () => {
  const low = poolOptions('postgres://example', -50);
  const high = poolOptions('postgres://example', 999);
  assert.equal(low.max, 1);
  assert.equal(high.max, 40);
  assert.ok(low.statement_timeout >= 100 && low.statement_timeout <= 120000);
  assert.ok(low.query_timeout >= 100 && low.query_timeout <= 125000);
  assert.ok(low.idle_in_transaction_session_timeout >= 1000 && low.idle_in_transaction_session_timeout <= 120000);
  assert.deepEqual({
    statement_timeout: low.statement_timeout,
    query_timeout: low.query_timeout,
    idle_in_transaction_session_timeout: low.idle_in_transaction_session_timeout,
  }, RUNTIME_TIMEOUTS);
});

test('migration pool options do not inherit runtime statement timeouts', () => {
  const options = poolOptions('postgres://example', 2, { runtime: false, defaultMax: 2 });
  assert.equal(options.max, 2);
  assert.equal('statement_timeout' in options, false);
  assert.equal('idle_in_transaction_session_timeout' in options, false);
});

test('invalid timeout overrides use safe defaults and request timeout stays bounded', () => {
  assert.equal(boundedNumber('not-a-number', 250, 25, 60000), 250);
  assert.equal(boundedInteger('invalid', 30000, 1000, 120000), 30000);
  assert.ok(REQUEST_TIMEOUT_MS >= 1000 && REQUEST_TIMEOUT_MS <= 120000);
});

test('slow query label never contains SQL literal or parameter material', () => {
  const label = queryLabel("select * from customer_accounts where email = 'private@example.com' and token = 'secret'");
  assert.equal(label, 'select:customer_accounts');
  assert.doesNotMatch(label, /private|secret|token|@/);
  assert.equal(queryLabel({ name: 'catalog.search', text: 'select secret' }), 'catalog.search');
});
