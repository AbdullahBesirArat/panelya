const crypto = require('crypto');
const { assertObjectKey } = require('../../services/objectStorage');
const {
  JOB_COLUMNS, configHash, importError, parseImportFile, rowsToCsv, rowsToXlsx, sha256, validateJobType,
} = require('./formats');
const { extractImageZip } = require('./imageZip');

function sanitizeMapping(value, label) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw importError(`${label} eslemesi gecersiz`, 'INVALID_CONFIG');
  const entries = Object.entries(value);
  if (entries.length > 100) throw importError(`${label} esleme limiti asildi`, 'INVALID_CONFIG');
  return Object.fromEntries(entries.map(([key, mapped]) => {
    const safeKey = String(key).trim().slice(0, 160);
    const safeValue = String(mapped).trim().slice(0, 160);
    if (!safeKey || !safeValue) throw importError(`${label} eslemesi bos olamaz`, 'INVALID_CONFIG');
    return [safeKey, safeValue];
  }));
}

function sanitizeConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    columnMapping: sanitizeMapping(config.columnMapping, 'Sutun'),
    categoryMapping: sanitizeMapping(config.categoryMapping, 'Kategori'),
    collectionMapping: sanitizeMapping(config.collectionMapping, 'Koleksiyon'),
  };
}

function contentTypeFor(filename) {
  const extension = String(filename || '').toLowerCase().split('.').pop();
  if (extension === 'csv') return 'text/csv; charset=utf-8';
  if (extension === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  throw importError('Yalniz CSV veya XLSX desteklenir', 'UNSUPPORTED_FILE_TYPE');
}

function importObjectKey(organizationId, filename, checksum) {
  const extension = String(filename).toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
  const key = `tenants/${String(organizationId).toLowerCase()}/media/imports/${crypto.randomUUID()}-${checksum.slice(0, 16)}.${extension}`;
  return assertObjectKey(key, organizationId);
}

function imageObjectKey(organizationId, image) {
  const extension = image.contentType === 'image/jpeg' ? 'jpg' : image.contentType.split('/')[1];
  const key = `tenants/${String(organizationId).toLowerCase()}/media/imports/images/${crypto.randomUUID()}-${image.checksum.slice(0, 16)}.${extension}`;
  return assertObjectKey(key, organizationId);
}

async function insertRows(client, job, rows) {
  for (let offset = 0; offset < rows.length; offset += 200) {
    const batch = rows.slice(offset, offset + 200);
    const values = [];
    const tuples = batch.map((row, index) => {
      const base = index * 8;
      values.push(job.organizationId, job.id, row.rowNumber, row.rowKey, JSON.stringify(row.payload),
        row.errors.length ? 'error' : 'pending', JSON.stringify(row.errors), row.errors.length ? new Date() : null);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::jsonb,$${base + 6},$${base + 7}::jsonb,$${base + 8})`;
    });
    await client.query(
      `insert into import_job_rows
       (organization_id, import_job_id, row_number, row_key, normalized_payload, status, error_codes, processed_at)
       values ${tuples.join(',')}`,
      values
    );
  }
}

async function loadJob(client, organizationId, jobId, { rows = false } = {}) {
  const result = await client.query(
    `select id, organization_id, job_type as type, status, original_filename, content_type,
      byte_size, checksum, config, config_hash, preview_checksum, preview_config_hash,
      warnings, total_rows, processed_rows, success_rows, error_rows, idempotency_key,
      started_at, completed_at, cancelled_at, retention_until, created_at, updated_at
     from import_jobs where organization_id = $1 and id = $2`,
    [organizationId, jobId]
  );
  const job = result.rows[0];
  if (!job) return null;
  if (rows) {
    const rowResult = await client.query(
      `select id, row_number, normalized_payload as payload, status, error_codes as errors,
        resulting_entity_id, attempts, processed_at
       from import_job_rows where organization_id = $1 and import_job_id = $2
       order by row_number limit 200`,
      [organizationId, jobId]
    );
    job.rows = rowResult.rows;
  }
  return job;
}

async function createPreviewJob(client, {
  organizationId, file, imagesFile, jobType, config: rawConfig, idempotencyKey, createdBy, storage,
}) {
  validateJobType(jobType);
  const safeIdempotency = String(idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(safeIdempotency)) {
    throw importError('Idempotency key gecersiz', 'INVALID_IDEMPOTENCY_KEY');
  }
  if (!file?.buffer?.length) throw importError('Import dosyasi zorunlu', 'FILE_REQUIRED');
  const originalFilename = String(file.originalname || 'import.csv').replace(/[\r\n]/g, '').slice(0, 240);
  const contentType = contentTypeFor(originalFilename);
  const config = sanitizeConfig(rawConfig);
  const checksum = sha256(file.buffer);
  const currentConfigHash = configHash(config);
  const existingResult = await client.query(
    'select id, checksum, config_hash, job_type from import_jobs where organization_id = $1 and idempotency_key = $2',
    [organizationId, safeIdempotency]
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (existing.checksum !== checksum || existing.config_hash !== currentConfigHash || existing.job_type !== jobType) {
      throw importError('Ayni idempotency key farkli dosya veya ayarla kullanilamaz', 'IDEMPOTENCY_CONFLICT', 409);
    }
    return loadJob(client, organizationId, existing.id, { rows: true });
  }

  if (imagesFile && jobType !== 'product_upsert') throw importError('Gorsel ZIP yalniz urun importunda kullanilabilir', 'IMAGE_ZIP_NOT_ALLOWED');
  if (imagesFile && !String(imagesFile.originalname || '').toLowerCase().endsWith('.zip')) {
    throw importError('Toplu gorseller ZIP dosyasi olmalidir', 'INVALID_IMAGE_ZIP');
  }
  const bundledImages = imagesFile ? extractImageZip(imagesFile.buffer) : [];
  const parsed = await parseImportFile(file.buffer, {
    filename: originalFilename, jobType, config,
    imageFiles: new Set(bundledImages.map((image) => image.normalizedFilename)),
  });
  const objectKey = importObjectKey(organizationId, originalFilename, checksum);
  const uploadedKeys = [objectKey];
  await storage.put({ objectKey, body: file.buffer, contentType, checksum });
  try {
    const errors = parsed.rows.filter((row) => row.errors.length).length;
    const inserted = await client.query(
      `insert into import_jobs
       (organization_id, job_type, status, original_filename, content_type, storage_provider,
        bucket_name, object_key, byte_size, checksum, config, config_hash,
        preview_checksum, preview_config_hash, warnings, total_rows, error_rows,
        idempotency_key, created_by)
       values ($1,$2,'previewed',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$9,$11,$12::jsonb,$13,$14,$15,$16)
       returning id`,
      [organizationId, jobType, originalFilename, contentType, storage.provider, storage.bucket || null,
        objectKey, file.buffer.length, checksum, JSON.stringify(config), currentConfigHash,
        JSON.stringify(parsed.warnings), parsed.rows.length, errors, safeIdempotency, createdBy]
    );
    for (const image of bundledImages) {
      const imageKey = imageObjectKey(organizationId, image);
      await storage.put({ objectKey: imageKey, body: image.buffer, contentType: image.contentType, checksum: image.checksum });
      uploadedKeys.push(imageKey);
      await client.query(
        `insert into import_job_images
         (organization_id, import_job_id, original_filename, normalized_filename,
          storage_provider, bucket_name, object_key, content_type, byte_size, checksum)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [organizationId, inserted.rows[0].id, image.originalFilename, image.normalizedFilename,
          storage.provider, storage.bucket || null, imageKey, image.contentType, image.buffer.length, image.checksum]
      );
    }
    await insertRows(client, { organizationId, id: inserted.rows[0].id }, parsed.rows);
    return loadJob(client, organizationId, inserted.rows[0].id, { rows: true });
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => storage.delete({ objectKey: key }).catch(() => {})));
    throw error;
  }
}

