const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const {
  MAX_UPLOAD_BYTES,
  detectImageFormat,
  prepareImage,
  validateUploadEnvelope,
} = require('../services/mediaPipeline');
const { assertObjectKey, assertSameTenantKeys, createMemoryStorage } = require('../services/objectStorage');
const {
  responsiveMediaUrls,
  extractMediaAssetId,
  uploadPreparedAsset,
  deleteObjectsBestEffort,
  queueAssetDeletion,
} = require('../services/mediaAssets');
const { replaceImageEntry } = require('../scripts/backfill-media-assets');

const organizationId = '11111111-1111-4111-8111-111111111111';

async function imageFile({ width = 1200, height = 800, format = 'jpeg', orientation = null } = {}) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#c8a77b' } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  const buffer = format === 'png' ? await pipeline.png().toBuffer() : await pipeline.jpeg().toBuffer();
  return {
    buffer,
    mimetype: format === 'png' ? 'image/png' : 'image/jpeg',
    originalname: format === 'png' ? 'sample.png' : 'sample.jpg',
  };
}

function fakeClient({ failVariantInsert = false, queueResponses = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (failVariantInsert && /insert into media_variants/i.test(sql)) throw new Error('simulated db failure');
      if (queueResponses.length) return queueResponses.shift();
      return { rows: [] };
    },
  };
}

test('magic bytes reject a fake MIME payload', async () => {
  const file = { buffer: Buffer.from('not a jpeg payload'), mimetype: 'image/jpeg', originalname: 'fake.jpg' };
  assert.equal(detectImageFormat(file.buffer), null);
  assert.throws(() => validateUploadEnvelope(file), /icerigi/);
});

test('corrupt image is rejected after magic-byte validation', async () => {
  const file = { buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)]), mimetype: 'image/jpeg', originalname: 'broken.jpg' };
  await assert.rejects(() => prepareImage(file, organizationId), /bozuk/);
});

test('oversized upload envelope is rejected before decode', () => {
  const buffer = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
  buffer.set([0xff, 0xd8, 0xff], 0);
  assert.throws(
    () => validateUploadEnvelope({ buffer, mimetype: 'image/jpeg', originalname: 'large.jpg' }),
    /dosya boyutu/
  );
});

test('pixel-bomb dimensions are rejected', async () => {
  const file = await imageFile({ width: 8001, height: 1 });
  await assert.rejects(() => prepareImage(file, organizationId), /piksel boyutu/);
});

test('EXIF orientation is normalized and metadata-free WebP variants are produced', async () => {
  const file = await imageFile({ width: 40, height: 20, orientation: 6 });
  const prepared = await prepareImage(file, organizationId);
  assert.deepEqual(prepared.variants.map((variant) => variant.name), ['thumbnail', 'card', 'detail']);
  for (const variant of prepared.variants) {
    assert.equal(variant.contentType, 'image/webp');
    assert.equal(variant.width, 20);
    assert.equal(variant.height, 40);
    const metadata = await sharp(variant.data).metadata();
    assert.equal(metadata.orientation, undefined);
  }
});

test('object keys are tenant-namespaced and reject cross-tenant access', async () => {
  const prepared = await prepareImage(await imageFile(), organizationId);
  assert.doesNotThrow(() => assertObjectKey(prepared.variants[0].objectKey, organizationId));
  assert.throws(
    () => assertObjectKey(prepared.variants[0].objectKey, '22222222-2222-4222-8222-222222222222'),
    /tenant disi/
  );
  assert.throws(
    () => assertSameTenantKeys(
      prepared.variants[0].objectKey,
      prepared.variants[0].objectKey.replace(organizationId, '22222222-2222-4222-8222-222222222222')
    ),
    /Tenantlar arasi/
  );
});

test('partial storage failure exposes uploaded keys for cleanup', async () => {
  const prepared = await prepareImage(await imageFile(), organizationId);
  const storage = createMemoryStorage({ failPutAt: 2 });
  const client = fakeClient();
  let error;
  try {
    await uploadPreparedAsset(client, { organizationId, prepared, storage });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.uploadedObjects.length, 1);
  const failed = await deleteObjectsBestEffort(storage, error.uploadedObjects);
  assert.deepEqual(failed, []);
  assert.equal(storage.objects.size, 0);
});

test('DB failure after an object upload can be cleaned without a binary DB write', async () => {
  const prepared = await prepareImage(await imageFile(), organizationId);
  const storage = createMemoryStorage();
  const client = fakeClient({ failVariantInsert: true });
  await assert.rejects(async () => {
    try {
      await uploadPreparedAsset(client, { organizationId, prepared, storage });
    } catch (error) {
      assert.ok(error.uploadedObjects.length > 0);
      await deleteObjectsBestEffort(storage, error.uploadedObjects);
      throw error;
    }
  }, /simulated db failure/);
  assert.equal(storage.objects.size, 0);
  const pendingInsert = client.queries.find((sql) => /insert into upload_assets/i.test(sql));
  assert.match(pendingInsert, /data,/i);
  assert.match(pendingInsert, /null,/i);
});

test('used asset deletion is refused', async () => {
  const client = fakeClient({
    queueResponses: [
      { rows: [{ id: randomUUID(), status: 'ready' }] },
      { rows: [{ count: 2 }] },
    ],
  });
  const result = await queueAssetDeletion(client, { organizationId, assetId: randomUUID() });
  assert.deepEqual(result, { outcome: 'in_use', references: 2 });
  assert.equal(client.queries.some((sql) => /media_cleanup_jobs/i.test(sql)), false);
});

test('responsive URLs are deterministic and legacy backfill keeps color binding', () => {
  const assetId = randomUUID();
  const urls = responsiveMediaUrls(assetId);
  assert.equal(extractMediaAssetId(urls.card), assetId);
  assert.match(urls.thumbnail, /\/thumbnail$/);
  assert.match(urls.card, /\/card$/);
  assert.match(urls.detail, /\/detail$/);
  assert.equal(replaceImageEntry('#111 | /uploads/old.webp', '/uploads/old.webp', urls.detail), `#111 | ${urls.detail}`);
});
