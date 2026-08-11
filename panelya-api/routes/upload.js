const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');
const { assertStorageCapacity } = require('../services/planLimits');
const { createObjectStorage } = require('../services/objectStorage');
const {
  MAX_UPLOAD_BYTES,
  detectImageFormat,
  prepareImage,
} = require('../services/mediaPipeline');
const {
  uploadPreparedAsset,
  deleteObjectsBestEffort,
  enqueueCleanupObjects,
} = require('../services/mediaAssets');

const router = express.Router();
const storage = createObjectStorage();
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT || 40),
  message: 'Cok fazla yukleme denemesi. Lutfen daha sonra tekrar deneyin.',
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 5 },
  fileFilter(req, file, cb) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!allowedTypes.has(file.mimetype) || !allowedExtensions.has(extension)) {
      return cb(Object.assign(new Error('Sadece jpg, png veya webp gorsel yuklenebilir'), { status: 400 }));
    }
    cb(null, true);
  },
});

router.post('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), uploadLimiter, upload.array('images', 5), async (req, res, next) => {
  const client = await db.pool.connect();
  let organization = null;
  const uploaded = [];

  try {
    if (!req.files?.length) return res.status(400).json({ error: 'En az bir gorsel zorunlu' });

    await client.query('begin');
    organization = await resolveOrganization(req, client);
    await db.setTenantContext(client, organization.id);

    const preparedFiles = [];
    for (const file of req.files) {
      preparedFiles.push(await prepareImage(file, organization.id));
    }
    const totalIncomingBytes = preparedFiles.reduce(
      (sum, file) => sum + file.variants.reduce((variantSum, variant) => variantSum + variant.byteSize, 0),
      0
    );
    await assertStorageCapacity(client, organization.id, totalIncomingBytes);

    for (const prepared of preparedFiles) {
      const result = await uploadPreparedAsset(client, {
        organizationId: organization.id,
        prepared,
        storage,
        createdBy: req.auth?.actorType === 'app' ? req.auth.sub : null,
      });
      uploaded.push({ result, objectKeys: prepared.variants.map((variant) => variant.objectKey) });
    }

    await client.query('commit');
    const files = uploaded.map(({ result }) => result);
    await auditLog(req, {
      action: 'UPLOAD',
      resourceType: 'media_asset',
      newValue: { organizationId: organization.id, count: files.length, bytes: totalIncomingBytes, files },
    }).catch(() => {});
    res.status(201).json({ files });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    const objectKeys = [
      ...uploaded.flatMap((item) => item.objectKeys),
      ...(error.uploadedObjects || []),
    ];
    const failed = await deleteObjectsBestEffort(storage, objectKeys);
    if (failed.length && organization?.id) {
      await enqueueCleanupObjects({
        organizationId: organization.id,
        assetId: error.assetId || null,
        storage,
        objects: failed,
      }).catch(() => {});
    }
    next(error);
  } finally {
    client.release();
  }
});

router.detectImageFormat = detectImageFormat;
router.storage = storage;

module.exports = router;
