const path = require('path');
const zlib = require('zlib');
const { validateUploadEnvelope } = require('../../services/mediaPipeline');
const { sha256 } = require('./formats');

const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_IMAGES = 100;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_RATIO = 100;
const EXTENSION_MIME = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);

function zipError(message, code = 'INVALID_IMAGE_ZIP') {
  return Object.assign(new Error(message), { code, status: 400 });
}

function safeEntryName(raw) {
  const value = String(raw || '').replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.split('/').includes('..') || value.includes('\u0000')) {
    throw zipError('Gorsel ZIP yolu guvenli degil', 'ZIP_PATH_TRAVERSAL');
  }
  const base = path.posix.basename(value).trim();
  if (!base || base.length > 180) throw zipError('Gorsel dosya adi gecersiz');
  return base;
}

function centralEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ZIP_BYTES || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw zipError('Gorsel ZIP dosya boyutu veya imzasi gecersiz');
  }
  const entries = [];
  let cursor = 0;
  let scanned = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  while ((cursor = buffer.indexOf(signature, cursor)) !== -1) {
    if (cursor + 46 > buffer.length) throw zipError('ZIP merkezi dizini bozuk');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > buffer.length) throw zipError('ZIP girdi adi bozuk');
    const rawName = buffer.toString('utf8', cursor + 46, nameEnd);
    scanned += 1;
    if (scanned > MAX_ENTRIES) throw zipError('ZIP girdi limiti asildi', 'ZIP_ENTRY_LIMIT');
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if ((flags & 0x1) !== 0) throw zipError('Sifreli ZIP girdileri desteklenmez', 'ENCRYPTED_ZIP');
    if (![0, 8].includes(method)) throw zipError('ZIP sikistirma yontemi desteklenmiyor');
    if (uncompressedSize > MAX_IMAGE_BYTES || totalUncompressed > MAX_TOTAL_BYTES
        || (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_RATIO)) {
      throw zipError('ZIP acilmis boyut veya sikistirma orani limitini asiyor', 'ZIP_BOMB');
    }
    if (!rawName.endsWith('/')) entries.push({
      filename: safeEntryName(rawName), flags, method, compressedSize, uncompressedSize, localOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  if (!scanned) throw zipError('ZIP merkezi dizini bulunamadi');
  return entries;
}

function extractEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw zipError('ZIP local header bozuk');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start < 0 || end > buffer.length) throw zipError('ZIP girdi verisi bozuk');
  const compressed = buffer.subarray(start, end);
  let data;
  try { data = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_IMAGE_BYTES }); }
  catch (_) { throw zipError(`Gorsel ZIP girdisi acilamadi: ${entry.filename}`); }
  if (data.length !== entry.uncompressedSize || data.length > MAX_IMAGE_BYTES) throw zipError('ZIP girdi boyutu dogrulanamadi', 'ZIP_BOMB');
  return data;
}

function extractImageZip(buffer) {
  const entries = centralEntries(buffer);
  const images = [];
  const names = new Set();
  for (const entry of entries) {
    const extension = path.extname(entry.filename).toLowerCase();
    const mimetype = EXTENSION_MIME.get(extension);
    if (!mimetype) continue;
    if (images.length >= MAX_IMAGES) throw zipError('ZIP en fazla 100 gorsel icerebilir', 'ZIP_IMAGE_LIMIT');
    const normalizedFilename = entry.filename.toLocaleLowerCase('tr-TR');
    if (names.has(normalizedFilename)) throw zipError(`ZIP icinde yinelenen gorsel adi: ${entry.filename}`, 'DUPLICATE_IMAGE_FILE');
    names.add(normalizedFilename);
    const data = extractEntry(buffer, entry);
    validateUploadEnvelope({ buffer: data, mimetype, originalname: entry.filename });
    images.push({
      originalFilename: entry.filename, normalizedFilename, buffer: data,
      contentType: mimetype, checksum: sha256(data),
    });
  }
  if (!images.length) throw zipError('ZIP icinde desteklenen JPG, PNG veya WebP gorsel bulunamadi');
  return images;
}

module.exports = { centralEntries, extractImageZip, safeEntryName };
