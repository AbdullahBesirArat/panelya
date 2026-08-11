require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { resolveUploadDir } = require('../services/uploads');
const { createObjectStorage } = require('../services/objectStorage');
const { prepareImage } = require('../services/mediaPipeline');
const {
  responsiveMediaUrls,
  syncMediaReferences,
  deleteObjectsBestEffort,
  enqueueCleanupObjects,
} = require('../services/mediaAssets');

async function legacyBody(row, uploadDir) {
  if (Buffer.isBuffer(row.data) && row.data.length) return row.data;
  const safeName = path.basename(String(row.filename || ''));
  if (!safeName || safeName !== row.filename) return null;
  try {
    return await fs.promises.readFile(path.join(uploadDir, safeName));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function replaceImageEntry(entry, oldUrl, newUrl) {
  const value = String(entry || '');
  if (value === oldUrl) return newUrl;
  const separator = value.lastIndexOf('|');
  if (separator >= 0 && value.slice(separator + 1).trim() === oldUrl) {
    return `${value.slice(0, separator + 1)} ${newUrl}`;
  }
  return value;
}

async function rewriteLegacyReferences(client, row, newUrl) {
  const scalarTables = [
    ['categories', 'category', 'name'],
    ['collections', 'collection', 'title'],
    ['blog_posts', 'blog_post', 'title'],
    ['slider_items', 'slider_item', 'title'],
  ];
  for (const [table, resourceType, altColumn] of scalarTables) {
    const updated = await client.query(
      `update ${table} set image_url = $1, updated_at = now()
       where organization_id = $2 and image_url = $3
       returning id, ${altColumn} as alt_text`,
      [newUrl, row.organization_id, row.url]
    );
    for (const resource of updated.rows) {
      await syncMediaReferences(client, {
        organizationId: row.organization_id,
        resourceType,
        resourceId: resource.id,
        values: newUrl,
        altText: resource.alt_text,
      });
    }
  }

  const products = await client.query(
    `select id, name, images from products
     where organization_id = $1 and images::text like $2`,
    [row.organization_id, `%${row.url.replace(/[%_\\]/g, '\\$&')}%`]
  );
  for (const product of products.rows) {
    const images = Array.isArray(product.images)
      ? product.images.map((entry) => replaceImageEntry(entry, row.url, newUrl))
      : [];
    await client.query(
      'update products set images = $1::jsonb, updated_at = now() where organization_id = $2 and id = $3',
      [JSON.stringify(images), row.organization_id, product.id]
    );
    await syncMediaReferences(client, {
      organizationId: row.organization_id,
      resourceType: 'product',
      resourceId: product.id,
      fieldName: 'images',
      values: images,
      altText: product.name,
    });
  }
}

async function backfillOne(client, row, { storage, uploadDir }) {
  const body = await legacyBody(row, uploadDir);
  if (!body) return { outcome: 'missing_source' };
  const mimetype = row.mime_type || 'image/webp';
  const filename = row.filename || `${row.id}.webp`;
  const prepared = await prepareImage({ buffer: body, mimetype, originalname: filename }, row.organization_id, { assetId: row.id });
  const uploaded = [];
  try {
    for (const variant of prepared.variants) {
      await storage.put({
        objectKey: variant.objectKey,
        body: variant.data,
        contentType: variant.contentType,
        checksum: variant.checksum,
      });
      uploaded.push(variant.objectKey);
      const verified = await storage.head({ objectKey: variant.objectKey });
      if (!verified.exists || Number(verified.byteSize) !== variant.byteSize) {
        throw new Error(`Backfill object dogrulanamadi: ${variant.name}`);
      }
    }

    const urls = responsiveMediaUrls(row.id);
    await client.query('begin');
    await db.setTenantContext(client, row.organization_id);
    for (const variant of prepared.variants) {
      await client.query(
        `insert into media_variants
         (organization_id, asset_id, variant_name, storage_provider, bucket_name, object_key,
          url, content_type, byte_size, width, height, checksum)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (asset_id, variant_name) do nothing`,
        [row.organization_id, row.id, variant.name, storage.provider, storage.bucket || null,
          variant.objectKey, urls[variant.name], variant.contentType, variant.byteSize,
          variant.width, variant.height, variant.checksum]
      );
    }
    const detail = prepared.variants.find((variant) => variant.name === 'detail');
    await client.query(
      `update upload_assets
       set storage_provider=$1, bucket_name=$2, object_key=$3, original_filename=$4,
           content_type='image/webp', width=$5, height=$6, checksum=$7,
           byte_size=$8, url=$9, status='ready', updated_at=now()
       where organization_id=$10 and id=$11`,
      [storage.provider, storage.bucket || null, detail.objectKey, prepared.originalFilename,
        prepared.sourceWidth, prepared.sourceHeight, prepared.sourceChecksum,
        prepared.variants.reduce((sum, variant) => sum + variant.byteSize, 0), urls.detail,
        row.organization_id, row.id]
    );
    await rewriteLegacyReferences(client, row, urls.detail);
    await client.query('commit');
    return { outcome: 'backfilled', variants: prepared.variants.length };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    const failed = await deleteObjectsBestEffort(storage, uploaded);
    if (failed.length) {
      await enqueueCleanupObjects({
        organizationId: row.organization_id,
        assetId: row.id,
        storage,
        objects: failed,
      }).catch(() => {});
    }
    throw error;
  }
}

async function backfillLegacyAssets({
  execute = false,
  limit = 100,
  pool = db.getSystemPool(),
  storage = createObjectStorage(),
  uploadDir = resolveUploadDir(),
  logger = console,
} = {}) {
  const result = await pool.query(
    `select id, organization_id, url, filename, mime_type, data
     from upload_assets
     where storage_provider = 'legacy'
       and status <> 'deleted'
     order by created_at asc
     limit $1`,
    [Math.max(1, Math.min(1000, Number(limit) || 100))]
  );
  if (!execute) {
    logger.log(`Media backfill dry-run: ${result.rows.length} legacy asset`);
    return { candidates: result.rows.length, backfilled: 0, missing: 0 };
  }
  let backfilled = 0;
  let missing = 0;
  for (const row of result.rows) {
    const client = await pool.connect();
    try {
      const outcome = await backfillOne(client, row, { storage, uploadDir });
      if (outcome.outcome === 'backfilled') backfilled += 1;
      if (outcome.outcome === 'missing_source') missing += 1;
    } finally {
      client.release();
    }
  }
  logger.log(`Media backfill: ${backfilled} dogrulandi, ${missing} kaynak eksik`);
  return { candidates: result.rows.length, backfilled, missing };
}

async function main() {
  const pool = db.getSystemPool();
  try {
    const summary = await backfillLegacyAssets({ execute: process.argv.includes('--execute'), pool });
    if (summary.missing) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { legacyBody, replaceImageEntry, rewriteLegacyReferences, backfillOne, backfillLegacyAssets, main };
