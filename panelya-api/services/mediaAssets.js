const db = require('../db');

const MEDIA_URL_PATTERN = /\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(?:thumbnail|card|detail)(?:[?#].*)?$/i;

function mediaDeliveryUrl(assetId, variantName) {
  return `/api/media/${assetId}/${variantName}`;
}

function responsiveMediaUrls(assetId) {
  return {
    thumbnail: mediaDeliveryUrl(assetId, 'thumbnail'),
    card: mediaDeliveryUrl(assetId, 'card'),
    detail: mediaDeliveryUrl(assetId, 'detail'),
  };
}

function extractMediaAssetId(value) {
  const candidate = String(value || '').split('|').pop().trim();
  return candidate.match(MEDIA_URL_PATTERN)?.[1]?.toLowerCase() || null;
}

function extractMediaAssetIds(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(extractMediaAssetId).filter(Boolean))];
}

async function createPendingAsset(client, {
  organizationId,
  prepared,
  storage,
  createdBy = null,
}) {
  const totalBytes = prepared.variants.reduce((sum, variant) => sum + variant.byteSize, 0);
  const urls = responsiveMediaUrls(prepared.assetId);
  await client.query(
    `insert into upload_assets
     (id, organization_id, url, filename, byte_size, mime_type, created_by, data,
      storage_provider, bucket_name, object_key, original_filename, content_type,
      width, height, checksum, status, updated_at)
     values ($1,$2,$3,$4,$5,'image/webp',$6,null,$7,$8,$9,$10,'image/webp',$11,$12,$13,'pending',now())`,
    [
      prepared.assetId,
      organizationId,
      urls.detail,
      `${prepared.assetId}.webp`,
      totalBytes,
      createdBy,
      storage.provider,
      storage.bucket || null,
      prepared.variants.find((item) => item.name === 'detail').objectKey,
      prepared.originalFilename,
      prepared.sourceWidth,
      prepared.sourceHeight,
      prepared.sourceChecksum,
    ]
  );
  return { totalBytes, urls };
}

