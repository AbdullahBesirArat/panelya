'use strict';

// A29 integration platform service.
//
// Every write to an API key or a webhook endpoint goes through here, from both the tenant
// admin routes and the external /v1 routes, so the two surfaces cannot drift into having
// different rules about what a rotation or a revocation means.

const crypto = require('crypto');
const apiKeys = require('./apiKeys');
const { normalizeScopes } = require('./scopes');
const { normalizeAllowlist, isAllowed } = require('./ipAllowlist');
const { normalizeEventTypes } = require('./events');
const { validateWebhookUrl } = require('./webhookUrl');
const secretCrypto = require('./secretCrypto');
const planLimits = require('../../services/planLimits');

// How long a rotated key keeps working. Long enough to deploy, short enough that a leaked
// old secret is not a standing liability.
const DEFAULT_OVERLAP_MINUTES = Number(process.env.API_KEY_ROTATION_OVERLAP_MINUTES || 60);
const IDEMPOTENCY_TTL_HOURS = 24;

function integrationError(message, code, status = 400, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

// ---------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------

/** The public shape. There is no code path that adds a secret to this. */
function publicKey(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes || [],
    status: row.status,
    ip_allowlist: row.ip_allowlist || [],
    expires_at: row.expires_at,
    overlap_until: row.overlap_until,
    rotated_from_id: row.rotated_from_id ? Number(row.rotated_from_id) : null,
    rotation_group_id: row.rotation_group_id,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listApiKeys(client, { organizationId, limit = 100 }) {
  const result = await client.query(
    `select * from api_keys where organization_id = $1
      order by created_at desc, id desc limit $2`,
    [organizationId, Math.min(Math.max(Number(limit) || 100, 1), 200)]
  );
  return result.rows.map(publicKey);
}

async function loadApiKey(client, organizationId, keyId) {
  const result = await client.query(
    'select * from api_keys where organization_id = $1 and id = $2',
    [organizationId, Number(keyId)]
  );
  if (!result.rows[0]) throw integrationError('API anahtari bulunamadi', 'API_KEY_NOT_FOUND', 404);
  return result.rows[0];
}

function parseExpiry(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw integrationError('Gecerlilik tarihi gecersiz', 'API_KEY_EXPIRY_INVALID', 400);
  }
  if (date.getTime() <= Date.now()) {
    throw integrationError('Gecerlilik tarihi gelecekte olmali', 'API_KEY_EXPIRY_PAST', 400);
  }
  return date.toISOString();
}

/** The secret is in the return value and nowhere else — not in the row, not in the audit. */
async function createApiKey(client, { organizationId, name, scopes, ipAllowlist, expiresAt, actorId = null }) {
  const label = String(name || '').trim().slice(0, 120);
  if (!label) throw integrationError('Anahtar adi zorunlu', 'API_KEY_NAME_REQUIRED', 400);
  const normalizedScopes = normalizeScopes(scopes);
  const allowlist = normalizeAllowlist(ipAllowlist);
  const expiry = parseExpiry(expiresAt);

  await planLimits.assertPlanCapacity(client, organizationId, 'api_keys');

  const material = apiKeys.generateApiKey();
  const inserted = await client.query(
    `insert into api_keys
       (organization_id, name, prefix, secret_hash, scopes, ip_allowlist, expires_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [organizationId, label, material.prefix, material.secretHash, normalizedScopes, allowlist, expiry, actorId]
  );
  return { key: publicKey(inserted.rows[0]), token: material.token };
}

/**
 * Rotation: a NEW row with a new secret, and the old row kept valid until overlap_until.
 *
 * The old key is not revoked here. Revoking it immediately is the thing rotation exists to
 * avoid — the caller has to deploy the new secret, and until they have, their integration
 * has to keep working. Expiry of the overlap is enforced at authentication, so no job needs
 * to run for the old key to stop working on time.
 */
async function rotateApiKey(client, { organizationId, keyId, overlapMinutes, actorId = null }) {
  const existing = await loadApiKey(client, organizationId, keyId);
  if (existing.status !== 'active') {
    throw integrationError('Iptal edilmis anahtar dondurulemez', 'API_KEY_NOT_ACTIVE', 409);
  }
  // Serialised per tenant so two concurrent rotations of the same key cannot both produce a
  // successor; the loser sees the winner's overlap already set and stops.
  await client.query(
    `select pg_advisory_xact_lock(
       ('x' || substr(md5($1::text), 1, 8))::bit(32)::int,
       ('x' || substr(md5($2::text), 1, 8))::bit(32)::int)`,
    [String(organizationId), `api_key_rotation:${existing.rotation_group_id}`]
  );
  const reread = await loadApiKey(client, organizationId, keyId);
  if (reread.overlap_until || reread.status !== 'active') {
    throw integrationError('Bu anahtar zaten dondurulmus', 'API_KEY_ALREADY_ROTATED', 409);
  }

  const minutes = Math.min(Math.max(Number(overlapMinutes) || DEFAULT_OVERLAP_MINUTES, 0), 60 * 24 * 7);
  const material = apiKeys.generateApiKey();
  const created = await client.query(
    `insert into api_keys
       (organization_id, name, prefix, secret_hash, scopes, ip_allowlist, expires_at,
        rotation_group_id, rotated_from_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [
      organizationId, reread.name, material.prefix, material.secretHash, reread.scopes,
      reread.ip_allowlist, reread.expires_at, reread.rotation_group_id, reread.id, actorId,
    ]
  );
  await client.query(
    `update api_keys set overlap_until = now() + make_interval(mins => $3), updated_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, reread.id, minutes]
  );
  const previous = await loadApiKey(client, organizationId, keyId);
  return {
    key: publicKey(created.rows[0]),
    token: material.token,
    previous: publicKey(previous),
    overlapMinutes: minutes,
  };
}

/** Idempotent: revoking an already-revoked key is a success, not a 409. */
async function revokeApiKey(client, { organizationId, keyId, actorId = null }) {
  const existing = await loadApiKey(client, organizationId, keyId);
  if (existing.status === 'revoked') return { key: publicKey(existing), alreadyRevoked: true };
  const updated = await client.query(
    `update api_keys
        set status = 'revoked', revoked_at = now(), revoked_by = $3, overlap_until = null, updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, Number(keyId), actorId]
  );
  return { key: publicKey(updated.rows[0]), alreadyRevoked: false };
}

/**
 * Authenticates a presented credential. Runs with the SYSTEM connection because the tenant
 * is not known until the key row is found — which is the whole point: the organization
 * comes from the key, never from a header the caller controls.
 *
 * Every rejection returns the same generic outcome shape so a caller cannot distinguish
 * "no such prefix" from "wrong secret" from "revoked".
 */
async function authenticateApiKey(systemClient, { token, clientIp, now = new Date() }) {
  const parsed = apiKeys.parseApiKey(token);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };

  const result = await systemClient.query(
    'select * from api_keys where prefix = $1 limit 1',
    [parsed.prefix]
  );
  const row = result.rows[0];
  // Still hash the presented secret when no row matched, so a nonexistent prefix costs the
  // same work as a wrong secret.
  if (!row) {
    apiKeys.hashSecret(parsed.secret);
    return { ok: false, reason: 'UNKNOWN_KEY' };
  }
  if (!apiKeys.verifySecret(parsed.secret, row.secret_hash)) return { ok: false, reason: 'BAD_SECRET' };
  if (row.status !== 'active') return { ok: false, reason: 'REVOKED' };

  const instant = now instanceof Date ? now : new Date(now);
  if (row.expires_at && new Date(row.expires_at).getTime() <= instant.getTime()) {
    return { ok: false, reason: 'EXPIRED' };
  }
  // The rotation grace period, enforced here rather than by a job: the moment it passes,
  // the old secret stops working even though nothing has run.
  if (row.overlap_until && new Date(row.overlap_until).getTime() <= instant.getTime()) {
    return { ok: false, reason: 'ROTATION_OVERLAP_ENDED' };
  }
  if (!isAllowed(row.ip_allowlist, clientIp)) return { ok: false, reason: 'IP_NOT_ALLOWED' };

  return {
    ok: true,
    key: {
      id: Number(row.id),
      organizationId: row.organization_id,
      prefix: row.prefix,
      scopes: row.scopes || [],
      name: row.name,
    },
  };
}

