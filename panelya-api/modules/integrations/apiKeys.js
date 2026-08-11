'use strict';

// A29 API key material.
//
// The key a caller holds is `pk_<prefix>.<secret>`:
//
//   * the PREFIX is public. It exists so authentication can fetch exactly one candidate row
//     instead of hashing the presented secret against every key in the platform.
//   * the SECRET is 32 random bytes. Only its sha256 is stored, so a database copy cannot
//     be turned back into working credentials.
//
// Because the secret is full-entropy random rather than a human-chosen password, a plain
// sha256 is the right primitive here: there is nothing to brute force, and a slow KDF would
// only add latency to every API request. This is the same reasoning (and the same shape) as
// the cart, account and preview tokens already in this codebase — it is emphatically NOT
// how a password is stored.
//
// Nothing here reads the database or the clock; that keeps it trivially testable and keeps
// policy decisions (expiry, overlap, scope) in one place in service.js.

const crypto = require('crypto');

const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;
const PREFIX_PATTERN = /^pk_[a-z0-9]{12}$/;
// The secret is base64url of 32 bytes: 43 characters, no padding.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function generatePrefix() {
  return `pk_${crypto.randomBytes(PREFIX_BYTES).toString('hex')}`;
}

function generateSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/** Mints a brand new credential. The raw value is returned once and never stored. */
function generateApiKey() {
  const prefix = generatePrefix();
  const secret = generateSecret();
  return { prefix, secret, token: `${prefix}.${secret}`, secretHash: hashSecret(secret) };
}

/**
 * Splits a presented credential without touching the database. Returns null for anything
 * malformed, so a caller cannot use the shape of the error to learn whether a prefix exists.
 */
function parseApiKey(token) {
  const raw = String(token == null ? '' : token).trim();
  if (!raw || raw.length > 200) return null;
  const separator = raw.indexOf('.');
  if (separator < 0) return null;
  const prefix = raw.slice(0, separator);
  const secret = raw.slice(separator + 1);
  if (!PREFIX_PATTERN.test(prefix) || !SECRET_PATTERN.test(secret)) return null;
  return { prefix, secret };
}

/**
 * Constant-time comparison of the presented secret against a stored hash. Both sides are
 * fixed-length hex here, but the length guard stays: timingSafeEqual throws on a length
 * mismatch, and an exception would itself be an oracle.
 */
function verifySecret(secret, storedHash) {
  const expected = String(storedHash || '');
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const presented = hashSecret(secret);
  const a = Buffer.from(presented, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** What may be shown in a list or a log: the public half, never the secret. */
function maskToken(token) {
  const parsed = parseApiKey(token);
  if (!parsed) return '';
  return `${parsed.prefix}.****`;
}

module.exports = {
  PREFIX_PATTERN,
  SECRET_PATTERN,
  generateApiKey,
  generateSecret,
  hashSecret,
  maskToken,
  parseApiKey,
  verifySecret,
};
