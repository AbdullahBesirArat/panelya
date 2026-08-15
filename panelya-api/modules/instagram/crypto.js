const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { instagramError } = require('./errors');

const VERSION = 'v1';
const PURPOSE = 'instagram_access_token';

function decodeKey(value = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw instagramError(
      'INSTAGRAM_TOKEN_ENCRYPTION_NOT_CONFIGURED',
      503,
      'Instagram baglanti sifrelemesi yapilandirilmamis'
    );
  }
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch (_) { key = null; }
  }
  if (!key || key.length !== 32) {
    throw instagramError(
      'INSTAGRAM_TOKEN_ENCRYPTION_NOT_CONFIGURED',
      503,
      'Instagram baglanti sifreleme anahtari gecersiz'
    );
  }
  return key;
}

function aadFor({ organizationId, connectionId, purpose = PURPOSE }) {
  if (!organizationId || !connectionId || !purpose) {
    throw instagramError('INSTAGRAM_TOKEN_CONTEXT_INVALID', 500, 'Instagram token baglami gecersiz');
  }
  return Buffer.from(`panelya|${VERSION}|${purpose}|${organizationId}|${connectionId}`, 'utf8');
}

function encryptToken(plaintext, context, options = {}) {
  if (!String(plaintext || '')) {
    throw instagramError('INSTAGRAM_TOKEN_INVALID', 400, 'Instagram erisim tokeni bos olamaz');
  }
  const key = decodeKey(options.key);
  const iv = (options.randomBytes || randomBytes)(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(context));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptToken(payload, context, options = {}) {
  const key = decodeKey(options.key);
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw instagramError('INSTAGRAM_TOKEN_DECRYPT_FAILED', 503, 'Instagram baglanti tokeni okunamadi');
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) throw new Error('invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadFor(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    throw instagramError('INSTAGRAM_TOKEN_DECRYPT_FAILED', 503, 'Instagram baglanti tokeni okunamadi');
  }
}

module.exports = { PURPOSE, aadFor, decodeKey, decryptToken, encryptToken };
