const crypto = require('crypto');

// 256 bits of entropy so guest/recovery tokens are unguessable. Raw tokens live
// only in the client cookie / recovery link; the database stores a SHA-256 hash.
const TOKEN_BYTES = 32;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43,86}$/;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function isValidTokenFormat(rawToken) {
  return TOKEN_FORMAT.test(String(rawToken || ''));
}

function hashToken(rawToken) {
  if (!isValidTokenFormat(rawToken)) return null;
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

// Constant-time comparison of two 64-char hex digests.
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  if (bufA.length !== 32 || bufB.length !== 32) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verify a presented raw token against a stored hash without leaking timing.
function verifyToken(rawToken, storedHash) {
  const computed = hashToken(rawToken);
  if (!computed || !storedHash) return false;
  return safeEqualHex(computed, storedHash);
}

module.exports = {
  TOKEN_BYTES,
  generateToken,
  isValidTokenFormat,
  hashToken,
  safeEqualHex,
  verifyToken,
};
