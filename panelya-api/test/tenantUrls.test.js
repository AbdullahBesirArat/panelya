'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireRole } = require('../middleware/auth');
const {
  normalizeStorefrontUrl,
  resolveStorefrontBaseUrl,
} = require('../services/tenantUrls');

function clientFor({ hostname = null, storefrontUrl = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('from custom_domains')) return { rows: hostname ? [{ hostname }] : [] };
      if (sql.includes('from organizations')) {
        return { rows: [{ storefront_url: storefrontUrl }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test('active canonical custom domain wins over the tenant storefront URL', async () => {
  const client = clientFor({ hostname: 'shop.example.com', storefrontUrl: 'https://tenant.vercel.app' });
  const result = await resolveStorefrontBaseUrl(client, 'tenant-a', { environment: 'production' });
  assert.deepEqual(result, { baseUrl: 'https://shop.example.com', source: 'custom_domain' });
  assert.equal(client.calls.some((call) => call.sql.includes('from organizations')), false);
});

test('tenant storefront URL is used when no active canonical domain exists', async () => {
  const client = clientFor({ storefrontUrl: 'https://suvera-web.vercel.app/' });
  const result = await resolveStorefrontBaseUrl(client, 'tenant-suvera', { environment: 'production' });
  assert.deepEqual(result, { baseUrl: 'https://suvera-web.vercel.app', source: 'storefront_url' });
  assert.deepEqual(client.calls.map((call) => call.params), [['tenant-suvera'], ['tenant-suvera']]);
});

test('inactive or broken custom-domain lookup falls back only to the same tenant URL', async () => {
  const calls = [];
  const client = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('from custom_domains')) throw new Error('domain lookup unavailable');
      return { rows: [{ storefront_url: 'https://tenant-a.vercel.app' }] };
    },
  };
  const result = await resolveStorefrontBaseUrl(client, 'tenant-a', { environment: 'production' });
  assert.deepEqual(result, { baseUrl: 'https://tenant-a.vercel.app', source: 'storefront_url' });
  assert.equal(calls.every((call) => call.params[0] === 'tenant-a'), true, 'tenant B is never queried');
});

test('production storefront URLs reject unsafe origins and normalize a trailing slash', () => {
  assert.equal(
    normalizeStorefrontUrl('https://suvera-web.vercel.app/', { environment: 'production' }),
    'https://suvera-web.vercel.app'
  );
  for (const unsafe of [
    'http://localhost:3001',
    'https://localhost',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/store',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/%2e%2e/',
    'https://example.com/?next=evil',
    'https://single-label',
  ]) {
    assert.throws(
      () => normalizeStorefrontUrl(unsafe, { environment: 'production' }),
      (error) => error.code === 'STOREFRONT_URL_INVALID'
    );
  }
});

test('HTTP is accepted only for a local development origin', () => {
  assert.equal(
    normalizeStorefrontUrl('http://localhost:3001/', { environment: 'development' }),
    'http://localhost:3001'
  );
  assert.throws(
    () => normalizeStorefrontUrl('http://example.com', { environment: 'development' }),
    (error) => error.code === 'STOREFRONT_URL_INVALID'
  );
});

test('production without a trusted tenant origin stays explicitly unconfigured', async () => {
  const client = clientFor();
  const result = await resolveStorefrontBaseUrl(client, 'tenant-a', { environment: 'production' });
  assert.deepEqual(result, { baseUrl: '', source: 'unconfigured' });
});

test('production never leaks the global platform URL into a tenant preview origin', async () => {
  const previous = process.env.PUBLIC_SITE_URL;
  process.env.PUBLIC_SITE_URL = 'https://global-platform.example.com';
  try {
    const result = await resolveStorefrontBaseUrl(clientFor(), 'tenant-a', { environment: 'production' });
    assert.deepEqual(result, { baseUrl: '', source: 'unconfigured' });
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = previous;
  }
});

test('organization storefront settings are owner/admin protected and deny unauthorized roles', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/organizations.js'), 'utf8');
  assert.match(routeSource, /router\.put\('\/current', requireAuth, requireRole\(\['owner', 'admin', 'super_admin'\]\)/);
  const middleware = requireRole(['owner', 'admin', 'super_admin']);
  for (const role of ['owner', 'admin', 'super_admin']) {
    let continued = false;
    middleware({ auth: { role } }, {}, () => { continued = true; });
    assert.equal(continued, true, `${role} may update the tenant setting`);
  }
  for (const role of ['member', 'viewer']) {
    let status = 0;
    middleware({ auth: { role } }, {
      status(code) { status = code; return this; },
      json() {},
    }, () => assert.fail(`${role} must not pass`));
    assert.equal(status, 403);
  }
});
