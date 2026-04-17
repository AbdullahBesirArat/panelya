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
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Oturum gerekli' });
  }

  try {
    const claims = normalizeClaims(jwt.verify(token, ensureJwtSecret(), {
      algorithms: ['HS256'],
      issuer: 'maveran-api',
      audience: [ADMIN_AUDIENCE, APP_AUDIENCE],
    }));

    req.auth = claims;
    req.admin = claims;
    if (claims.actorType === 'app') req.user = claims;
    if (claims.organizationId || claims.organizationSlug) {
      req.organization = {
        id: claims.organizationId,
        slug: claims.organizationSlug,
      };
    }
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Oturum gecersiz veya suresi dolmus' });
  }
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

module.exports = {
  requireActorType,
  requireAuth,
  requireRole,
};
