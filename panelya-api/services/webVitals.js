'use strict';

const METRIC_RANGES = Object.freeze({
  LCP: [0, 120000],
  CLS: [0, 10],
  INP: [0, 60000],
  TTFB: [0, 120000],
});
const ROUTES = new Set([
  'anasayfa', 'urunler', 'urun', 'sepet', 'giris', 'siparis', 'sifre-sifirla',
  'siparis-takip', 'tesekkur', 'hakkimizda', 'iade', 'iletisim', 'kargo', 'kvkk',
  'sozlesme', 'uyelik-sozlesmesi', 'favoriler', 'hesabim', 'blog-detay', 'blog',
  'arama', 'dogrula', 'tercihler', 'karsilastir', 'suvera',
]);
const NAVIGATION_TYPES = new Set(['navigate', 'reload', 'back_forward', 'prerender', 'unknown']);
const stats = new Map();

function normalizeRumRoute(value) {
  const path = String(value || '').split('?')[0].split('#')[0];
  const first = path.replace(/^\/+|\/+$/g, '').split('/')[0].replace(/\.html$/i, '');
  if (!first || first === 'index') return '/anasayfa';
  return ROUTES.has(first) ? `/${first}` : '/diger';
}

function validationError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_WEB_VITAL' });
}

function validateWebVitalPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Metric payload gecersiz');
  const keys = Object.keys(body);
  if (keys.some((key) => !['name', 'value', 'route', 'navigationType', 'build'].includes(key))) {
    throw validationError('Metric alani gecersiz');
  }
  const name = String(body.name || '').toUpperCase();
  const range = METRIC_RANGES[name];
  const value = Number(body.value);
  if (!range || !Number.isFinite(value) || value < range[0] || value > range[1]) {
    throw validationError('Metric degeri gecersiz');
  }
  const navigationType = NAVIGATION_TYPES.has(body.navigationType) ? body.navigationType : 'unknown';
  const build = /^[a-z0-9._-]{1,32}$/i.test(String(body.build || '')) ? String(body.build) : 'unknown';
  return {
    name,
    value: Math.round(value * 1000) / 1000,
    route: normalizeRumRoute(body.route),
    navigationType,
    build,
  };
}

function recordWebVital(metric) {
  const key = `${metric.name}|${metric.route}|${metric.navigationType}`;
  const current = stats.get(key) || { count: 0, sum: 0, max: 0 };
  current.count += 1;
  current.sum += metric.value;
  current.max = Math.max(current.max, metric.value);
  stats.set(key, current);
}

function webVitalsPrometheus() {
  const lines = [
    '# HELP panelya_web_vital_total Privacy-safe storefront Web Vital samples.',
    '# TYPE panelya_web_vital_total counter',
  ];
  for (const [key, value] of stats.entries()) {
    const [name, route, navigationType] = key.split('|');
    const labels = `name="${name}",route="${route}",navigation_type="${navigationType}"`;
    lines.push(`panelya_web_vital_total{${labels}} ${value.count}`);
    lines.push(`panelya_web_vital_value_sum{${labels}} ${Math.round(value.sum * 1000) / 1000}`);
    lines.push(`panelya_web_vital_value_max{${labels}} ${Math.round(value.max * 1000) / 1000}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  METRIC_RANGES,
  normalizeRumRoute,
  recordWebVital,
  validateWebVitalPayload,
  webVitalsPrometheus,
};
