const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { createObjectStorage } = require('../services/objectStorage');
const { MAX_FILE_BYTES } = require('../modules/imports/formats');
const {
  cancelJob, createPreviewJob, errorsCsv, exportProducts, listJobs, loadJob,
  queueJob, retryJob, templateFile,
} = require('../modules/imports/service');
const { scheduleImportWorker } = require('../modules/imports/worker');

const router = express.Router();
const storage = createObjectStorage();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 2, fileSize: MAX_FILE_BYTES, fields: 8 } });
const previewFiles = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'images', maxCount: 1 }]);

function jobId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID.test(id)) throw Object.assign(new Error('Import isi id gecersiz'), { status: 400, code: 'INVALID_JOB_ID' });
  return id;
}

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); }
  catch (_) { throw Object.assign(new Error('Import config JSON gecersiz'), { status: 400, code: 'INVALID_CONFIG' }); }
}

function downloadHeaders(res, filename, format) {
  res.setHeader('Content-Type', format === 'xlsx'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.${format}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

router.get('/template.:format', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const format = String(req.params.format).toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) return res.status(404).json({ error: 'Format bulunamadi' });
    const type = String(req.query.type || 'product_upsert');
    const body = await templateFile(type, format);
    downloadHeaders(res, `${type}-template`, format);
    res.send(body);
  } catch (error) { next(error); }
});

router.get('/export.:format', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const format = String(req.params.format).toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) return res.status(404).json({ error: 'Format bulunamadi' });
    const organization = await resolveOrganization(req);
    const body = await exportProducts(db, organization.id, format);
    downloadHeaders(res, 'products-export', format);
    res.send(body);
  } catch (error) { next(error); }
});

router.post('/preview', requireAuth, requireRole(WRITE_ROLES), previewFiles, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const job = await createPreviewJob(db, {
      organizationId: organization.id,
      file: req.files?.file?.[0],
      imagesFile: req.files?.images?.[0],
      jobType: String(req.body.type || ''),
      config: parseConfig(req.body.config),
      idempotencyKey: req.body.idempotency_key || req.get('idempotency-key'),
      createdBy: req.auth?.actorType === 'app' ? req.auth.sub : null,
      storage,
    });
    res.status(201).json(job);
  } catch (error) { next(error); }
});

router.get('/', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json(await listJobs(db, organization.id));
  } catch (error) { next(error); }
});

router.get('/:id/errors.csv', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const id = jobId(req.params.id);
    const existing = await loadJob(db, organization.id, id);
    if (!existing) return res.status(404).json({ error: 'Import isi bulunamadi' });
    downloadHeaders(res, `import-${id}-errors`, 'csv');
    res.send(`\uFEFF${await errorsCsv(db, organization.id, id)}`);
  } catch (error) { next(error); }
});

router.get('/:id', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const job = await loadJob(db, organization.id, jobId(req.params.id), { rows: true });
    if (!job) return res.status(404).json({ error: 'Import isi bulunamadi' });
    res.json(job);
  } catch (error) { next(error); }
});

router.post('/:id/apply', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const job = await queueJob(db, { organizationId: organization.id, jobId: jobId(req.params.id), storage });
    scheduleImportWorker();
    res.status(202).json(job);
  } catch (error) { next(error); }
});

router.post('/:id/retry', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const job = await retryJob(db, { organizationId: organization.id, jobId: jobId(req.params.id) });
    scheduleImportWorker();
    res.status(202).json(job);
  } catch (error) { next(error); }
});

router.post('/:id/cancel', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json(await cancelJob(db, { organizationId: organization.id, jobId: jobId(req.params.id) }));
  } catch (error) { next(error); }
});

router.use((error, req, res, next) => {
  if (error?.code === 'LIMIT_FILE_SIZE') {
    error.status = 413;
    error.message = 'Import dosyasi 10 MB limitini asiyor';
    error.code = 'FILE_SIZE_LIMIT';
  }
  next(error);
});

module.exports = router;
