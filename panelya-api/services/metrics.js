const startedAt = new Date();
const counters = {
  requestsTotal: 0,
  errorsTotal: 0,
};
const routeStats = new Map();
const MAX_ROUTE_STATS = 200;

function routeKey(req, statusCode) {
  const method = String(req.method || 'GET').toUpperCase();
  const routePath = req.route?.path
    ? `${req.baseUrl || ''}${req.route.path}`
    : String(req.path || req.url || 'unknown').split('?')[0];
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

module.exports = {
  metricsMiddleware,
  prometheusMetrics,
};
