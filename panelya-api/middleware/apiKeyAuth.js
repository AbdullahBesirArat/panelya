'use strict';

// A29 external API authentication.
//
// Deliberately separate from middleware/auth.js. That one authenticates a HUMAN in the
// dashboard and carries a role; this one authenticates a MACHINE over the public API and
// carries scopes. Keeping them apart is what guarantees an API key can never satisfy an
// admin route's requireRole, and an admin session can never satisfy a scope check.
//
// The tenant comes from the key row. Nothing in the request — no header, no query
// parameter, no body field — can change which organization a call operates on.

const db = require('../db');
const service = require('../modules/integrations/service');
const { hasScope } = require('../modules/integrations/scopes');
const { logger } = require('../services/logger');

// Every failure answers the same way. Telling a caller whether a prefix exists, or whether
// the secret was wrong versus the key revoked, is free reconnaissance.
function unauthorized(res, req) {
  return res.status(401).json({
    error: {
      code: 'API_KEY_INVALID',
      message: 'API anahtari gecersiz',
      request_id: req.id,
    },
  });
}

function bearerToken(req) {
  const header = String(req.get('authorization') || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/**
 * Authenticates the caller and pins req.apiAuth.
 *
 * A key presented in the query string is refused outright rather than accepted: query
 * strings end up in access logs, browser history, referrer headers and proxy caches, so
 * accepting one there would leak the credential no matter how carefully we handle it here.
 */
function requireApiKey(req, res, next) {
  (async () => {
    if (req.query && (req.query.api_key || req.query.apiKey || req.query.access_token)) {
      return res.status(400).json({
        error: {
          code: 'API_KEY_IN_QUERY',
          message: 'API anahtari yalnizca Authorization basliginda gonderilebilir',
          request_id: req.id,
        },
      });
    }

    const token = bearerToken(req);
    if (!token) return unauthorized(res, req);

    // The system connection is required here and only here: the tenant is unknown until the
    // key row is read, so there is no tenant context to set yet.
    const systemClient = await db.getSystemPool().connect();
    let result;
    try {
      result = await service.authenticateApiKey(systemClient, {
        token,
        clientIp: req.ip,
      });
      if (result.ok) await service.touchApiKey(systemClient, result.key.id);
    } finally {
      systemClient.release();
    }

    if (!result.ok) {
      // The reason is logged for operators, never returned to the caller.
      logger.debug({ reason: result.reason, requestId: req.id }, 'API anahtari reddedildi');
      return unauthorized(res, req);
    }

    req.apiAuth = result.key;
    req.organizationId = result.key.organizationId;
    return next();
  })().catch(next);
}

/**
 * Declarative scope requirement. Placed on the route so what a route needs is visible where
 * the route is defined, rather than buried in a handler.
 */
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiAuth) return unauthorized(res, req);
    if (!hasScope(req.apiAuth.scopes, scope)) {
      return res.status(403).json({
        error: {
          code: 'API_SCOPE_FORBIDDEN',
          message: `Bu islem icin ${scope} yetkisi gerekli`,
          request_id: req.id,
        },
      });
    }
    return next();
  };
}

module.exports = { bearerToken, requireApiKey, requireScope, unauthorized };
