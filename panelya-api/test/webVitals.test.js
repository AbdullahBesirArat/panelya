'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRumRoute,
  recordWebVital,
  validateWebVitalPayload,
  webVitalsPrometheus,
} = require('../services/webVitals');

test('Web Vitals accepts only LCP, CLS, INP and TTFB in sane finite ranges', () => {
  for (const [name, value] of [['LCP', 2500], ['CLS', 0.12], ['INP', 180], ['TTFB', 95]]) {
    assert.equal(validateWebVitalPayload({ name, value, route: '/urun', navigationType: 'navigate', build: 'a32' }).name, name);
  }
  assert.throws(() => validateWebVitalPayload({ name: 'FID', value: 20 }), /Metric degeri/);
  assert.throws(() => validateWebVitalPayload({ name: 'CLS', value: Number.NaN }), /Metric degeri/);
  assert.throws(() => validateWebVitalPayload({ name: 'CLS', value: 99 }), /Metric degeri/);
  assert.throws(() => validateWebVitalPayload({ name: 'LCP', value: 10, email: 'private@example.com' }), /Metric alani/);
});

test('RUM route and labels are bounded and never retain ids, query strings or domains', () => {
  assert.equal(normalizeRumRoute('/urun/928?token=secret'), '/urun');
  assert.equal(normalizeRumRoute('/unknown/order/123?email=a@b.test'), '/diger');
  const metric = validateWebVitalPayload({
    name: 'LCP', value: 1234, route: '/urun/928?customer=42', navigationType: 'invented', build: 'bad build value',
  });
  assert.deepEqual(metric, { name: 'LCP', value: 1234, route: '/urun', navigationType: 'unknown', build: 'unknown' });
  assert.doesNotMatch(JSON.stringify(metric), /928|customer|bad build/);
});

test('Web Vitals aggregation exposes bounded metric/route/navigation labels only', () => {
  const metric = validateWebVitalPayload({ name: 'INP', value: 200, route: '/sepet', navigationType: 'reload', build: 'a32' });
  recordWebVital(metric);
  const output = webVitalsPrometheus();
  assert.match(output, /name="INP",route="\/sepet",navigation_type="reload"/);
  assert.doesNotMatch(output, /build=|tenant|domain|customer/);
});
