const crypto = require('crypto');

const startedAt = new Date();
const counters = {
  requestsTotal: 0,
  errorsTotal: 0,
};
const routeStats = new Map();
const MAX_ROUTE_STATS = 200;

function isProductionEnv(env) {
  return String(env || '').toLowerCase() === 'production';
}

// Constant-time string comparison that also tolerates length mismatches without
// leaking timing information about the configured token.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Decide whether a /metrics request may read the endpoint.
// Returns 'ok' | 'unauthorized' | 'not_found'.
// - No token configured + production -> 'not_found' (never publicly readable).
// - No token configured + non-production -> 'ok' (local development convenience).
// - Token configured -> constant-time bearer match required.
function resolveMetricsAccess({ env, configuredToken, authorizationHeader } = {}) {
  const token = String(configuredToken || '').trim();
  if (!token) {
    return isProductionEnv(env) ? 'not_found' : 'ok';
  }
  const header = String(authorizationHeader || '');
  const supplied = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
  if (!supplied || !safeEqual(supplied, token)) {
    return 'unauthorized';
  }
  return 'ok';
}

// Collapse dynamic segments (numeric ids, UUIDs) so unmatched/404 paths cannot
// explode metric label cardinality.
function normalizeRoutePath(rawPath) {
  return String(rawPath || 'unknown')
    .split('?')[0]
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}(?=\/|$)/g, '/:uuid');
}

function routeKey(req, statusCode) {
  const method = String(req.method || 'GET').toUpperCase();
  const routePath = req.route?.path
    ? `${req.baseUrl || ''}${req.route.path}`
    : normalizeRoutePath(req.path || req.url || 'unknown');
  return `${method} ${routePath} ${statusCode}`;
}

function observeRequest(req, res, durationMs) {
  counters.requestsTotal += 1;
  if (res.statusCode >= 500) counters.errorsTotal += 1;

  const key = routeKey(req, res.statusCode);
  const current = routeStats.get(key) || {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };

  current.count += 1;
  current.totalDurationMs += durationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
  routeStats.set(key, current);

  if (routeStats.size > MAX_ROUTE_STATS) {
    const oldestKey = routeStats.keys().next().value;
    routeStats.delete(oldestKey);
  }
}

function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    observeRequest(req, res, durationMs);
  });
  next();
}

function prometheusMetrics() {
  const lines = [
    '# HELP panelya_uptime_seconds Process uptime in seconds.',
    '# TYPE panelya_uptime_seconds gauge',
    `panelya_uptime_seconds ${Math.round((Date.now() - startedAt.getTime()) / 1000)}`,
    '# HELP panelya_requests_total Total HTTP requests observed by the API process.',
    '# TYPE panelya_requests_total counter',
    `panelya_requests_total ${counters.requestsTotal}`,
    '# HELP panelya_errors_total Total HTTP 5xx responses observed by the API process.',
    '# TYPE panelya_errors_total counter',
    `panelya_errors_total ${counters.errorsTotal}`,
    '# HELP panelya_route_requests_total Requests grouped by method, route and status.',
    '# TYPE panelya_route_requests_total counter',
  ];

  for (const [key, stat] of routeStats.entries()) {
    const [method, ...rest] = key.split(' ');
    const status = rest.pop();
    const route = rest.join(' ');
    const labels = `method="${method}",route="${route.replace(/"/g, '\\"')}",status="${status}"`;
    lines.push(`panelya_route_requests_total{${labels}} ${stat.count}`);
    lines.push(`panelya_route_duration_ms_sum{${labels}} ${Math.round(stat.totalDurationMs)}`);
    lines.push(`panelya_route_duration_ms_max{${labels}} ${Math.round(stat.maxDurationMs)}`);
  }

  return `${lines.join('\n')}\n`;
}

function inventoryWorkerHealthSnapshot(row, {
  now = Date.now(),
  staleMinutes = Number(process.env.INVENTORY_RESERVATION_WORKER_STALE_MINUTES || 10),
} = {}) {
  if (!row) {
    return {
      status: 'never_run',
      healthy: false,
      lastStartedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      processedCount: 0,
    };
  }
  const lastSucceededAt = row.last_succeeded_at ? new Date(row.last_succeeded_at) : null;
  const lastFailedAt = row.last_failed_at ? new Date(row.last_failed_at) : null;
  const staleAfterMs = Math.max(Number(staleMinutes) || 10, 1) * 60 * 1000;
  const failed = lastFailedAt && (!lastSucceededAt || lastFailedAt > lastSucceededAt);
  const stale = !lastSucceededAt || now - lastSucceededAt.getTime() > staleAfterMs;
  return {
    status: failed ? 'failed' : stale ? 'stale' : 'healthy',
    healthy: !failed && !stale,
    lastStartedAt: row.last_started_at || null,
    lastSucceededAt: row.last_succeeded_at || null,
    lastFailedAt: row.last_failed_at || null,
    processedCount: Number(row.processed_count || 0),
  };
}

function inventoryWorkerPrometheus(snapshot) {
  const successSeconds = snapshot?.lastSucceededAt
    ? Math.floor(new Date(snapshot.lastSucceededAt).getTime() / 1000)
    : 0;
  return [
    '# HELP panelya_inventory_reservation_worker_healthy Whether the reservation expiry worker is recent and error-free.',
    '# TYPE panelya_inventory_reservation_worker_healthy gauge',
    `panelya_inventory_reservation_worker_healthy ${snapshot?.healthy ? 1 : 0}`,
    '# HELP panelya_inventory_reservation_worker_last_success_unixtime Last successful reservation expiry run.',
    '# TYPE panelya_inventory_reservation_worker_last_success_unixtime gauge',
    `panelya_inventory_reservation_worker_last_success_unixtime ${successSeconds}`,
    '# HELP panelya_inventory_reservation_worker_processed_count Reservations processed in the last successful run.',
    '# TYPE panelya_inventory_reservation_worker_processed_count gauge',
    `panelya_inventory_reservation_worker_processed_count ${Number(snapshot?.processedCount || 0)}`,
  ].join('\n');
}

module.exports = {
  inventoryWorkerHealthSnapshot,
  inventoryWorkerPrometheus,
  metricsMiddleware,
  prometheusMetrics,
  resolveMetricsAccess,
  normalizeRoutePath,
  safeEqual,
};
