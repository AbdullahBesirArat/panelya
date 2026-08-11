'use strict';

// A30 MFA secret encryption and recovery-code hashing.
//
// The two live together because they are constantly confused, and the distinction is the
// whole point:
//
//   * A TOTP secret is ENCRYPTED. Verification recomputes the expected code from the shared
//     secret, so the server must be able to read it back. Hashing it would make TOTP
//     impossible, not more secure.
//   * A recovery code is HASHED. The server only ever checks a presented code against a
//     stored digest and never needs the original again — exactly like an API key secret.
//
// The encryption key is its own, `MFA_SECRET_ENCRYPTION_KEY`. Reusing A29's webhook key or
// the invoice identity key would mean one compromise exposes MFA seeds too, and would make
// rotating any of them impossible without touching the others.

const crypto = require('crypto');

const KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY';
const ENCRYPTION_VERSION = 1;
const CIPHERTEXT_PATTERN = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
// 10 characters of Crockford-ish base32 ≈ 50 bits. Long enough that guessing is hopeless,
// short enough that somebody can type it off a printout under stress.
const RECOVERY_CODE_GROUPS = 2;
const RECOVERY_CODE_GROUP_LENGTH = 5;
const RECOVERY_CODE_COUNT = 10;
// No I, L, O, U: the characters people misread on paper, and the one that forms words.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function cryptoError(message, code, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function encryptionKey(env = process.env) {
  const raw = String(env[KEY_ENV] || '').trim();
  let key = Buffer.alloc(0);
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else if (raw) key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw cryptoError('MFA sifreleme anahtari yapilandirilmamis', 'MFA_ENCRYPTION_NOT_CONFIGURED', 503);
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

/**
 * Domain separation. The owner is authenticated but not encrypted, so a ciphertext copied
 * onto another account's row fails to decrypt instead of silently becoming that person's
 * second factor.
 */
function aad({ actorType, ownerId, purpose = 'totp' }) {
  return Buffer.from(`panelya-mfa:${purpose}:${actorType}:${ownerId}`);
}

function encryptSecret(secret, context, env = process.env) {
  const key = encryptionKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context));
  const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${ENCRYPTION_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(ciphertext, context, env = process.env) {
  const value = String(ciphertext || '');
  if (!CIPHERTEXT_PATTERN.test(value)) {
    throw cryptoError('MFA anahtari cozulemedi', 'MFA_SECRET_UNREADABLE', 500);
  }
  const key = encryptionKey(env);
  const [, ivPart, tagPart, dataPart] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    // Tampering, a rotated key and a ciphertext from another account all land here, and
    // none of them should be distinguishable from the outside.
    throw cryptoError('MFA anahtari cozulemedi', 'MFA_SECRET_UNREADABLE', 500);
  }
}

// --- recovery codes --------------------------------------------------------------------

/** Uniform over the alphabet via rejection sampling; `% length` would bias the low letters. */
function randomCharacters(count) {
  const out = [];
  while (out.length < count) {
    const bytes = crypto.randomBytes(count * 2);
    for (const byte of bytes) {
      if (out.length >= count) break;
      const limit = 256 - (256 % RECOVERY_ALPHABET.length);
      if (byte >= limit) continue;
      out.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
    }
  }
  return out.join('');
}

function generateRecoveryCode() {
  const groups = [];
  for (let index = 0; index < RECOVERY_CODE_GROUPS; index += 1) {
    groups.push(randomCharacters(RECOVERY_CODE_GROUP_LENGTH));
  }
  return groups.join('-');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/**
 * Normalises what a person actually types: lowercase, missing dashes, stray spaces. Without
 * this, a valid code typed without its dash would be rejected and the user would burn
 * another one.
 */
function normalizeRecoveryCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

module.exports = {
  ENCRYPTION_VERSION,
  KEY_ENV,
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  isConfigured,
  normalizeRecoveryCode,
};