async function queueJob(client, { organizationId, jobId, storage }) {
  const result = await client.query(
    `select * from import_jobs where organization_id = $1 and id = $2 for update`,
    [organizationId, jobId]
  );
  const job = result.rows[0];
  if (!job) throw importError('Import isi bulunamadi', 'JOB_NOT_FOUND', 404);
  if (job.status !== 'previewed') throw importError('Yalniz onizlenmis is uygulanabilir', 'PREVIEW_REQUIRED', 409);
  if (!job.preview_checksum || job.preview_checksum !== job.checksum
      || !job.preview_config_hash || job.preview_config_hash !== job.config_hash) {
    throw importError('Onizleme dosyasi veya ayarlari degisti', 'PREVIEW_MISMATCH', 409);
  }
  if (job.storage_provider !== storage.provider || (job.bucket_name || null) !== (storage.bucket || null)) {
    throw importError('Import dosyasi depolama servisine erisilemiyor', 'STORAGE_MISMATCH', 503);
  }
  const body = await storage.get({ objectKey: job.object_key });
  if (sha256(body) !== job.checksum) throw importError('Import dosyasi checksum dogrulamasi basarisiz', 'CHECKSUM_MISMATCH', 409);
  await client.query(
    `update import_jobs set status = 'queued', processed_rows = 0, success_rows = 0,
      error_rows = (select count(*) from import_job_rows where organization_id = $1 and import_job_id = $2 and status = 'error'),
      started_at = null, completed_at = null, updated_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, jobId]
  );
  return loadJob(client, organizationId, jobId, { rows: true });
}

async function retryJob(client, { organizationId, jobId }) {
  const result = await client.query('select status from import_jobs where organization_id = $1 and id = $2 for update', [organizationId, jobId]);
  if (!result.rows[0]) throw importError('Import isi bulunamadi', 'JOB_NOT_FOUND', 404);
  if (!['completed_with_errors', 'failed'].includes(result.rows[0].status)) {
    throw importError('Yalniz hatali tamamlanan is yeniden denenebilir', 'RETRY_NOT_ALLOWED', 409);
  }
  const rows = await client.query(
    `update import_job_rows set status = 'pending', error_codes = '[]'::jsonb,
      resulting_entity_id = null, locked_at = null, processed_at = null, updated_at = now()
      where organization_id = $1 and import_job_id = $2 and status = 'error' and attempts < 5 returning id`,
    [organizationId, jobId]
  );
  if (!rows.rowCount) throw importError('Yeniden denenebilir hatali satir yok', 'NO_RETRYABLE_ROWS', 409);
  await client.query(
    `update import_jobs set status = 'queued', processed_rows = success_rows, error_rows = 0,
      completed_at = null, updated_at = now() where organization_id = $1 and id = $2`,
    [organizationId, jobId]
  );
  return loadJob(client, organizationId, jobId, { rows: true });
}

async function cancelJob(client, { organizationId, jobId }) {
  const result = await client.query(
    `update import_jobs set status = 'cancelled', cancelled_at = now(), completed_at = now(), updated_at = now()
      where organization_id = $1 and id = $2 and status in ('previewed','queued','processing') returning id`,
    [organizationId, jobId]
  );
  if (!result.rows[0]) throw importError('Import isi bulunamadi veya iptal edilemez', 'CANCEL_NOT_ALLOWED', 409);
  await client.query(
    `update import_job_rows set status = 'cancelled', processed_at = now(), updated_at = now()
      where organization_id = $1 and import_job_id = $2 and status = 'pending'`,
    [organizationId, jobId]
  );
  return loadJob(client, organizationId, jobId, { rows: true });
}

async function listJobs(client, organizationId) {
  const result = await client.query(
    `select id, job_type as type, status, original_filename, total_rows, processed_rows,
      success_rows, error_rows, warnings, started_at, completed_at, created_at
     from import_jobs where organization_id = $1 order by created_at desc limit 200`,
    [organizationId]
  );
  return result.rows;
}

async function errorsCsv(client, organizationId, jobId) {
  const result = await client.query(
    `select row_number, normalized_payload->>'sku' as sku, error_codes
     from import_job_rows where organization_id = $1 and import_job_id = $2 and status = 'error'
     order by row_number`,
    [organizationId, jobId]
  );
  return rowsToCsv(['row_number', 'sku', 'error_codes'], result.rows.map((row) => ({
    row_number: row.row_number, sku: row.sku,
    error_codes: (row.error_codes || []).map((error) => `${error.code}: ${error.message}`).join(' | '),
  })));
}

function templateRows(jobType) {
  if (jobType === 'product_upsert') return [{
    sku: 'SUV-ORNEK-S', name: 'Ornek Urun', description: 'Aciklama', category: 'Elbise',
    collections: 'Yeni|Yaz', price: 1000, sale_price: 900, status: 'draft', color: 'Siyah', size: 'S', stock: 10, image_url: '', image_file: '',
  }];
  if (jobType === 'stock_update') return [{ sku: 'SUV-ORNEK-S', stock: 12, reason: 'Sayim duzeltmesi', expected_version: 0 }];
  return [{ sku: 'SUV-ORNEK-S', price: 1000, sale_price: 900 }];
}

async function templateFile(jobType, format) {
  validateJobType(jobType);
  const columns = JOB_COLUMNS[jobType];
  const rows = templateRows(jobType);
  return format === 'xlsx' ? rowsToXlsx(columns, rows, 'Import Template') : Buffer.from(`\uFEFF${rowsToCsv(columns, rows)}`, 'utf8');
}

async function exportProducts(client, organizationId, format) {
  const result = await client.query(
    `select pv.sku, p.name, p.description, coalesce(c.name, '') as category,
      coalesce(collections.names, '') as collections, p.price, p.sale_price, p.status,
      pv.color, pv.size, pv.available as stock, coalesce(p.images->>0, '') as image_url,
      pv.inventory_version as expected_version
     from products p
     join product_variants pv on pv.organization_id = p.organization_id and pv.product_id = p.id
     left join categories c on c.organization_id = p.organization_id and c.id = p.category_id
     left join lateral (
       select string_agg(co.title, '|' order by co.title) as names
       from product_collections pc join collections co
         on co.organization_id = pc.organization_id and co.id = pc.collection_id
       where pc.organization_id = p.organization_id and pc.product_id = p.id
     ) collections on true
     where p.organization_id = $1 order by p.id, pv.id limit 10000`,
    [organizationId]
  );
  const columns = JOB_COLUMNS.product_upsert;
  return format === 'xlsx' ? rowsToXlsx(columns, result.rows, 'Products') : Buffer.from(`\uFEFF${rowsToCsv(columns, result.rows)}`, 'utf8');
}

module.exports = {
  cancelJob, createPreviewJob, errorsCsv, exportProducts, listJobs, loadJob,
  queueJob, retryJob, sanitizeConfig, templateFile,
};