/**
 * last_used_at, throttled. Every request writing to the same row would make one hot row per
 * key the bottleneck of the whole external API, and the value is only ever read by a human
 * deciding whether a key is still in use — minute precision is more than enough.
 */
async function touchApiKey(systemClient, keyId) {
  await systemClient.query(
    `update api_keys set last_used_at = now()
      where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [Number(keyId)]
  );
}

// ---------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Canonical hash of a request body. Keys are sorted recursively so a client that serializes
 * its JSON in a different order is not told its retry is a different request.
 */
function requestFingerprint(body) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = canonical(value[key]);
        return acc;
      }, {});
    }
    return value;
  };
  return hashValue(JSON.stringify(canonical(body ?? null)));
}

/**
 * Claims an idempotency key, or reports what to do instead.
 *
 * `claimed` -> run the operation. `replay` -> return the stored response.
 * `conflict` -> the same key was used with a different body, which is a client bug we
 * refuse rather than paper over. `in_progress` -> a concurrent request holds the claim.
 */
async function claimIdempotency(client, { organizationId, apiKeyId, key, method, route, body }) {
  const keyHash = hashValue(key);
  const requestHash = requestFingerprint(body);
  const expiresAt = new Date(Date.now() + (IDEMPOTENCY_TTL_HOURS * 3600 * 1000)).toISOString();

  const inserted = await client.query(
    `insert into api_idempotency_keys
       (organization_id, api_key_id, idempotency_key_hash, method, route, request_hash, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (organization_id, idempotency_key_hash, method, route) do nothing
     returning *`,
    [organizationId, apiKeyId, keyHash, method, route, requestHash, expiresAt]
  );
  if (inserted.rows[0]) return { state: 'claimed', record: inserted.rows[0] };

  const existing = await client.query(
    `select * from api_idempotency_keys
      where organization_id = $1 and idempotency_key_hash = $2 and method = $3 and route = $4`,
    [organizationId, keyHash, method, route]
  );
  const record = existing.rows[0];
  if (!record) return { state: 'claimed', record: null };
  if (record.request_hash !== requestHash) {
    return { state: 'conflict', record };
  }
  if (record.status === 'completed') return { state: 'replay', record };
  return { state: 'in_progress', record };
}

async function completeIdempotency(client, { organizationId, recordId, responseStatus, responseBody }) {
  await client.query(
    `update api_idempotency_keys
        set status = 'completed', response_status = $3, response_body = $4::jsonb,
            completed_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, Number(recordId), Number(responseStatus), JSON.stringify(responseBody ?? null)]
  );
}

