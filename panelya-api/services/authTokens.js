const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ensureJwtSecret, randomToken } = require('../middleware/security');

const APP_AUDIENCE = 'panelya-app';
const ADMIN_AUDIENCE = 'panelya-admin';

function accessTokenExpiresIn() {
  return process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';
}

function refreshTokenExpiresDays() {
  const days = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 30);
  return Number.isFinite(days) ? Math.min(Math.max(days, 1), 90) : 30;
}

function refreshTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createAccessToken(payload, audience) {
  const tokenType = audience === ADMIN_AUDIENCE ? 'admin' : 'app';
  return jwt.sign(payload, ensureJwtSecret(tokenType), {
    expiresIn: accessTokenExpiresIn(),
    algorithm: 'HS256',
    issuer: 'panelya-api',
    audience,
  });
}

function createAdminAccessToken(admin) {
  return createAccessToken({
    sub: admin.id,
    username: admin.username,
    role: admin.role,
    actorType: 'admin',
  }, ADMIN_AUDIENCE);
}

function createAppAccessToken({ user, membership }) {
  return createAccessToken({
    sub: user.id,
    userId: user.id,
    email: user.email,
    name: user.name || '',
    role: membership.role,
    organizationId: membership.organization.id,
    organizationSlug: membership.organization.slug,
    actorType: 'app',
  }, APP_AUDIENCE);
}

// Super_admin'in bir magazanin paneline gecisi icin kisa omurlu app-audience token.
// organizationSlug JWT'ye gomulu oldugundan resolveOrganization yalnizca hedef org'u
// cozer; tenant izolasyonu korunur. `impersonated` flag'i ve impersonator kimligi
// audit/UI uyarisi icin claim'lerde tasinir.
function createImpersonationToken({ adminId, ownerUserId = null, organization, role = 'owner', expiresIn }) {
  const tokenType = 'app';
  return jwt.sign(
    {
      sub: ownerUserId || `superadmin:${adminId}`,
      userId: ownerUserId || null,
      role,
      organizationId: organization.id,
      organizationSlug: organization.slug,
      actorType: 'app',
      impersonated: true,
      impersonatorAdminId: String(adminId),
    },
    ensureJwtSecret(tokenType),
    {
      expiresIn: expiresIn || process.env.IMPERSONATION_TOKEN_EXPIRES_IN || '15m',
      algorithm: 'HS256',
      issuer: 'panelya-api',
      audience: APP_AUDIENCE,
    }
  );
}

async function issueRefreshToken(client, { userId, req }) {
  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.now() + refreshTokenExpiresDays() * 24 * 60 * 60 * 1000);

  await client.query(
    `insert into refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     values ($1, $2, $3, $4, $5)`,
    [
      userId,
      refreshTokenHash(rawToken),
      expiresAt.toISOString(),
      String(req.get('user-agent') || '').slice(0, 500),
      req.ip || null,
    ]
  );

  return rawToken;
}

async function getRefreshSession(client, rawToken, { forUpdate = false } = {}) {
  if (!rawToken) return null;
  const result = await client.query(
    `select *
     from refresh_tokens
     where token_hash = $1
       and revoked_at is null
       and expires_at > now()
     limit 1
     ${forUpdate ? 'for update' : ''}`,
    [refreshTokenHash(rawToken)]
  );
  return result.rows[0] || null;
}

async function revokeRefreshToken(client, rawToken) {
  if (!rawToken) return;
  await client.query(
    `update refresh_tokens
     set revoked_at = now()
     where token_hash = $1
       and revoked_at is null`,
    [refreshTokenHash(rawToken)]
  );
}

async function markRefreshTokenUsed(client, tokenId) {
  await client.query(
    'update refresh_tokens set last_used_at = now() where id = $1',
    [tokenId]
  );
}

function buildSessionPayload({ accessToken, refreshToken, user, memberships, currentMembership }) {
  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
    },
    currentOrganization: {
      ...currentMembership.organization,
      role: currentMembership.role,
    },
    role: currentMembership.role,
    organizations: memberships.map((membership) => ({
      ...membership.organization,
      role: membership.role,
    })),
  };
}

module.exports = {
  ADMIN_AUDIENCE,
  APP_AUDIENCE,
  buildSessionPayload,
  createAdminAccessToken,
  createAppAccessToken,
  createImpersonationToken,
  getRefreshSession,
  issueRefreshToken,
  markRefreshTokenUsed,
  revokeRefreshToken,
};
