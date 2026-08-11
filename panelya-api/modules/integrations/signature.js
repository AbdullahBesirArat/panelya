'use strict';

// A29 webhook signatures.
//
// One module, one canonical algorithm, used by BOTH the sender and the verification helper
// we hand to receivers. Two implementations of "what gets signed" is the classic way this
// breaks: the sender signs a re-serialized object, the receiver verifies the bytes it got,
// and every signature fails for reasons nobody can reproduce.
//
// The canonical signing input is:
//
//     <timestamp> "." <raw body bytes>
//
// The timestamp is inside the signed material, so it cannot be edited to widen a replay
// window without invalidating the signature. The body is signed as BYTES: the caller
// serializes once, signs those exact bytes, and sends those exact bytes.

const crypto = require('crypto');

const SIGNATURE_VERSION = 'v1';
const HEADERS = Object.freeze({
  eventId: 'x-panelya-event-id',
  eventType: 'x-panelya-event-type',
  timestamp: 'x-panelya-timestamp',
  signature: 'x-panelya-signature',
  secretVersion: 'x-panelya-secret-version',
  delivery: 'x-panelya-delivery-id',
});

// How far apart the sender's and receiver's clocks may be before a delivery is refused.
// Applied in both directions: an old request is a replay, a far-future one is a clock the
// receiver has no reason to trust.
const DEFAULT_TOLERANCE_SECONDS = 300;

function canonicalPayload(timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
}

/** Produces `v1=<hex>`. Versioned so a future algorithm can coexist during a migration. */
function signPayload({ secret, timestamp, rawBody }) {
  const mac = crypto.createHmac('sha256', String(secret))
    .update(canonicalPayload(timestamp, rawBody))
    .digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

function parseSignatureHeader(header) {
  const raw = String(header || '').trim();
  if (!raw || raw.length > 400) return [];
  // A header may carry several signatures (during a secret rotation); each is `vN=value`.
  return raw.split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION}=`))
    .map((part) => part.slice(SIGNATURE_VERSION.length + 1))
    .filter((value) => /^[0-9a-f]{64}$/.test(value));
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, and a thrown exception is itself a timing
  // and control-flow oracle — so length is checked first and answered as a plain false.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * The helper a receiver runs. Returns a reason code rather than throwing, because a webhook
 * endpoint that throws on malformed input is a denial-of-service surface.
 *
 * `secrets` accepts several values so a receiver can accept both sides of a rotation.
 */
function verifySignature({
  secret,
  secrets,
  timestamp,
  rawBody,
  signature,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Date.now(),
}) {
  const candidates = (Array.isArray(secrets) ? secrets : [secret]).filter(Boolean);
  if (!candidates.length) return { valid: false, reason: 'NO_SECRET' };

  const parsedTimestamp = Number(timestamp);
  if (!Number.isInteger(parsedTimestamp) || parsedTimestamp <= 0) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' };
  }
  const ageSeconds = Math.floor(now / 1000) - parsedTimestamp;
  if (ageSeconds > toleranceSeconds) return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
  if (ageSeconds < -toleranceSeconds) return { valid: false, reason: 'TIMESTAMP_IN_FUTURE' };

  const presented = parseSignatureHeader(signature);
  if (!presented.length) return { valid: false, reason: 'MALFORMED_SIGNATURE' };

  for (const candidate of candidates) {
    const expected = signPayload({ secret: candidate, timestamp: parsedTimestamp, rawBody });
    const expectedValue = expected.slice(SIGNATURE_VERSION.length + 1);
    // Every presented signature is compared against every candidate secret; the loop does
    // not short-circuit on a mismatch, only on a match.
    for (const value of presented) {
      if (constantTimeEquals(expectedValue, value)) return { valid: true, reason: 'OK' };
    }
  }
  return { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

module.exports = {
  DEFAULT_TOLERANCE_SECONDS,
  HEADERS,
  SIGNATURE_VERSION,
  canonicalPayload,
  constantTimeEquals,
  parseSignatureHeader,
  signPayload,
  verifySignature,
};