/** A failed operation must not leave a claim that would replay its failure forever. */
async function releaseIdempotency(client, { organizationId, recordId }) {
  await client.query(
    'delete from api_idempotency_keys where organization_id = $1 and id = $2 and status = $3',
    [organizationId, Number(recordId), 'in_progress']
  );
}

// ---------------------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------------------

function publicEndpoint(row, eventTypes = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    url: row.url,
    status: row.status,
    events: eventTypes,
    consecutive_failures: Number(row.consecutive_failures || 0),
    disabled_at: row.disabled_at,
    disabled_reason: row.disabled_reason,
    // The version number is safe to show; the ciphertext, the IV and the tag are not, and
    // are never selected into this shape.
    secret_version: row.secret_version == null ? null : Number(row.secret_version),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function endpointEventTypes(client, organizationId, endpointId) {
  const result = await client.query(
    `select event_type from webhook_endpoint_events
      where organization_id = $1 and endpoint_id = $2 order by event_type`,
    [organizationId, Number(endpointId)]
  );
  return result.rows.map((row) => row.event_type);
}

async function listWebhookEndpoints(client, { organizationId }) {
  const result = await client.query(
    `select e.*, s.version as secret_version
       from webhook_endpoints e
       left join webhook_endpoint_secrets s
         on s.organization_id = e.organization_id and s.endpoint_id = e.id and s.status = 'current'
      where e.organization_id = $1 and e.status <> 'archived'
      order by e.created_at desc, e.id desc`,
    [organizationId]
  );
  const endpoints = [];
  for (const row of result.rows) {
    endpoints.push(publicEndpoint(row, await endpointEventTypes(client, organizationId, row.id)));
  }
  return endpoints;
}

async function loadEndpoint(client, organizationId, endpointId) {
  const result = await client.query(
    `select e.*, s.version as secret_version
       from webhook_endpoints e
       left join webhook_endpoint_secrets s
         on s.organization_id = e.organization_id and s.endpoint_id = e.id and s.status = 'current'
      where e.organization_id = $1 and e.id = $2`,
    [organizationId, Number(endpointId)]
  );
  if (!result.rows[0]) throw integrationError('Webhook bulunamadi', 'WEBHOOK_NOT_FOUND', 404);
  return result.rows[0];
}

async function replaceSubscriptions(client, { organizationId, endpointId, events }) {
  const eventTypes = normalizeEventTypes(events);
  await client.query(
    'delete from webhook_endpoint_events where organization_id = $1 and endpoint_id = $2',
    [organizationId, Number(endpointId)]
  );
  for (const eventType of eventTypes) {
    await client.query(
      `insert into webhook_endpoint_events (organization_id, endpoint_id, event_type)
       values ($1,$2,$3) on conflict do nothing`,
      [organizationId, Number(endpointId), eventType]
    );
  }
  return eventTypes;
}

async function issueSigningSecret(client, { organizationId, endpointId, retireCurrentAfterMinutes = null, env = process.env }) {
  const current = await client.query(
    `select * from webhook_endpoint_secrets
      where organization_id = $1 and endpoint_id = $2 and status = 'current'`,
    [organizationId, Number(endpointId)]
  );
  const nextVersion = await client.query(
    `select coalesce(max(version), 0) + 1 as version from webhook_endpoint_secrets
      where organization_id = $1 and endpoint_id = $2`,
    [organizationId, Number(endpointId)]
  );

  if (current.rows[0]) {
    // Demote the outgoing secret first: the partial unique index allows exactly one
    // 'current' row, so this ordering is what makes the rotation atomic rather than racy.
    await client.query(
      `update webhook_endpoint_secrets
          set status = 'retiring', retire_at = now() + make_interval(mins => $3)
        where organization_id = $1 and id = $2`,
      [organizationId, current.rows[0].id, Math.max(Number(retireCurrentAfterMinutes) || 60, 1)]
    );
  }

  const secret = secretCrypto.generateSigningSecret();
  const inserted = await client.query(
    `insert into webhook_endpoint_secrets (organization_id, endpoint_id, version, ciphertext, status)
     values ($1,$2,$3,$4,'current') returning id, version, status, created_at`,
    [
      organizationId, Number(endpointId), Number(nextVersion.rows[0].version),
      secretCrypto.encryptSecret(secret, { endpointId: Number(endpointId) }, env),
    ]
  );
  return { secret, version: Number(inserted.rows[0].version), id: Number(inserted.rows[0].id) };
}

async function createWebhookEndpoint(client, { organizationId, name, url, events, actorId = null, env = process.env }) {
  const label = String(name || '').trim().slice(0, 120);
  if (!label) throw integrationError('Webhook adi zorunlu', 'WEBHOOK_NAME_REQUIRED', 400);
  const validated = validateWebhookUrl(url, env);

  await planLimits.assertPlanCapacity(client, organizationId, 'webhooks');

  const inserted = await client.query(
    `insert into webhook_endpoints (organization_id, name, url, created_by)
     values ($1,$2,$3,$4) returning *`,
    [organizationId, label, validated.url, actorId]
  );
  const endpoint = inserted.rows[0];
  const eventTypes = await replaceSubscriptions(client, { organizationId, endpointId: endpoint.id, events });
  const signing = await issueSigningSecret(client, { organizationId, endpointId: endpoint.id, env });
  return {
    endpoint: publicEndpoint({ ...endpoint, secret_version: signing.version }, eventTypes),
    secret: signing.secret,
  };
}

async function updateWebhookEndpoint(client, { organizationId, endpointId, name, url, events, env = process.env }) {
  const existing = await loadEndpoint(client, organizationId, endpointId);
  const label = name === undefined ? existing.name : String(name || '').trim().slice(0, 120);
  if (!label) throw integrationError('Webhook adi zorunlu', 'WEBHOOK_NAME_REQUIRED', 400);
  const nextUrl = url === undefined ? existing.url : validateWebhookUrl(url, env).url;

  const updated = await client.query(
    `update webhook_endpoints set name = $3, url = $4, updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, Number(endpointId), label, nextUrl]
  );
  const eventTypes = events === undefined
    ? await endpointEventTypes(client, organizationId, endpointId)
    : await replaceSubscriptions(client, { organizationId, endpointId, events });
  return publicEndpoint({ ...updated.rows[0], secret_version: existing.secret_version }, eventTypes);
}

async function setEndpointStatus(client, { organizationId, endpointId, status, reason = null }) {
  if (!['active', 'disabled', 'archived'].includes(status)) {
    throw integrationError('Gecersiz webhook durumu', 'WEBHOOK_STATUS_INVALID', 400);
  }
  const updated = await client.query(
    `update webhook_endpoints
        set status = $3,
            disabled_at = case when $3 = 'disabled' then now() else null end,
            disabled_reason = case when $3 = 'disabled' then $4 else null end,
            -- Re-enabling clears the streak, or the endpoint would be disabled again by
            -- the very next failure.
            consecutive_failures = case when $3 = 'active' then 0 else consecutive_failures end,
            updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, Number(endpointId), status, reason ? String(reason).slice(0, 200) : null]
  );
  if (!updated.rows[0]) throw integrationError('Webhook bulunamadi', 'WEBHOOK_NOT_FOUND', 404);
  return publicEndpoint(updated.rows[0], await endpointEventTypes(client, organizationId, endpointId));
}

