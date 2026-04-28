const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const { resolveUploadDir } = require('../services/uploads');

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
  try {
    const files = [];

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

      await image
        .resize({ width: 1400, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(fullPath);

      files.push({ url: `/uploads/${name}` });
    }

    await auditLog(req, {
      action: 'UPLOAD',
      resourceType: 'upload',
      newValue: { count: files.length, files },
    });
    res.status(201).json({ files });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
