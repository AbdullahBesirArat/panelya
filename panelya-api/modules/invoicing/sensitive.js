const crypto = require('crypto');

function identityKey(env = process.env) {
  const raw = String(env.INVOICE_IDENTITY_ENCRYPTION_KEY || '').trim();
  let key = Buffer.alloc(0);
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else if (raw) key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('Fatura kimlik sifreleme anahtari yapilandirilmamis'), {
    status: 503, code: 'INVOICE_ENCRYPTION_NOT_CONFIGURED',
  });
  return key;
}

function normalizeIdentity(value, kind) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  const expected = kind === 'vkn' ? 10 : 11;
  if (digits.length !== expected || digits.startsWith('0')) {
    throw Object.assign(new Error(`${kind.toUpperCase()} formati gecersiz`), { status: 400, code: 'IDENTITY_FORMAT_INVALID' });
  }
  // No checksum claim is made here: only length, digits and leading-zero format
  // are enforced until an authoritative legal/technical checksum source is adopted.
  return digits;
}

function encryptIdentity(value, kind, env = process.env) {
  const digits = normalizeIdentity(value, kind);
  if (!digits) return { kind: null, last4: null, hash: null, ciphertext: null, validation: 'not_provided' };
  const key = identityKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`panelya-invoice:${kind}`));
  const encrypted = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const hash = crypto.createHmac('sha256', key).update(kind).update('\0').update(digits).digest('hex');
  return {
    kind,
    last4: digits.slice(-4),
    hash,
    ciphertext: `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`,
    validation: 'format_only',
  };
}

function decryptIdentity(ciphertext, kind, env = process.env) {
  if (!ciphertext) return '';
  const [version, ivValue, tagValue, encryptedValue] = String(ciphertext).split(':');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Kimlik sifre metni gecersiz');
  const decipher = crypto.createDecipheriv('aes-256-gcm', identityKey(env), Buffer.from(ivValue, 'base64'));
  decipher.setAAD(Buffer.from(`panelya-invoice:${kind}`));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8');
}

function maskedIdentity(kind, last4) {
  if (!kind || !last4) return '';
  return `${kind.toUpperCase()} ${kind === 'vkn' ? '******' : '*******'}${last4}`;
}

const SENSITIVE_KEYS = /(^|_)(tckn|vkn|tax_number|identity_number|identity_ciphertext|identity_hash)($|_)/i;

function sanitizeInvoiceForLog(value) {
  if (Array.isArray(value)) return value.map(sanitizeInvoiceForLog);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitizeInvoiceForLog(nested),
  ]));
}

module.exports = {
  decryptIdentity,
  encryptIdentity,
  identityKey,
  maskedIdentity,
  normalizeIdentity,
  sanitizeInvoiceForLog,
};

