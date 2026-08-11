const db = require('../../db');
const { setInventoryBalance } = require('../../services/inventory');
const { assertPlanCapacity, assertStorageCapacity } = require('../../services/planLimits');
const { createObjectStorage } = require('../../services/objectStorage');
const {
  deleteObjectsBestEffort, enqueueCleanupObjects, syncMediaReferences, uploadPreparedAsset,
} = require('../../services/mediaAssets');
const { prepareExternalImage } = require('./externalImage');
const { prepareImage } = require('../../services/mediaPipeline');

const storage = createObjectStorage();
let workerRunning = false;
let scheduled = false;
let lastCleanupAt = 0;

function operationError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function errorRecord(error) {
  const code = /^[A-Z0-9_]+$/.test(String(error.code || '')) ? error.code : 'ROW_APPLY_FAILED';
  const safeMessage = Number(error.status || 500) < 500 ? error.message : 'Satir islenirken beklenmeyen hata olustu';
  return [{ code, message: String(safeMessage).slice(0, 500) }];
}

async function mappedValue(raw, mapping) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return String(mapping?.[value] ?? mapping?.[value.toLocaleLowerCase('tr-TR')] ?? value).trim();
}

async function resolveCategory(client, organizationId, rawCategory, config) {
  const category = await mappedValue(rawCategory, config.categoryMapping);
  if (!category) return null;
  const result = await client.query(
    `select id from categories
      where organization_id = $1 and (lower(name) = lower($2) or lower(slug) = lower($2))
      order by id limit 1`,
    [organizationId, category]
  );
  if (!result.rows[0]) throw operationError('CATEGORY_NOT_FOUND', `Kategori bulunamadi: ${category}`);
  return result.rows[0].id;
}

async function resolveCollections(client, organizationId, rawCollections, config) {
  const requested = [];
  for (const raw of rawCollections || []) requested.push(await mappedValue(raw, config.collectionMapping));
  const unique = [...new Set(requested.filter(Boolean))];
  if (!unique.length) return [];
  // Match by tenant collection title/slug using PostgreSQL lower() on both sides so
  // JS-side casing (notably Turkish dotted/dotless I) can never diverge from the DB.
  const result = await client.query(
    `select c.id, needle.value as requested
       from unnest($2::text[]) as needle(value)
       join collections c
         on c.organization_id = $1
        and (lower(c.title) = lower(needle.value) or lower(c.slug) = lower(needle.value))`,
    [organizationId, unique]
  );
  const found = new Set(result.rows.map((row) => row.requested));
  const missing = unique.filter((value) => !found.has(value));
  if (missing.length) throw operationError('COLLECTION_NOT_FOUND', `Koleksiyon bulunamadi: ${missing.join(', ')}`);
  return [...new Set(result.rows.map((row) => row.id))];
}

function appendDistinct(values, addition) {
  return [...new Set([...(Array.isArray(values) ? values : []), String(addition || '').trim()].filter(Boolean))];
}

async function uploadRowImage(client, organizationId, imageUrl, createdBy) {
  if (!imageUrl) return null;
  const prepared = await prepareExternalImage(imageUrl, organizationId);
  try {
    await assertStorageCapacity(client, organizationId, prepared.variants.reduce((sum, variant) => sum + variant.byteSize, 0));
    const result = await uploadPreparedAsset(client, { organizationId, prepared, storage, createdBy });
    return { result, objectKeys: prepared.variants.map((variant) => variant.objectKey) };
  } catch (error) {
    error.cleanupObjectKeys = prepared.variants.map((variant) => variant.objectKey);
    throw error;
  }
}

