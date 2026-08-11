'use strict';

// A29 external API plumbing: stable errors, rate limiting, monthly quota and idempotency.
//
// The public contract is deliberately narrower and more stable than the admin API's. An
// integration written against /v1 has to keep working across releases, so the error body
// has one shape, every failure has a machine-readable code, and nothing internal — a stack,
// a SQL message, a table name — ever reaches it.

const crypto = require('crypto');
const db = require('../db');
const service = require('../modules/integrations/service');
const planVersions = require('../services/planVersions');
const { logger } = require('../services/logger');

// Per key, per window. DB-backed like every other limiter here, so it holds across
// processes: an in-memory counter would reset on deploy and count nothing on a second
// instance, which is not a rate limit so much as a suggestion.
const RATE_LIMIT_WINDOW_MS = 60_000;

function apiError(res, req, { status, code, message, fields = undefined }) {
  const body = { error: { code, message, request_id: req.id } };
  if (fields) body.error.fields = fields;
  return res.status(status).json(body);
}

/** Turns any thrown error into the public contract. Internal detail stops here. */
function externalErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  // A 5xx is never explained to the caller: the message could carry a SQL fragment, a
  // column name or a hostname. Operators get it from the logs, correlated by request id.
  if (status >= 500) {
    // Falls back to the module logger: an unexplained 500 with nothing in the log is the
    // worst of both worlds — the caller learns nothing and neither do we.
    (req.log || logger).error({ err: error, requestId: req.id }, 'External API hatasi');
    return apiError(res, req, {
      status: 500, code: 'INTERNAL_ERROR', message: 'Beklenmeyen bir hata olustu',
    });
  }
  return apiError(res, req, {
    status,
    code: error.code || 'REQUEST_INVALID',
    message: error.message || 'Istek islenemedi',
    fields: error.meta?.fields,
  });
}

/** State-changing requests must declare JSON; a mis-typed body is a client bug, not a guess. */
function requireJsonBody(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return apiError(res, req, {
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Content-Type application/json olmali',
    });
  }
  return next();
}

/**
 * Rate limit keyed on the API KEY, not the IP: several integrations behind one NAT must not
 * share a budget, and one key spread across many IPs must not escape it.
 */
