const crypto = require('node:crypto');

// Idempotency-key handling for checkout creation (POST /orders and POST /payment/initialize).
//
// A key alone only proves "the client intends the same operation". The database replays the
// stored order for (organization, key), so without a request fingerprint a retry that carries
// the same key but DIFFERENT checkout details (coupon, note, invoice, items...) would be
// answered with the stale order. Every created order therefore stores a fingerprint of the
// request that created it, and a replay is only honoured when the incoming request matches.

const FINGERPRINT_VERSION = 'v1';
const SCOPES = Object.freeze({ orders: 'orders', paymentInitialize: 'payment-initialize' });
const IDEMPOTENCY_BODY_FIELDS = new Set(['idempotencyKey', 'idempotency_key']);

function checkoutIdempotencyKey(req) {
  const value = String(req.get?.('idempotency-key') || req.body?.idempotencyKey || req.body?.idempotency_key || '').trim();
  if (!value) return null;
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw Object.assign(new Error('Checkout idempotency anahtari gecersiz'), { status: 400 });
  }
  return value;
}

// Deterministic, semantics-preserving encoding of a request value:
//  - object keys are sorted; null/undefined/'' are treated as "not provided"
//  - strings are NFC-normalised and trimmed
//  - numbers are encoded canonically (no 49.90 vs 49.9 difference)
//  - `items` is order-insensitive (the same lines in another order are the same order)
function canonicalValue(value, path = '') {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const text = value.normalize('NFC').trim();
    return text === '' ? undefined : text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalValue(entry, `${path}[]`)).filter((entry) => entry !== undefined);
    if (path === 'items') entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return entries;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const name of Object.keys(value).sort()) {
      const child = canonicalValue(value[name], path ? `${path}.${name}` : name);
      if (child !== undefined) out[name] = child;
    }
    return out;
  }
  return String(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The fingerprint is bound to the tenant, the endpoint namespace and the key itself, so the
// same body under another key/route/tenant never collides. It is a one-way digest: the raw
// payload is never stored for this purpose.
function checkoutRequestFingerprint({ organizationId, scope, key, body }) {
  if (!key) return null;
  if (!Object.values(SCOPES).includes(scope)) throw new Error('Unknown checkout idempotency scope');
  const material = {};
  for (const name of Object.keys(body || {})) {
    if (!IDEMPOTENCY_BODY_FIELDS.has(name)) material[name] = body[name];
  }
  const digest = crypto.createHash('sha256')
    .update([FINGERPRINT_VERSION, scope, organizationId, key, canonicalJson(canonicalValue(material) || {})].join('\n'))
    .digest('hex');
  return `${FINGERPRINT_VERSION}:${digest}`;
}

function idempotencyConflict() {
  return Object.assign(
    new Error('Bu islem anahtari farkli bir siparis istegiyle daha once kullanildi. Lutfen sayfayi yenileyip tekrar deneyin.'),
    { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }
  );
}

// Strips the internal fingerprint column from a stored order (it must never reach a client)
// and refuses the replay when the stored fingerprint does not match the incoming request.
// Orders created before the fingerprint existed have none: they keep the historical
// replay behaviour (see docs), because equivalence cannot be proven and refusing would strand
// a client that legitimately retries with a persisted key.
function assertReplayMatches(replay, expectedFingerprint) {
  if (!replay) return replay;
  const stored = replay.checkout_request_fingerprint;
  delete replay.checkout_request_fingerprint;
  if (stored && expectedFingerprint && stored !== expectedFingerprint) throw idempotencyConflict();
  return replay;
}

async function findCheckoutReplay(client, organizationId, key) {
  if (!key) return null;
  const result = await client.query(
    `select orders.*, reservation.id as reservation_id,
            reservation.status as reservation_status,
            reservation.expires_at as reservation_expires_at,
            now() as server_time
       from orders
       left join inventory_reservations reservation
         on reservation.organization_id = orders.organization_id
        and reservation.order_id = orders.id
      where orders.organization_id = $1 and orders.checkout_idempotency_key = $2
      limit 1`,
    [organizationId, key]
  );
  return result.rows[0] || null;
}

module.exports = {
  SCOPES,
  checkoutIdempotencyKey,
  checkoutRequestFingerprint,
  assertReplayMatches,
  findCheckoutReplay,
};
