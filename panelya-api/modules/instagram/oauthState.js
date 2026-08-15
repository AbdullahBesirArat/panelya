const { createHash, randomBytes } = require('node:crypto');
const { instagramError } = require('./errors');

const DEFAULT_TTL_MS = 12 * 60 * 1000;

function hashState(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

async function createOAuthState(client, {
  organizationId,
  actorId,
  ttlMs = DEFAULT_TTL_MS,
  now = new Date(),
  random = randomBytes,
}) {
  const state = random(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + Math.max(10 * 60 * 1000, Math.min(ttlMs, 15 * 60 * 1000)));
  await client.query(
    `insert into instagram_oauth_states
     (organization_id, actor_id, state_hash, expires_at)
     values ($1,$2,$3,$4)`,
    [organizationId, actorId, hashState(state), expiresAt.toISOString()]
  );
  return { state, expiresAt };
}

async function consumeOAuthState(client, {
  organizationId,
  actorId,
  state,
}) {
  const result = await client.query(
    `update instagram_oauth_states
        set used_at = now()
      where organization_id = $1
        and actor_id = $2
        and state_hash = $3
        and used_at is null
        and expires_at > now()
      returning id, organization_id, actor_id, expires_at, used_at`,
    [organizationId, actorId, hashState(state)]
  );
  if (!result.rows[0]) {
    throw instagramError('INSTAGRAM_OAUTH_STATE_INVALID', 400, 'Instagram baglanti oturumu gecersiz veya suresi dolmus');
  }
  return result.rows[0];
}

module.exports = { DEFAULT_TTL_MS, consumeOAuthState, createOAuthState, hashState };
