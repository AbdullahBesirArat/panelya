'use strict';

// A29 webhook signing-secret encryption.
//
// This is the one secret in A29 that CANNOT be hashed. The sender has to reproduce the
// exact value on every delivery to compute the HMAC, so it has to be recoverable — which
// makes it categorically different from an API key secret, and is why the two never share
// a storage helper. Confusing them in either direction is a real failure mode: hashing this
// would break signing outright, and storing an API key like this would make a database copy
// enough to authenticate.
//
// The primitive matches the one already approved in this codebase for invoice identities
// (modules/invoicing/sensitive.js): AES-256-GCM, random 12-byte IV, authentication tag
// required. What is NOT shared is the KEY. Reusing INVOICE_IDENTITY_ENCRYPTION_KEY would
// mean one compromised key exposes both tax identities and webhook secrets, and would make
// rotating either one impossible without touching the other. A29 gets its own key name,
// and the AAD binds each ciphertext to its purpose and its endpoint so a value lifted from
// one row cannot be decrypted as another.

const crypto = require('crypto');

const KEY_ENV = 'WEBHOOK_SECRET_ENCRYPTION_KEY';
const SECRET_BYTES = 32;
const CIPHERTEXT_PATTERN = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

function cryptoError(message, code, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function encryptionKey(env = process.env) {
  const raw = String(env[KEY_ENV] || '').trim();
  let key = Buffer.alloc(0);
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else if (raw) key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw cryptoError(
      'Webhook imza anahtari yapilandirilmamis',
      'WEBHOOK_ENCRYPTION_NOT_CONFIGURED', 503
    );
  }
  return key;
}

function isConfigured(env = process.env) {
  try {
    encryptionKey(env);
    return true;
  } catch (_) {
    return false;
  }
}

/** The value a receiver verifies signatures with. Full entropy; never derived from tenant data. */
function generateSigningSecret() {
  return `whsec_${crypto.randomBytes(SECRET_BYTES).toString('base64url')}`;
}

/**
 * Domain separation. The endpoint id is authenticated but not encrypted, so a ciphertext
 * copied onto another endpoint's row fails to decrypt instead of silently signing that
 * endpoint's deliveries with a secret its owner never saw.
 */
function aad(endpointId) {
  return Buffer.from(`panelya-webhook-secret:${endpointId}`);
}

function encryptSecret(secret, { endpointId }, env = process.env) {
  const key = encryptionKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(endpointId));
  const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(ciphertext, { endpointId }, env = process.env) {
  const value = String(ciphertext || '');
  if (!CIPHERTEXT_PATTERN.test(value)) {
    throw cryptoError('Webhook imza anahtari cozulemedi', 'WEBHOOK_SECRET_UNREADABLE', 500);
  }
  const key = encryptionKey(env);
  const [, ivPart, tagPart, dataPart] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
    decipher.setAAD(aad(endpointId));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (_) {
    // A failed tag check means the row was tampered with, the key changed, or the
    // ciphertext belongs to another endpoint. None of those should say which.
    throw cryptoError('Webhook imza anahtari cozulemedi', 'WEBHOOK_SECRET_UNREADABLE', 500);
  }
}

module.exports = {
  KEY_ENV,
  CIPHERTEXT_PATTERN,
  decryptSecret,
  encryptSecret,
  generateSigningSecret,
  isConfigured,
};
