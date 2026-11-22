const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const express = require('express');
const { createMediaRouter } = require('../routes/media');
const { classifyStorageError } = require('../services/objectStorage');

const assetId = 'aabbccdd-1234-4234-8234-123456789abc';
const requestId = 'media-test';
const bucket = 'private-test-bucket';
const objectKey = 'private/object.webp';
const unavailable = 'Gorsel depolama servisi kullanilamiyor';
const notFound = 'Gorsel bulunamadi';
const storageUnavailable = { error: unavailable, code: 'MEDIA_STORAGE_UNAVAILABLE', requestId };

test('classifyStorageError classifies storage failures', () => {
  const withStatus = httpStatusCode => ({ $metadata: { httpStatusCode } });
  const classifications = [
    ['not_found', { status: 404 }],
    ['not_found', withStatus(404)],
    ['auth', withStatus(403)],
    ['config', { name: 'AuthorizationHeaderMalformed', ...withStatus(400) }],
    ['config', { name: 'PermanentRedirect', ...withStatus(301) }],
    ['config', { Code: 'InvalidBucketName' }],
    ['config', { code: 'NoSuchBucket', ...withStatus(404) }],
    ['config', withStatus(301)],
    ['config', withStatus(307)],
    ['network', { code: 'ENOTFOUND' }],
    ['upstream', withStatus(503)],
    ['unknown', { status: '404' }],
  ];
  for (const [kind, error] of classifications) {
    assert.equal(classifyStorageError(error), kind, JSON.stringify(error));
  }
});

const cases = [
  { label: 'GET signature mismatch', fields: { name: 'SignatureDoesNotMatch' }, httpStatus: 403, kind: 'auth', status: 503 },
  { label: 'HEAD bodyless forbidden', method: 'HEAD', fields: { name: 'Unknown' }, httpStatus: 403, kind: 'auth', status: 503 },
  { label: 'missing GET object', fields: { Code: 'NoSuchKey' }, kind: 'not_found', status: 404, json: { error: notFound, requestId } },
  { label: 'missing GET object in memory storage', fields: { status: 404 }, kind: 'not_found', status: 404, json: { error: notFound, requestId } },
  { label: 'malformed storage authorization', fields: { name: 'AuthorizationHeaderMalformed' }, httpStatus: 400, kind: 'config', status: 503 },
  { label: 'permanent storage redirect', fields: { name: 'PermanentRedirect' }, httpStatus: 301, kind: 'config', status: 503 },
  { label: 'DNS failure', fields: { code: 'ENOTFOUND' }, kind: 'network', status: 503 },
  { label: 'upstream outage', httpStatus: 503, kind: 'upstream', status: 503 },
  { label: 'unknown storage failure', fields: { status: 418 }, kind: 'unknown', status: 500, json: { error: 'Bir hata olustu, lutfen daha sonra tekrar deneyin', requestId } },
  { label: 'successful GET', status: 200, cacheable: true, body: 'img' },
  { label: 'successful HEAD', method: 'HEAD', status: 200, cacheable: true },
  { label: 'missing HEAD object', method: 'HEAD', status: 404, exists: false },
  { label: 'public redirect', publicUrl: 'https://example.invalid/image.webp', status: 302, cacheable: true },
  { label: 'bucket mismatch', storedBucket: 'other-bucket', status: 503, json: { error: unavailable, requestId } },
  { label: 'provider mismatch', storedProvider: 'filesystem', status: 503, json: { error: unavailable, requestId } },
];

for (const scenario of cases) {
  test(`media delivery: ${scenario.label}`, async t => {
    const logger = t.mock.method(console, 'error', () => {});
    const app = express();
    const variant = {
      object_key: objectKey,
      storage_provider: scenario.storedProvider ?? 's3',
      bucket_name: scenario.storedBucket ?? bucket,
      content_type: 'image/webp',
      byte_size: 3,
    };
    const error = Object.assign(new Error('storage test error'), scenario.fields, {
      Bucket: bucket,
      Key: objectKey,
      $metadata: { httpStatusCode: scenario.httpStatus, requestId: 's3-test' },
    });
    const calls = [];
    const storage = {
      provider: 's3',
      bucket,
      publicUrl: () => scenario.publicUrl,
      async get() {
        calls.push('get');
        if (scenario.kind) throw error;
        return Buffer.from('img');
      },
      async head() {
        calls.push('head');
        if (scenario.kind) throw error;
        return { exists: scenario.exists ?? true, byteSize: 3 };
      },
    };
    app.use((req, res, next) => {
      req.id = requestId;
      next();
    });
    app.use('/api/media', createMediaRouter({ storage, db: { systemQuery: async () => ({ rows: [variant] }) } }));
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, 'listening');

    const method = scenario.method ?? 'GET';
    const operation = method.toLowerCase();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/media/${assetId}/card`, {
      method,
      redirect: 'manual',
    });
    assert.equal(response.status, scenario.status);
    assert.equal(response.headers.get('cache-control'), scenario.cacheable ? 'public, max-age=31536000, immutable' : 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), scenario.cacheable ? 'nosniff' : null);
    assert.equal(response.headers.get('cross-origin-resource-policy'), scenario.cacheable ? 'cross-origin' : null);
    assert.equal(response.headers.get('access-control-allow-origin'), scenario.cacheable ? '*' : null);
    const body = await response.text();
    if (method === 'HEAD') assert.equal(body, '');
    else if (scenario.status === 503 || scenario.json) assert.deepEqual(JSON.parse(body), scenario.json ?? storageUnavailable);
    else if (scenario.body) assert.equal(body, scenario.body);
    if (scenario.publicUrl) assert.equal(response.headers.get('location'), scenario.publicUrl);
    assert.deepEqual(calls, scenario.publicUrl || scenario.storedBucket || scenario.storedProvider ? [] : [operation]);

    assert.equal(logger.mock.callCount(), scenario.kind ? 1 : 0);
    if (scenario.kind) {
      const { arguments: args } = logger.mock.calls[0];
      const expected = [{
        event: 'media_storage_error',
        requestId,
        operation,
        variant: 'card',
        kind: scenario.kind,
        errorName: error.name,
        httpStatus: scenario.httpStatus,
        s3RequestId: 's3-test',
      }];
      assert.ok(isDeepStrictEqual(args, expected), 'storage log must match the allow-listed fields and values');
    }
  });
}