async function uploadBundledRowImage(client, organizationId, jobId, imageFile, createdBy) {
  if (!imageFile) return null;
  const result = await client.query(
    `select * from import_job_images where organization_id = $1 and import_job_id = $2
      and normalized_filename = $3`,
    [organizationId, jobId, String(imageFile).toLocaleLowerCase('tr-TR')]
  );
  const image = result.rows[0];
  if (!image) throw operationError('IMAGE_FILE_NOT_FOUND', `ZIP gorseli bulunamadi: ${imageFile}`, 404);
  if (image.storage_provider !== storage.provider || (image.bucket_name || null) !== (storage.bucket || null)) {
    throw operationError('STORAGE_MISMATCH', 'ZIP gorseli depolama servisine erisilemiyor', 503);
  }
  const buffer = await storage.get({ objectKey: image.object_key });
  const prepared = await prepareImage({ buffer, mimetype: image.content_type, originalname: image.original_filename }, organizationId);
  try {
    await assertStorageCapacity(client, organizationId, prepared.variants.reduce((sum, variant) => sum + variant.byteSize, 0));
    const uploaded = await uploadPreparedAsset(client, { organizationId, prepared, storage, createdBy });
    return { result: uploaded, objectKeys: prepared.variants.map((variant) => variant.objectKey) };
  } catch (error) {
    error.cleanupObjectKeys = prepared.variants.map((variant) => variant.objectKey);
    throw error;
  }
}

async function applyProductUpsert(client, { organizationId, jobId, row, config, createdBy }) {
  const payload = row.normalized_payload;
  const categoryId = await resolveCategory(client, organizationId, payload.category, config);
  const collectionIds = await resolveCollections(client, organizationId, payload.collections, config);
  const existingVariantResult = await client.query(
    `select pv.*, p.name as product_name, p.colors, p.sizes, p.images
       from product_variants pv
       join products p on p.organization_id = pv.organization_id and p.id = pv.product_id
      where pv.organization_id = $1 and pv.normalized_sku = lower($2)
      for update of pv, p`,
    [organizationId, payload.sku]
  );
  let variant = existingVariantResult.rows[0];
  let productId;
  let existingImages = [];
  if (variant) {
    productId = variant.product_id;
    existingImages = variant.images || [];
  } else {
    const matchingProduct = await client.query(
      `select p.id, p.colors, p.sizes, p.images
         from products p
        where p.organization_id = $1 and lower(p.name) = lower($2)
        order by p.id limit 1 for update`,
      [organizationId, payload.name]
    );
    if (matchingProduct.rows[0]) {
      productId = matchingProduct.rows[0].id;
      existingImages = matchingProduct.rows[0].images || [];
    } else {
      await assertPlanCapacity(client, organizationId, 'products');
      const inserted = await client.query(
        `insert into products
         (organization_id, name, category_id, price, sale_price, stock, status,
          colors, sizes, images, details, tags, description, product_story, emoji, featured_in_category)
         values ($1,$2,$3,$4,$5,0,$6,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'',$7,'','',false)
         returning id`,
        [organizationId, payload.name, categoryId, payload.price, payload.sale_price, payload.status, payload.description]
      );
      productId = inserted.rows[0].id;
    }
  }

  let uploadedImage = null;
  if (existingImages.length === 0) {
    if (payload.image_url) uploadedImage = await uploadRowImage(client, organizationId, payload.image_url, createdBy);
    else if (payload.image_file) uploadedImage = await uploadBundledRowImage(client, organizationId, jobId, payload.image_file, createdBy);
  }
  const imageValues = uploadedImage ? appendDistinct(existingImages, uploadedImage.result.url) : existingImages;
  const currentProduct = await client.query(
    'select colors, sizes from products where organization_id = $1 and id = $2 for update',
    [organizationId, productId]
  );
  const colors = appendDistinct(currentProduct.rows[0]?.colors, payload.color);
  const sizes = appendDistinct(currentProduct.rows[0]?.sizes, payload.size);
  await client.query(
    `update products set name = $1, category_id = coalesce($2, category_id), price = $3,
      sale_price = $4, status = $5, colors = $6::jsonb, sizes = $7::jsonb,
      images = $8::jsonb, description = $9, updated_at = now()
      where organization_id = $10 and id = $11`,
    [payload.name, categoryId, payload.price, payload.sale_price, payload.status,
      JSON.stringify(colors), JSON.stringify(sizes), JSON.stringify(imageValues), payload.description,
      organizationId, productId]
  );

  if (!variant) {
    const conflictingOption = await client.query(
      `select id from product_variants where organization_id = $1 and product_id = $2
        and lower(color) = lower($3) and lower(size) = lower($4) limit 1`,
      [organizationId, productId, payload.color, payload.size]
    );
    if (conflictingOption.rows[0]) throw operationError('VARIANT_OPTION_CONFLICT', 'Ayni urun renk/beden secenegi baska bir SKU kullaniyor', 409);
    const insertedVariant = await client.query(
      `insert into product_variants
       (organization_id, product_id, color, size, sku, stock, status, is_active,
        is_default, on_hand, reserved, incoming, low_stock_threshold, inventory_version)
       values ($1,$2,$3,$4,$5,0,'out',true,
        not exists (select 1 from product_variants where organization_id = $1 and product_id = $2 and is_default),
        0,0,0,0,0)
       returning *`,
      [organizationId, productId, payload.color, payload.size, payload.sku]
    );
    variant = insertedVariant.rows[0];
  } else {
    await client.query(
      `update product_variants set color = $1, size = $2, is_active = true, updated_at = now()
        where organization_id = $3 and id = $4`,
      [payload.color, payload.size, organizationId, variant.id]
    );
  }

  await setInventoryBalance(client, {
    organizationId, productId, variantId: variant.id, stock: payload.stock,
    reason: 'Catalog product import', actorType: 'import', actorId: createdBy,
    idempotencyKey: `import:${jobId}:row:${row.id}`, syncProduct: true,
  });

  if (collectionIds.length) {
    await client.query('delete from product_collections where organization_id = $1 and product_id = $2', [organizationId, productId]);
    await client.query(
      `insert into product_collections (organization_id, collection_id, product_id)
       select $1, unnest($2::bigint[]), $3 on conflict do nothing`,
      [organizationId, collectionIds, productId]
    );
  }
  if (uploadedImage) {
    await syncMediaReferences(client, {
      organizationId, resourceType: 'product', resourceId: productId,
      fieldName: 'images', values: imageValues, altText: payload.name,
    });
  }
  return { entityId: productId, cleanupObjectKeys: uploadedImage?.objectKeys || [] };
}

