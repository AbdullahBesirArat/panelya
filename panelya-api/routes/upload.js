const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');
const { resolveUploadDir } = require('../services/uploads');
const { assertStorageCapacity } = require('../services/planLimits');

const router = express.Router();
const uploadDir = resolveUploadDir();
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT || 40),
  message: 'Cok fazla yukleme denemesi. Lutfen daha sonra tekrar deneyin.',
});

fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedTypes.has(file.mimetype) || !allowedExtensions.has(ext)) {
      return cb(Object.assign(new Error('Sadece jpg, png veya webp gorsel yuklenebilir'), { status: 400 }));
    }
    cb(null, true);
  },
});

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (
    buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return 'png';
  }

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

router.post('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), uploadLimiter, upload.array('images', 5), async (req, res, next) => {
  const client = await db.pool.connect();
  const writtenPaths = [];

  try {
    const preparedFiles = [];

    for (const file of req.files || []) {
      const detectedFormat = detectImageFormat(file.buffer);
      if (!detectedFormat) {
        return res.status(400).json({ error: 'Dosya icerigi desteklenen gorsel formati degil' });
      }

      const image = sharp(file.buffer, { failOn: 'error', limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format) || metadata.format !== detectedFormat) {
        return res.status(400).json({ error: 'Gorsel formati desteklenmiyor' });
      }
      if (!metadata.width || !metadata.height || metadata.width > 8000 || metadata.height > 8000) {
        return res.status(400).json({ error: 'Gorsel boyutu desteklenmiyor' });
      }

      const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
      const fullPath = path.join(uploadDir, name);
      const output = await sharp(file.buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
        .resize({ width: 1400, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();

      preparedFiles.push({
        filename: name,
        fullPath,
        output,
        byteSize: output.length,
        url: `/uploads/${name}`,
      });
    }

    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    const totalIncomingBytes = preparedFiles.reduce((sum, file) => sum + file.byteSize, 0);
    await assertStorageCapacity(client, organization.id, totalIncomingBytes);

    for (const file of preparedFiles) {
      await fs.promises.writeFile(file.fullPath, file.output, { flag: 'wx' });
      writtenPaths.push(file.fullPath);
      await client.query(
        `insert into upload_assets
         (organization_id, url, filename, byte_size, mime_type, created_by, data)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          organization.id,
          file.url,
          file.filename,
          file.byteSize,
          'image/webp',
          req.auth?.actorType === 'app' ? req.auth.sub : null,
          file.output,
        ]
      );
    }

    const files = preparedFiles.map((file) => ({ url: file.url }));
    await client.query('commit');
    await auditLog(req, {
      action: 'UPLOAD',
      resourceType: 'upload',
      newValue: {
        organizationId: organization.id,
        count: files.length,
        bytes: totalIncomingBytes,
        files,
      },
    }).catch((error) => {
      console.warn('Upload audit log yazilamadi', { message: error.message });
    });
    res.status(201).json({ files });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    await Promise.all(writtenPaths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
    next(err);
  } finally {
    client.release();
  }
});

router.detectImageFormat = detectImageFormat;

module.exports = router;
