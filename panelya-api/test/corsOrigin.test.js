const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const cors = require('cors');

const { corsOptions } = require('../middleware/security');

async function withEnv(values, fn) {
  const previous = {};
  for (const name of Object.keys(values)) {
    previous[name] = process.env[name];
    if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
  }
  try { return await fn(); } finally {
    for (const name of Object.keys(values)) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
}

function decide(origin) {
  return new Promise((resolve) => {
    corsOptions().origin(origin, (error, allowed) => resolve({ error, allowed }));
  });
}

test('listed origins and requests without an Origin are allowed', async () => {
  await withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://shop.example.test, https://admin.example.test' }, async () => {
    assert.equal((await decide('https://shop.example.test')).allowed, true);
    assert.equal((await decide('https://admin.example.test')).allowed, true);
    assert.equal((await decide(undefined)).allowed, true);
  });
});

test('an unlisted origin is refused with a stable 403, never a generic 500', async () => {
  await withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://shop.example.test' }, async () => {
    for (const origin of [
      'https://evil.example', 'https://shop.example.test.evil.example', 'http://shop.example.test',
      'https://deployment-abc.vercel.app', 'null',
    ]) {
      const { error, allowed } = await decide(origin);
      assert.equal(allowed, false, origin);
      assert.equal(error.status, 403, origin);
      assert.equal(error.code, 'CORS_ORIGIN_DENIED', origin);
    }
  });
});

test('production still requires an explicit allow-list and never widens to *', async () => {
  await withEnv({ NODE_ENV: 'production', CORS_ORIGIN: '' }, () => {
    assert.throws(() => corsOptions(), /CORS_ORIGIN/);
  });
  await withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://shop.example.test' }, () => {
    const options = corsOptions();
    assert.equal(options.credentials, true);
    assert.notEqual(options.origin, '*');
  });
});

test('preview *.vercel.app origins are accepted outside production only', async () => {
  await withEnv({ NODE_ENV: 'development', CORS_ORIGIN: 'https://shop.example.test' }, async () => {
    assert.equal((await decide('https://my-preview-1.vercel.app')).allowed, true);
    assert.equal((await decide('https://evil.example')).error.status, 403);
  });
  await withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://shop.example.test' }, async () => {
    assert.equal((await decide('https://my-preview-1.vercel.app')).error.status, 403);
  });
});

test('over HTTP a denied origin gets 403 with a safe body, an allowed one succeeds', async () => {
  await withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://shop.example.test' }, async () => {
    const { safeErrorMessage } = require('../middleware/security');
    const app = express();
    app.use(cors(corsOptions()));
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    // Same shape as the global handler in server.js.
    app.use((err, _req, res, _next) => {
      const status = err.status || 500;
      res.status(status).json({
        error: safeErrorMessage ? safeErrorMessage(err) : err.message,
        ...(typeof err.code === 'string' ? { code: err.code } : {}),
      });
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const denied = await fetch(`${base}/ping`, { headers: { origin: 'https://evil.example' } });
      assert.equal(denied.status, 403);
      const body = await denied.json();
      assert.equal(body.code, 'CORS_ORIGIN_DENIED');
      assert.doesNotMatch(JSON.stringify(body), /stack|evil\.example/);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
      const allowed = await fetch(`${base}/ping`, { headers: { origin: 'https://shop.example.test' } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://shop.example.test');
      const none = await fetch(`${base}/ping`);
      assert.equal(none.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