async function applyStockUpdate(client, { organizationId, jobId, row, createdBy }) {
  const payload = row.normalized_payload;
  const result = await client.query(
    `select pv.id, pv.product_id, pv.inventory_version
       from product_variants pv
      where pv.organization_id = $1 and pv.normalized_sku = lower($2)
      for update`,
    [organizationId, payload.sku]
  );
  const variant = result.rows[0];
  if (!variant) throw operationError('SKU_NOT_FOUND', `SKU bulunamadi: ${payload.sku}`, 404);
  if (payload.expected_version != null && Number(variant.inventory_version) !== Number(payload.expected_version)) {
    throw operationError('INVENTORY_VERSION_CONFLICT', `Stok versiyonu degisti; beklenen ${payload.expected_version}, mevcut ${variant.inventory_version}`, 409);
  }
  await setInventoryBalance(client, {
    organizationId, productId: variant.product_id, variantId: variant.id, stock: payload.stock,
    reason: payload.reason, actorType: 'import', actorId: createdBy,
    idempotencyKey: `import:${jobId}:row:${row.id}`,
  });
  return { entityId: variant.product_id, cleanupObjectKeys: [] };
}

async function applyPriceUpdate(client, { organizationId, row }) {
  const payload = row.normalized_payload;
  const result = await client.query(
    `update products p set price = $1, sale_price = $2, updated_at = now()
       from product_variants pv
      where pv.organization_id = $3 and pv.normalized_sku = lower($4)
        and p.organization_id = pv.organization_id and p.id = pv.product_id
      returning p.id`,
    [payload.price, payload.sale_price, organizationId, payload.sku]
  );
  if (!result.rows[0]) throw operationError('SKU_NOT_FOUND', `SKU bulunamadi: ${payload.sku}`, 404);
  return { entityId: result.rows[0].id, cleanupObjectKeys: [] };
}

