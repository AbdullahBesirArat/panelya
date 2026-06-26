const jwt = require('jsonwebtoken');
const { ensureJwtSecret } = require('./security');
const { ADMIN_AUDIENCE, APP_AUDIENCE } = require('../services/authTokens');

function normalizeClaims(claims) {
  const audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  const actorType = claims.actorType
    || (audience === APP_AUDIENCE ? 'app' : 'admin');

  return {
    ...claims,
    actorType,
    organizationId: claims.organizationId || null,
    organizationSlug: claims.organizationSlug || null,
  };
}

function requireAuth(req, res, next) {
  const parsed = parseAuthorizationHeader(req);

  if (!parsed.ok) {
    return res.status(parsed.status).json({ error: parsed.error });
  }

  assignAuth(req, parsed.claims);
  return next();
}

function parseAuthorizationHeader(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return { ok: false, status: 401, error: 'Oturum gerekli' };
  }

  try {
    const decoded = jwt.decode(token) || {};
    const audience = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
    const tokenType = audience === ADMIN_AUDIENCE ? 'admin' : 'app';
    const expectedAudience = tokenType === 'admin' ? ADMIN_AUDIENCE : APP_AUDIENCE;
    const claims = normalizeClaims(jwt.verify(token, ensureJwtSecret(tokenType), {
      algorithms: ['HS256'],
      issuer: 'panelya-api',
      audience: expectedAudience,
    }));

    return { ok: true, claims };
  } catch (_) {
    return { ok: false, status: 401, error: 'Oturum gecersiz veya suresi dolmus' };
  }
}

function assignAuth(req, claims) {
  req.auth = claims;
  req.admin = claims;
  if (claims.actorType === 'app') req.user = claims;
  if (claims.organizationId || claims.organizationSlug) {
    req.organization = {
      id: claims.organizationId,
      slug: claims.organizationSlug,
    };
  }
}

function attachAuthIfPresent(req, _res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();

  const parsed = parseAuthorizationHeader(req);
  if (parsed.ok) {
    assignAuth(req, parsed.claims);
  }

  return next();
}

function requireActorType(allowedTypes) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Oturum gerekli' });
    if (!allowedTypes.includes(req.auth.actorType)) {
      return res.status(403).json({ error: 'Bu islem icin oturum tipi uygun degil' });
    }
    return next();
  };
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Oturum gerekli' });
    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Bu islem icin yetkiniz yok' });
    }
    return next();
  };
}

// Platform Yonetimi (super_admin) uclari icin tek noktadan yetki kontrolu.
// Mevcut requireActorType(['admin']) + requireRole(['super_admin']) davranisini
// degistirmeden tek middleware'e sarar. Impersonation token'lari (actorType 'app')
// platform uclarina erisemez; yalnizca gercek admin-audience super_admin gecer.
const requireSuperAdmin = [
  requireAuth,
  requireActorType(['admin']),
  requireRole(['super_admin']),
];

module.exports = {
  attachAuthIfPresent,
  requireActorType,
  requireAuth,
  requireRole,
  requireSuperAdmin,
};