async function rotateWebhookSecret(client, { organizationId, endpointId, env = process.env }) {
  await loadEndpoint(client, organizationId, endpointId);
  const signing = await issueSigningSecret(client, { organizationId, endpointId, env });
  return { secret: signing.secret, version: signing.version };
}

// ---------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------

function publicDelivery(row) {
  return {
    id: Number(row.id),
    event_id: row.event_uuid || null,
    event_type: row.event_type || null,
    endpoint_id: Number(row.endpoint_id),
    attempt: Number(row.attempt || 0),
    max_attempts: Number(row.max_attempts || 0),
    status: row.status,
    response_status: row.response_status,
    duration_ms: row.duration_ms,
    error_code: row.error_code,
    error_detail: row.error_detail,
    next_attempt_at: row.next_attempt_at,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
  };
}

async function listDeliveries(client, { organizationId, endpointId = null, status = null, limit = 50 }) {
  const filters = ['d.organization_id = $1'];
  const params = [organizationId];
  if (endpointId) {
    params.push(Number(endpointId));
    filters.push(`d.endpoint_id = $${params.length}`);
  }
  if (status) {
    params.push(String(status));
    filters.push(`d.status = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const result = await client.query(
    `select d.*, e.event_id as event_uuid, e.event_type
       from webhook_deliveries d
       join integration_events e on e.organization_id = d.organization_id and e.id = d.event_id
      where ${filters.join(' and ')}
      order by d.created_at desc, d.id desc
      limit $${params.length}`,
    params
  );
  return result.rows.map(publicDelivery);
}

/**
 * Re-queues an existing delivery. It never creates a new business event: a retry is another
 * attempt to deliver something that already happened, not a claim that it happened twice.
 */
async function retryDelivery(client, { organizationId, deliveryId }) {
  const updated = await client.query(
    `update webhook_deliveries
        set status = 'pending', next_attempt_at = now(), locked_at = null, locked_by = null,
            error_code = null, error_detail = null, updated_at = now(),
            -- A manual retry buys a fresh budget; otherwise a dead-lettered delivery could
            -- never be retried at all once its attempts were spent.
            max_attempts = greatest(max_attempts, attempt + 3)
      where organization_id = $1 and id = $2 and status in ('dead_letter', 'retry', 'cancelled')
     returning *`,
    [organizationId, Number(deliveryId)]
  );
  if (!updated.rows[0]) {
    throw integrationError('Bu teslimat yeniden denenemez', 'WEBHOOK_DELIVERY_NOT_RETRYABLE', 409);
  }
  return publicDelivery(updated.rows[0]);
}

module.exports = {
  DEFAULT_OVERLAP_MINUTES,
  IDEMPOTENCY_TTL_HOURS,
  authenticateApiKey,
  claimIdempotency,
  completeIdempotency,
  createApiKey,
  createWebhookEndpoint,
  endpointEventTypes,
  integrationError,
  issueSigningSecret,
  listApiKeys,
  listDeliveries,
  listWebhookEndpoints,
  loadApiKey,
  loadEndpoint,
  publicDelivery,
  publicEndpoint,
  publicKey,
  releaseIdempotency,
  requestFingerprint,
  retryDelivery,
  revokeApiKey,
  rotateApiKey,
  rotateWebhookSecret,
  setEndpointStatus,
  touchApiKey,
  updateWebhookEndpoint,
};
