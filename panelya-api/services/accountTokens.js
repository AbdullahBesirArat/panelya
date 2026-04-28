const crypto = require('crypto');
const { randomToken } = require('../middleware/security');

const PASSWORD_RESET_TOKEN_TTL_HOURS = Math.max(Number(process.env.PASSWORD_RESET_TOKEN_TTL_HOURS || 1), 1);
const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = Math.max(Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_HOURS || 24), 1);
const EMAIL_VERIFICATION_GRACE_HOURS = Math.max(Number(process.env.EMAIL_VERIFICATION_GRACE_HOURS || 24), 1);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function invalidateActiveTokens(client, tableName, userId) {
  await client.query(
    `update ${tableName}
     set used_at = now()
     where user_id = $1
       and used_at is null
       and expires_at > now()`,
    [userId]
  );
}

async function issuePasswordResetToken(client, userId) {
  const rawToken = randomToken(32);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await invalidateActiveTokens(client, 'password_reset_tokens', userId);
  await client.query(
    `insert into password_reset_tokens (user_id, token_hash, expires_at)
     values ($1, $2, $3)`,
    [userId, hashToken(rawToken), expiresAt.toISOString()]
  );

  return { rawToken, expiresAt };
}

async function issueEmailVerificationToken(client, user) {
  const rawToken = randomToken(32);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await invalidateActiveTokens(client, 'email_verification_tokens', user.id);
  await client.query(
    `insert into email_verification_tokens (user_id, email, token_hash, expires_at)
     values ($1, $2, $3, $4)`,
    [user.id, user.email, hashToken(rawToken), expiresAt.toISOString()]
  );

  return { rawToken, expiresAt };
}

async function getActiveToken(client, tableName, rawToken, { forUpdate = false } = {}) {
  if (!rawToken) return null;

  const result = await client.query(
    `select *
     from ${tableName}
     where token_hash = $1
       and used_at is null
       and expires_at > now()
     limit 1
     ${forUpdate ? 'for update' : ''}`,
    [hashToken(rawToken)]
  );

  return result.rows[0] || null;
}

async function consumeTokenById(client, tableName, id) {
  await client.query(
    `update ${tableName}
     set used_at = now()
     where id = $1
       and used_at is null`,
    [id]
  );
}

function buildPublicUrl(pathname, token, paramName = 'token') {
  const baseUrl = String(process.env.PUBLIC_SITE_URL || process.env.PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '');
  const url = new URL(pathname, `${baseUrl}/`);
  if (token) url.searchParams.set(paramName, token);
  return url.toString();
}

function isEmailVerificationRequired(user, now = new Date()) {
  if (!user) return false;
  if (user.email_verified_at) return false;

  const createdAt = new Date(user.created_at);
  const graceEndsAt = new Date(createdAt.getTime() + EMAIL_VERIFICATION_GRACE_HOURS * 60 * 60 * 1000);
  return graceEndsAt <= now;
}

function assertEmailVerificationAllowed(user, now = new Date()) {
  if (!isEmailVerificationRequired(user, now)) return;

  throw Object.assign(
    new Error('Email adresinizi dogrulamaniz gerekiyor. Yeni bir dogrulama baglantisi isteyebilirsiniz.'),
    { status: 403 }
  );
}

module.exports = {
  assertEmailVerificationAllowed,
  buildPublicUrl,
  consumeTokenById,
  getActiveToken,
  hashToken,
  isEmailVerificationRequired,
  issueEmailVerificationToken,
  issuePasswordResetToken,
};