async function rateLimitApiKey(req, res, next) {
  try {
    const max = Math.max(Number(process.env.EXTERNAL_API_RATE_LIMIT || 600), 1);
    const key = `apikey:${req.apiAuth.id}`;
    const resetAt = new Date(Date.now() + RATE_LIMIT_WINDOW_MS);
    const result = await db.systemQuery(
      `insert into api_rate_limits (key, hit_count, reset_at)
       values ($1, 1, $2)
       on conflict (key) do update set
         hit_count = case when api_rate_limits.reset_at <= now() then 1 else api_rate_limits.hit_count + 1 end,
         reset_at = case when api_rate_limits.reset_at <= now() then excluded.reset_at else api_rate_limits.reset_at end,
         updated_at = now()
       returning hit_count, extract(epoch from reset_at)::bigint as reset_at_epoch`,
      [key, resetAt.toISOString()]
    );
    const count = Number(result.rows[0].hit_count || 0);
    const resetEpoch = Number(result.rows[0].reset_at_epoch || 0);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - count)));
    res.set('RateLimit-Reset', String(resetEpoch));
    if (count > max) {
      res.set('Retry-After', String(Math.max(1, resetEpoch - Math.floor(Date.now() / 1000))));
      return apiError(res, req, {
        status: 429, code: 'RATE_LIMIT_EXCEEDED', message: 'Cok fazla istek. Lutfen bekleyin.',
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Monthly plan quota. Counted server-side from the tenant's own counter, so it cannot be
 * bypassed by talking to the API directly instead of through the dashboard — there is no
 * client-side component to bypass.
 */
async function enforceMonthlyQuota(req, res, next) {
  try {
    const usage = await db.systemQuery(
      `insert into api_usage_counters (organization_id, period_start, call_count)
       values ($1, date_trunc('month', now() at time zone 'utc'), 1)
       on conflict (organization_id, period_start)
       do update set call_count = api_usage_counters.call_count + 1, updated_at = now()
       returning call_count`,
      [req.organizationId]
    );
    const used = Number(usage.rows[0].call_count || 0);
    // The same resolver the dashboard reads, so the ceiling here is the tenant's pinned
    // plan version with any live override applied — not a second interpretation of it.
    const limits = await db.withTenantContext(req.organizationId, (client) =>
      planVersions.resolveEffectiveLimits(client, req.organizationId));
    const ceiling = Number(limits?.max_api_calls_month || 0);
    // A limit of zero means unlimited, matching how every other plan dimension reads.
    if (ceiling > 0 && used > ceiling) {
      return apiError(res, req, {
        status: 429,
        code: 'API_QUOTA_EXCEEDED',
        message: 'Aylik API cagri limitiniz doldu. Planinizi yukseltebilirsiniz.',
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Idempotency for creates.
 *
 * The claim is inserted before the operation runs and completed with the response after, so
 * two concurrent requests with the same key cannot both perform the mutation: the second
 * one's insert loses the unique index and it waits for, or replays, the first.
 */
function idempotent(route) {
  return async (req, res, next) => {
    const key = String(req.get('idempotency-key') || '').trim();
    if (!key) {
      return apiError(res, req, {
        status: 400,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Bu islem icin Idempotency-Key basligi zorunlu',
      });
    }
    if (key.length > 200) {
      return apiError(res, req, {
        status: 400, code: 'IDEMPOTENCY_KEY_INVALID', message: 'Idempotency-Key cok uzun',
      });
    }

    try {
      const claim = await db.withTenantContext(req.organizationId, (client) =>
        service.claimIdempotency(client, {
          organizationId: req.organizationId,
          apiKeyId: req.apiAuth.id,
          key,
          method: req.method,
          route,
          body: req.body,
        }));

      if (claim.state === 'conflict') {
        return apiError(res, req, {
          status: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Bu Idempotency-Key farkli bir istek govdesiyle kullanilmis',
        });
      }
      if (claim.state === 'replay') {
        res.set('Idempotent-Replay', 'true');
        return res.status(Number(claim.record.response_status) || 200).json(claim.record.response_body);
      }
      if (claim.state === 'in_progress') {
        // A concurrent request holds the claim. 409 rather than a guess: returning a
        // fabricated success would be worse than asking the client to retry.
        return apiError(res, req, {
          status: 409,
          code: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'Ayni Idempotency-Key ile bir istek halen isleniyor',
        });
      }

      req.idempotencyRecordId = claim.record ? Number(claim.record.id) : null;
      // The response is captured as it is sent, so what replays is exactly what the first
      // caller received.
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const status = res.statusCode;
        const finalize = status >= 200 && status < 300
          ? service.completeIdempotency
          : service.releaseIdempotency;
        if (req.idempotencyRecordId) {
          db.withTenantContext(req.organizationId, (client) => finalize(client, {
            organizationId: req.organizationId,
            recordId: req.idempotencyRecordId,
            responseStatus: status,
            responseBody: body,
          })).catch((error) => req.log?.warn({ err: error }, 'Idempotency kaydi tamamlanamadi'));
        }
        return originalJson(body);
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Bounded, allowlisted pagination. A client never supplies a sort expression. */
function parsePagination(query, { allowedSort = ['created_at'], defaultSort = 'created_at' } = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const sort = allowedSort.includes(String(query.sort || '')) ? String(query.sort) : defaultSort;
  const direction = String(query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  let cursor = null;
  if (query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
      if (decoded && Number.isFinite(Number(decoded.id))) cursor = { id: Number(decoded.id) };
    } catch (_) {
      throw Object.assign(new Error('Sayfalama imleci gecersiz'), { status: 400, code: 'CURSOR_INVALID' });
    }
  }
  return { limit, sort, direction, cursor };
}

function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ id: Number(row.id) }), 'utf8').toString('base64url');
}

function hashBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

module.exports = {
  RATE_LIMIT_WINDOW_MS,
  apiError,
  encodeCursor,
  enforceMonthlyQuota,
  externalErrorHandler,
  hashBody,
  idempotent,
  parsePagination,
  rateLimitApiKey,
  requireJsonBody,
};