async function uploadPreparedAsset(client, options) {
  const { organizationId, prepared, storage } = options;
  const uploadedObjects = [];
  const { totalBytes, urls } = await createPendingAsset(client, options);
  try {
    for (const variant of prepared.variants) {
      await storage.put({
        objectKey: variant.objectKey,
        body: variant.data,
        contentType: variant.contentType,
        checksum: variant.checksum,
      });
      uploadedObjects.push(variant.objectKey);
      await client.query(
        `insert into media_variants
         (organization_id, asset_id, variant_name, storage_provider, bucket_name,
          object_key, url, content_type, byte_size, width, height, checksum)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          organizationId,
          prepared.assetId,
          variant.name,
          storage.provider,
          storage.bucket || null,
          variant.objectKey,
          urls[variant.name],
          variant.contentType,
          variant.byteSize,
          variant.width,
          variant.height,
          variant.checksum,
        ]
      );
    }
    await client.query(
      `update upload_assets
       set status = 'ready', updated_at = now()
       where id = $1 and organization_id = $2 and status = 'pending'`,
      [prepared.assetId, organizationId]
    );
    return {
      id: prepared.assetId,
      url: urls.detail,
      urls,
      byteSize: totalBytes,
      width: prepared.sourceWidth,
      height: prepared.sourceHeight,
    };
  } catch (error) {
    error.uploadedObjects = uploadedObjects;
    error.assetId = prepared.assetId;
    throw error;
  }
}

async function deleteObjectsBestEffort(storage, objectKeys) {
  const failed = [];
  await Promise.all([...new Set(objectKeys)].map(async (objectKey) => {
    try {
      await storage.delete({ objectKey });
    } catch (error) {
      failed.push({ objectKey, error: String(error.message || error).slice(0, 500) });
    }
  }));
  return failed;
}

async function enqueueCleanupObjects({
  organizationId,
  assetId = null,
  storage,
  objects,
  query = db.systemQuery,
}) {
  for (const entry of objects) {
    const objectKey = typeof entry === 'string' ? entry : entry.objectKey;
    const error = typeof entry === 'string' ? null : entry.error;
    await query(
      `insert into media_cleanup_jobs
       (organization_id, asset_id, storage_provider, bucket_name, object_key, last_error)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (storage_provider, object_key)
       do update set status = 'pending', available_at = now(), last_error = excluded.last_error`,
      [organizationId, assetId, storage.provider, storage.bucket || null, objectKey, error]
    );
  }
}

async function syncMediaReferences(client, {
  organizationId,
  resourceType,
  resourceId,
  fieldName = 'image',
  values = [],
  altText = '',
}) {
  const assetIds = extractMediaAssetIds(values);
  if (assetIds.length) {
    const scoped = await client.query(
      `select id
       from upload_assets
       where organization_id = $1
         and id = any($2::uuid[])
         and status in ('ready', 'orphan_candidate')`,
      [organizationId, assetIds]
    );
    if (scoped.rows.length !== assetIds.length) {
      throw Object.assign(new Error('Gorsel bu workspace icin kullanilamaz'), { status: 400 });
    }
  }

  const previous = await client.query(
    `delete from media_references
     where organization_id = $1 and resource_type = $2 and resource_id = $3 and field_name = $4
     returning asset_id`,
    [organizationId, resourceType, String(resourceId), fieldName]
  );

  for (const assetId of assetIds) {
    await client.query(
      `insert into media_references
       (organization_id, asset_id, resource_type, resource_id, field_name, alt_text)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (organization_id, asset_id, resource_type, resource_id, field_name)
       do update set alt_text = excluded.alt_text`,
      [organizationId, assetId, resourceType, String(resourceId), fieldName, String(altText || '').slice(0, 500)]
    );
  }

  if (assetIds.length) {
    await client.query(
      `update upload_assets
       set status = 'ready', orphaned_at = null, updated_at = now()
       where organization_id = $1 and id = any($2::uuid[])`,
      [organizationId, assetIds]
    );
  }

  const affected = [...new Set(previous.rows.map((row) => row.asset_id).filter((id) => !assetIds.includes(id)))];
  if (affected.length) {
    await client.query(
      `update upload_assets ua
       set status = 'orphan_candidate', orphaned_at = coalesce(orphaned_at, now()), updated_at = now()
       where ua.organization_id = $1
         and ua.id = any($2::uuid[])
         and ua.status = 'ready'
         and not exists (select 1 from media_references mr where mr.asset_id = ua.id)`,
      [organizationId, affected]
    );
  }

  return assetIds;
}

async function queueAssetDeletion(client, { organizationId, assetId }) {
  const asset = await client.query(
    `select id, status
     from upload_assets
     where organization_id = $1 and id = $2
     for update`,
    [organizationId, assetId]
  );
  if (!asset.rows[0]) return { outcome: 'not_found' };
  if (asset.rows[0].status === 'deleted') return { outcome: 'deleted' };
  const references = await client.query(
    'select count(*)::int as count from media_references where organization_id = $1 and asset_id = $2',
    [organizationId, assetId]
  );
  if (references.rows[0].count > 0) return { outcome: 'in_use', references: references.rows[0].count };

  const variants = await client.query(
    `select storage_provider, bucket_name, object_key
     from media_variants
     where organization_id = $1 and asset_id = $2`,
    [organizationId, assetId]
  );
  if (!variants.rows.length) {
    await client.query(
      `update upload_assets
       set status = 'deleted', deleted_at = coalesce(deleted_at, now()), updated_at = now()
       where organization_id = $1 and id = $2`,
      [organizationId, assetId]
    );
    return { outcome: 'deleted', count: 0 };
  }
  for (const variant of variants.rows) {
    await client.query(
      `insert into media_cleanup_jobs
       (organization_id, asset_id, storage_provider, bucket_name, object_key)
       values ($1,$2,$3,$4,$5)
       on conflict (storage_provider, object_key)
       do update set status = case when media_cleanup_jobs.status = 'completed' then 'completed' else 'pending' end,
                     available_at = now()`,
      [organizationId, assetId, variant.storage_provider, variant.bucket_name, variant.object_key]
    );
  }
  await client.query(
    `update upload_assets set status = 'deleting', updated_at = now()
     where organization_id = $1 and id = $2`,
    [organizationId, assetId]
  );
  return { outcome: 'queued', count: variants.rows.length };
}

async function processCleanupJobs({
  storage,
  limit = 50,
  organizationId = null,
  assetId = null,
  pool = db.getSystemPool(),
} = {}) {
  const params = [Math.max(1, Math.min(200, Number(limit) || 50))];
  const filters = ["status in ('pending', 'processing')", 'available_at <= now()'];
  if (organizationId) { params.push(organizationId); filters.push(`organization_id = $${params.length}`); }
  if (assetId) { params.push(assetId); filters.push(`asset_id = $${params.length}`); }
  const claimClient = await pool.connect();
  let jobs;
  try {
    await claimClient.query('begin');
    const selected = await claimClient.query(
      `select id from media_cleanup_jobs
       where ${filters.join(' and ')}
       order by id asc
       for update skip locked
       limit $1`,
      params
    );
    jobs = selected.rows.length
      ? await claimClient.query(
        `update media_cleanup_jobs
         set status = 'processing', available_at = now() + interval '5 minutes'
         where id = any($1::bigint[])
         returning *`,
        [selected.rows.map((row) => row.id)]
      )
      : { rows: [] };
    await claimClient.query('commit');
  } catch (error) {
    await claimClient.query('rollback').catch(() => {});
    throw error;
  } finally {
    claimClient.release();
  }
  let completed = 0;
  let failed = 0;
  for (const job of jobs.rows) {
    if (job.storage_provider !== storage.provider || (job.bucket_name || null) !== (storage.bucket || null)) {
      failed += 1;
      await pool.query(
        `update media_cleanup_jobs set status = 'dead_letter', last_error = $2, attempts = attempts + 1
         where id = $1`,
        [job.id, 'Configured storage adapter does not match cleanup job']
      );
      continue;
    }
    try {
      await storage.delete({ objectKey: job.object_key });
      await pool.query(
        `update media_cleanup_jobs
         set status = 'completed', attempts = attempts + 1, completed_at = now(), last_error = null
         where id = $1`,
        [job.id]
      );
      completed += 1;
    } catch (error) {
      failed += 1;
      await pool.query(
        `update media_cleanup_jobs
         set status = case when attempts + 1 >= 10 then 'dead_letter' else 'pending' end,
             attempts = attempts + 1,
             last_error = $2,
             available_at = now() + make_interval(secs => least(3600, power(2, least(attempts + 1, 10))::int))
         where id = $1`,
        [job.id, String(error.message || error).slice(0, 500)]
      );
    }
  }

  await pool.query(
    `update upload_assets ua
     set status = 'deleted', deleted_at = now(), updated_at = now()
     where ua.status = 'deleting'
       and ($1::uuid is null or ua.organization_id = $1)
       and ($2::uuid is null or ua.id = $2)
       and not exists (
         select 1 from media_cleanup_jobs j
         where j.asset_id = ua.id and j.status <> 'completed'
       )`,
    [organizationId, assetId]
  );
  return { inspected: jobs.rows.length, completed, failed };
}

module.exports = {
  mediaDeliveryUrl,
  responsiveMediaUrls,
  extractMediaAssetId,
  extractMediaAssetIds,
  uploadPreparedAsset,
  deleteObjectsBestEffort,
  enqueueCleanupObjects,
  syncMediaReferences,
  queueAssetDeletion,
  processCleanupJobs,
};
