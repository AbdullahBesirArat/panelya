const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inventoryWorkerHealthSnapshot,
  inventoryWorkerPrometheus,
  resolveMetricsAccess,
  normalizeRoutePath,
  safeEqual,
} = require('../services/metrics');

test('production without METRICS_TOKEN is not publicly readable (404/not_found)', () => {
  assert.equal(
    resolveMetricsAccess({ env: 'production', configuredToken: '', authorizationHeader: '' }),
    'not_found',
  );
  assert.equal(
    resolveMetricsAccess({ env: 'production', configuredToken: undefined }),
    'not_found',
  );
});

test('non-production without token stays open for local development', () => {
  assert.equal(
    resolveMetricsAccess({ env: 'development', configuredToken: '' }),
    'ok',
  );
  assert.equal(
    resolveMetricsAccess({ env: undefined, configuredToken: '' }),
    'ok',
  );
});

test('configured token requires a matching bearer credential', () => {
  const configuredToken = 'super-secret-token';
  assert.equal(
    resolveMetricsAccess({ env: 'production', configuredToken, authorizationHeader: `Bearer ${configuredToken}` }),
    'ok',
  );
  assert.equal(
    resolveMetricsAccess({ env: 'production', configuredToken, authorizationHeader: 'Bearer wrong' }),
    'unauthorized',
  );
  assert.equal(
    resolveMetricsAccess({ env: 'production', configuredToken, authorizationHeader: '' }),
    'unauthorized',
  );
  // Even in development a configured token is enforced.
  assert.equal(
    resolveMetricsAccess({ env: 'development', configuredToken, authorizationHeader: 'Bearer wrong' }),
    'unauthorized',
  );
});

test('bearer parsing is case-insensitive on the scheme and trims the token', () => {
  const configuredToken = 'abc123';
  assert.equal(
    resolveMetricsAccess({ env: 'production', configuredToken, authorizationHeader: 'bearer   abc123  ' }),
    'ok',
  );
});

test('safeEqual is constant-time-safe and correct for equal/unequal/length-mismatch', () => {
  assert.equal(safeEqual('token', 'token'), true);
  assert.equal(safeEqual('token', 'tokeX'), false);
  assert.equal(safeEqual('short', 'muchlonger'), false);
  assert.equal(safeEqual('', ''), true);
});

test('normalizeRoutePath collapses dynamic ids to bound label cardinality', () => {
  assert.equal(normalizeRoutePath('/api/products/12345'), '/api/products/:id');
  assert.equal(normalizeRoutePath('/api/orders/42/items/7'), '/api/orders/:id/items/:id');
  assert.equal(
    normalizeRoutePath('/api/media/1f2e3d4c-5b6a-7089-90ab-cdef01234567'),
    '/api/media/:uuid',
  );
  assert.equal(normalizeRoutePath('/api/products?q=abc'), '/api/products');
  assert.equal(normalizeRoutePath('/api/health'), '/api/health');
});

test('inventory worker health becomes stale or failed deterministically', () => {
  const now = Date.parse('2026-08-02T12:00:00.000Z');
  const healthy = inventoryWorkerHealthSnapshot({
    last_started_at: '2026-08-02T11:59:00.000Z',
    last_succeeded_at: '2026-08-02T11:59:10.000Z',
    last_failed_at: null,
    processed_count: 3,
  }, { now, staleMinutes: 10 });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.healthy, true);
  assert.match(inventoryWorkerPrometheus(healthy), /worker_healthy 1/);

  const stale = inventoryWorkerHealthSnapshot({
    last_succeeded_at: '2026-08-02T11:40:00.000Z',
  }, { now, staleMinutes: 10 });
  assert.equal(stale.status, 'stale');

  const failed = inventoryWorkerHealthSnapshot({
    last_succeeded_at: '2026-08-02T11:59:00.000Z',
    last_failed_at: '2026-08-02T11:59:30.000Z',
  }, { now, staleMinutes: 10 });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.healthy, false);
});