async function applyRow(client, context) {
  if (context.jobType === 'product_upsert') return applyProductUpsert(client, context);
  if (context.jobType === 'stock_update') return applyStockUpdate(client, context);
  if (context.jobType === 'price_update') return applyPriceUpdate(client, context);
  throw operationError('INVALID_JOB_TYPE', 'Import tipi gecersiz');
}

async function claimJob() {
  const client = await db.getSystemPool().connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `select * from import_jobs where status = 'queued'
       order by created_at for update skip locked limit 1`
    );
    const job = result.rows[0];
    if (job) await client.query(
      `update import_jobs set status = 'processing', started_at = coalesce(started_at, now()), updated_at = now()
        where id = $1`, [job.id]
    );
    await client.query('commit');
    return job || null;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function claimRow(job) {
  return db.withTenantContext(job.organization_id, async (client) => {
    const cancelled = await client.query('select status from import_jobs where organization_id = $1 and id = $2', [job.organization_id, job.id]);
    if (cancelled.rows[0]?.status === 'cancelled') return null;
    await client.query(
      `update import_job_rows set status = 'pending', locked_at = null, updated_at = now()
        where organization_id = $1 and import_job_id = $2 and status = 'processing'
          and locked_at < now() - interval '10 minutes' and attempts < 5`,
      [job.organization_id, job.id]
    );
    const result = await client.query(
      `select * from import_job_rows
        where organization_id = $1 and import_job_id = $2 and status = 'pending' and attempts < 5
        order by row_number for update skip locked limit 1`,
      [job.organization_id, job.id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const updated = await client.query(
      `update import_job_rows set status = 'processing', attempts = attempts + 1,
        locked_at = now(), updated_at = now() where organization_id = $1 and id = $2 returning *`,
      [job.organization_id, row.id]
    );
    return updated.rows[0];
  });
}

async function processClaimedRow(job, row) {
  let cleanupObjectKeys = [];
  try {
    await db.withTenantContext(job.organization_id, async (client) => {
      const current = await client.query(
        `select * from import_job_rows where organization_id = $1 and id = $2 and status = 'processing' for update`,
        [job.organization_id, row.id]
      );
      if (!current.rows[0]) return;
      const result = await applyRow(client, {
        organizationId: job.organization_id, jobId: job.id, jobType: job.job_type,
        config: job.config || {}, createdBy: job.created_by, row: current.rows[0],
      });
      cleanupObjectKeys = result.cleanupObjectKeys || [];
      await client.query(
        `update import_job_rows set status = 'succeeded', error_codes = '[]'::jsonb,
          resulting_entity_id = $1, locked_at = null, processed_at = now(), updated_at = now()
          where organization_id = $2 and id = $3`,
        [result.entityId, job.organization_id, row.id]
      );
    });
  } catch (error) {
    const objectKeys = [...cleanupObjectKeys, ...(error.cleanupObjectKeys || []), ...(error.uploadedObjects || [])];
    if (objectKeys.length) {
      const failed = await deleteObjectsBestEffort(storage, objectKeys);
      if (failed.length) await enqueueCleanupObjects({ organizationId: job.organization_id, storage, objects: failed }).catch(() => {});
    }
    await db.withTenantContext(job.organization_id, (client) => client.query(
      `update import_job_rows set status = 'error', error_codes = $1::jsonb,
        locked_at = null, processed_at = now(), updated_at = now()
        where organization_id = $2 and id = $3 and status = 'processing'`,
      [JSON.stringify(errorRecord(error)), job.organization_id, row.id]
    ));
  }
}

async function finalizeJob(job) {
  await db.withTenantContext(job.organization_id, async (client) => {
    const current = await client.query('select status from import_jobs where organization_id = $1 and id = $2 for update', [job.organization_id, job.id]);
    if (!current.rows[0] || current.rows[0].status === 'cancelled') return;
    const counts = await client.query(
      `select count(*)::integer as total,
        count(*) filter (where status = 'succeeded')::integer as success,
        count(*) filter (where status = 'error')::integer as errors,
        count(*) filter (where status in ('pending','processing'))::integer as remaining
       from import_job_rows where organization_id = $1 and import_job_id = $2`,
      [job.organization_id, job.id]
    );
    const count = counts.rows[0];
    if (count.remaining > 0) {
      await client.query(`update import_jobs set status = 'queued', updated_at = now() where organization_id = $1 and id = $2`, [job.organization_id, job.id]);
      return;
    }
    await client.query(
      `update import_jobs set status = $1, processed_rows = $2, success_rows = $3,
        error_rows = $4, completed_at = now(), updated_at = now()
        where organization_id = $5 and id = $6`,
      [count.errors > 0 ? 'completed_with_errors' : 'completed', count.success + count.errors,
        count.success, count.errors, job.organization_id, job.id]
    );
  });
}

async function processJob(job) {
  while (true) {
    const row = await claimRow(job);
    if (!row) break;
    await processClaimedRow(job, row);
  }
  await finalizeJob(job);
}

async function processImportJobs({ maxJobs = 5 } = {}) {
  if (workerRunning) return 0;
  workerRunning = true;
  let processed = 0;
  try {
    while (processed < maxJobs) {
      const job = await claimJob();
      if (!job) break;
      await processJob(job);
      processed += 1;
    }
    return processed;
  } finally { workerRunning = false; }
}

async function cleanupExpiredImportJobs({ limit = 100 } = {}) {
  const result = await db.systemQuery(
    `select j.id, j.organization_id, j.storage_provider, j.bucket_name, j.object_key,
      coalesce(array_agg(i.object_key) filter (where i.object_key is not null), '{}') as image_keys
     from import_jobs j left join import_job_images i
       on i.organization_id = j.organization_id and i.import_job_id = j.id
     where j.retention_until < now()
       and j.status in ('completed','completed_with_errors','failed','cancelled')
     group by j.id order by j.retention_until limit $1`,
    [Math.max(1, Math.min(Number(limit) || 100, 500))]
  );
  let deleted = 0;
  for (const job of result.rows) {
    if (job.storage_provider !== storage.provider || (job.bucket_name || null) !== (storage.bucket || null)) continue;
    const failed = await deleteObjectsBestEffort(storage, [job.object_key, ...(job.image_keys || [])]);
    if (failed.length) continue;
    const removal = await db.systemQuery(
      `delete from import_jobs where id = $1 and organization_id = $2 and retention_until < now()
        and status in ('completed','completed_with_errors','failed','cancelled')`,
      [job.id, job.organization_id]
    );
    deleted += removal.rowCount;
  }
  return deleted;
}

function scheduleImportWorker() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    processImportJobs().then(async () => {
      if (Date.now() - lastCleanupAt > 60 * 60 * 1000) {
        lastCleanupAt = Date.now();
        await cleanupExpiredImportJobs();
      }
    }).catch((error) => console.warn(`Import worker hatasi: ${error.message}`));
  });
}

function startImportWorker() {
  if (process.env.NODE_ENV === 'test' || process.env.IMPORT_WORKER_ENABLED === 'false') return null;
  const intervalMs = Math.max(2_000, Math.min(Number(process.env.IMPORT_WORKER_INTERVAL_MS) || 10_000, 300_000));
  const startup = setTimeout(scheduleImportWorker, 1_500);
  startup.unref();
  const interval = setInterval(scheduleImportWorker, intervalMs);
  interval.unref();
  return interval;
}

module.exports = {
  applyPriceUpdate, applyProductUpsert, applyRow, applyStockUpdate, errorRecord,
  cleanupExpiredImportJobs, processImportJobs, scheduleImportWorker, startImportWorker,
};
