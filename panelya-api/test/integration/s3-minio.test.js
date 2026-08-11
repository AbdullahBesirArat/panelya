const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { CreateBucketCommand, S3Client } = require('@aws-sdk/client-s3');
const {
  assertObjectKey,
  createObjectStorage,
} = require('../../services/objectStorage');

const endpoint = process.env.MINIO_TEST_ENDPOINT;
const bucket = process.env.MINIO_TEST_BUCKET;
const accessKeyId = process.env.MINIO_TEST_ACCESS_KEY;
const secretAccessKey = process.env.MINIO_TEST_SECRET_KEY;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  throw new Error('MinIO integration environment is incomplete');
}

const s3Config = {
  region: 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
};

test('real S3-compatible adapter completes MinIO object and signed URL lifecycle', async () => {
  const bootstrap = new S3Client(s3Config);
  await bootstrap.send(new CreateBucketCommand({ Bucket: bucket }));

  const storage = createObjectStorage({
    env: {
      NODE_ENV: 'test',
      OBJECT_STORAGE_PROVIDER: 's3',
      OBJECT_STORAGE_BUCKET: bucket,
      OBJECT_STORAGE_REGION: 'us-east-1',
      OBJECT_STORAGE_ENDPOINT: endpoint,
      OBJECT_STORAGE_ACCESS_KEY_ID: accessKeyId,
      OBJECT_STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
      OBJECT_STORAGE_PUBLIC_BASE_URL: 'https://media.example.test',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    },
  });

  const tenantId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  const prefix = `tenants/${tenantId}/media/${crypto.randomUUID()}`;
  const originalKey = `${prefix}/card.webp`;
  const copyKey = `${prefix}/detail.webp`;
  const signedKey = `${prefix}/thumbnail.webp`;
  const otherTenantKey = `tenants/${otherTenantId}/media/${crypto.randomUUID()}/card.webp`;
  const payload = Buffer.from('panelya-minio-s3-compatible-payload');
  const signedPayload = Buffer.from('signed-upload-payload');
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  const cleanupKeys = [originalKey, copyKey, signedKey];

  assert.equal(storage.provider, 's3');
  assert.equal(storage.bucket, bucket);
  assert.doesNotThrow(() => assertObjectKey(originalKey, tenantId));
  assert.throws(() => assertObjectKey(originalKey, otherTenantId), /tenant disi/);

  try {
    await storage.put({
      objectKey: originalKey,
      body: payload,
      contentType: 'image/webp',
      checksum,
    });

    const originalHead = await storage.head({ objectKey: originalKey });
    assert.equal(originalHead.exists, true);
    assert.equal(originalHead.byteSize, payload.length);
    assert.equal(originalHead.metadata.sha256, checksum);
    assert.deepEqual(await storage.get({ objectKey: originalKey }), payload);

    await storage.copy({ sourceKey: originalKey, destinationKey: copyKey });
    assert.deepEqual(await storage.get({ objectKey: copyKey }), payload);
    await assert.rejects(
      () => storage.copy({ sourceKey: originalKey, destinationKey: otherTenantKey }),
      /Tenantlar arasi/
    );

    const uploadUrl = await storage.getSignedUploadUrl({
      objectKey: signedKey,
      contentType: 'image/webp',
      expiresIn: 60,
    });
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/webp' },
      body: signedPayload,
    });
    assert.equal(uploadResponse.status, 200);
    assert.equal((await storage.head({ objectKey: signedKey })).byteSize, signedPayload.length);

    const deliveryUrl = await storage.getSignedDeliveryUrl({ objectKey: signedKey, expiresIn: 60 });
    const deliveryResponse = await fetch(deliveryUrl);
    assert.equal(deliveryResponse.status, 200);
    assert.deepEqual(Buffer.from(await deliveryResponse.arrayBuffer()), signedPayload);

    assert.equal(
      storage.publicUrl(originalKey),
      `https://media.example.test/${originalKey}`
    );
  } finally {
    await Promise.all(cleanupKeys.map((objectKey) => storage.delete({ objectKey }).catch(() => {})));
    await bootstrap.destroy();
  }

  assert.deepEqual(await storage.head({ objectKey: originalKey }), { exists: false });
  await storage.delete({ objectKey: originalKey });
});
