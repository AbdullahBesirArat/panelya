const { createHash, randomUUID } = require('crypto');
const path = require('path');
const sharp = require('sharp');
const { assertObjectKey } = require('./objectStorage');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 8000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VARIANT_SPECS = [
  { name: 'thumbnail', width: 320, quality: 76 },
  { name: 'card', width: 800, quality: 80 },
  { name: 'detail', width: 1600, quality: 84 },
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sanitizeOriginalFilename(value) {
  const base = path.basename(String(value || 'image')).normalize('NFKC');
  return base
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'image';
}

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function validateUploadEnvelope(file) {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  if (!ALLOWED_MIME.has(file?.mimetype) || !ALLOWED_EXTENSIONS.has(extension)) {
    throw Object.assign(new Error('Sadece jpg, png veya webp gorsel yuklenebilir'), { status: 400 });
  }
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('Gorsel dosya boyutu desteklenmiyor'), { status: 400 });
  }
  const detected = detectImageFormat(file.buffer);
  const expected = file.mimetype === 'image/jpeg' ? 'jpeg' : file.mimetype.split('/')[1];
  if (!detected || detected !== expected) {
    throw Object.assign(new Error('Dosya icerigi bildirilen gorsel formatiyla uyusmuyor'), { status: 400 });
  }
  return detected;
}

async function prepareImage(file, organizationId, { assetId = randomUUID() } = {}) {
  const detected = validateUploadEnvelope(file);
  let metadata;
  try {
    metadata = await sharp(file.buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    throw Object.assign(new Error('Gorsel bozuk veya guvenli piksel limitini asiyor'), { status: 400, cause: error });
  }
  if (metadata.format !== detected || !metadata.width || !metadata.height) {
    throw Object.assign(new Error('Gorsel formati desteklenmiyor'), { status: 400 });
  }
  if (metadata.width > MAX_EDGE || metadata.height > MAX_EDGE || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw Object.assign(new Error('Gorsel piksel boyutu desteklenmiyor'), { status: 400 });
  }

  const sourceChecksum = sha256(file.buffer);
  const variants = [];
  for (const spec of VARIANT_SPECS) {
    const { data, info } = await sharp(file.buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .toColourspace('srgb')
      .resize({ width: spec.width, withoutEnlargement: true })
      .webp({ quality: spec.quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const checksum = sha256(data);
    const objectKey = `tenants/${String(organizationId).toLowerCase()}/media/${assetId}/${spec.name}-${checksum.slice(0, 16)}.webp`;
    assertObjectKey(objectKey, organizationId);
    variants.push({
      name: spec.name,
      objectKey,
      data,
      contentType: 'image/webp',
      byteSize: data.length,
      width: info.width,
      height: info.height,
      checksum,
    });
  }

  return {
    assetId,
    originalFilename: sanitizeOriginalFilename(file.originalname),
    sourceChecksum,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    variants,
  };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_INPUT_PIXELS,
  VARIANT_SPECS,
  detectImageFormat,
  sanitizeOriginalFilename,
  validateUploadEnvelope,
  prepareImage,
  sha256,
};
