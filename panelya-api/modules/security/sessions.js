'use strict';

// A30 session service.
//
// One session row per device, for both actor types. Refresh rotation stays INSIDE a
// session: rotating a token issues a new refresh row pointing at the same auth_session, so
// "log this device out" is one revoke rather than a hunt for whichever token happens to be
// current.
//
// The session is also the authority for assurance. `mfa_level` and `step_up_verified_at`
// live here, not in the access token, because a token the client is already holding cannot
// be un-issued: if MFA is disabled or a step-up expires, a claim baked into a JWT would
// keep asserting otherwise until it expired on its own.

const crypto = require('crypto');
const { describeRequest } = require('./deviceMetadata');

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
// How long a step-up counts as "recent". Short enough that a walked-away-from laptop
// cannot be used for a refund an hour later; long enough to do a few related operations.
const STEP_UP_TTL_MINUTES = Number(process.env.STEP_UP_TTL_MINUTES || 10);
// last_seen_at is a convenience for the user, not an audit record. Writing it on every
// request would make the session row the hottest row in the database.
const LAST_SEEN_THROTTLE_SECONDS = 60;

function sessionError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function ownerColumns({ actorType, ownerId }) {
  if (actorType === 'admin') return { column: 'admin_id', value: ownerId };
  return { column: 'user_id', value: ownerId };
}

/** The shape the session list and the security summary expose. Never a token, never a hash. */
function publicSession(row, currentSessionId = null) {
  return {
    id: row.id,
    is_current: currentSessionId != null && row.id === currentSessionId,
    device_label: row.device_label || row.user_agent_summary || 'Bilinmeyen cihaz',
    user_agent_summary: row.user_agent_summary,
    ip_prefix: row.ip_prefix,
    mfa_level: row.mfa_level,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    is_impersonation: Boolean(row.is_impersonation),
    created_auth_method: row.created_auth_method,
  };
}

async function createSession(client, {
  actorType,
  ownerId,
  req,
  mfaLevel = 'password',
  createdAuthMethod = 'password',
  isImpersonation = false,
  impersonatorAdminId = null,
  impersonationReason = null,
  ttlDays = SESSION_TTL_DAYS,
}) {
  const owner = ownerColumns({ actorType, ownerId });
  const device = describeRequest(req);
  const expiresAt = new Date(Date.now() + (ttlDays * 24 * 60 * 60 * 1000));
  const result = await client.query(
    `insert into auth_sessions
       (actor_type, ${owner.column}, expires_at, user_agent_hash, user_agent_summary, ip_prefix,
        device_label, mfa_level, mfa_verified_at, created_auth_method, last_auth_method,
        is_impersonation, impersonator_admin_id, impersonation_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13)
     returning *`,
    [
      actorType, owner.value, expiresAt.toISOString(),
      device.userAgentHash, device.userAgentSummary, device.ipPrefix,
      device.userAgentSummary, mfaLevel, mfaLevel === 'mfa' ? new Date().toISOString() : null,
      createdAuthMethod, isImpersonation, impersonatorAdminId, impersonationReason,
    ]
  );
  return result.rows[0];
}

/**
 * Loads a session for an access-token check.
 *
 * Everything that could make a session unusable is decided HERE — revoked, expired, wrong
 * owner — so no route has to remember to check any of it. A revoked session stops working
 * immediately rather than when its access token happens to expire.
 */
async function loadActiveSession(client, { sessionId, actorType, ownerId }) {
  if (!sessionId) return null;
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select * from auth_sessions
      where id = $1 and actor_type = $2 and ${owner.column} = $3
        and revoked_at is null and expires_at > now()
      limit 1`,
    [sessionId, actorType, owner.value]
  );
  return result.rows[0] || null;
}

async function touchSession(client, sessionId) {
  await client.query(
    `update auth_sessions set last_seen_at = now(), updated_at = now()
      where id = $1 and last_seen_at < now() - make_interval(secs => $2)`,
    [sessionId, LAST_SEEN_THROTTLE_SECONDS]
  );
}

async function listSessions(client, { actorType, ownerId, currentSessionId = null }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select * from auth_sessions
      where actor_type = $1 and ${owner.column} = $2
        and revoked_at is null and expires_at > now()
      order by last_seen_at desc, created_at desc
      limit 100`,
    [actorType, owner.value]
  );
  return result.rows.map((row) => publicSession(row, currentSessionId));
}

/**
 * Revokes one session and every refresh token in it.
 *
 * Scoped by owner in the WHERE clause, not checked afterwards: a caller cannot revoke
 * somebody else's session even knowing its id, because the update simply matches no row.
 */
async function revokeSession(client, { actorType, ownerId, sessionId, reason = 'user_revoked' }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `update auth_sessions
        set revoked_at = now(), revoke_reason = $4, updated_at = now()
      where id = $3 and actor_type = $1 and ${owner.column} = $2 and revoked_at is null
     returning *`,
    [actorType, owner.value, sessionId, reason]
  );
  if (!result.rows[0]) throw sessionError('Oturum bulunamadi', 'SESSION_NOT_FOUND', 404);
  await client.query(
    'update refresh_tokens set revoked_at = now() where session_id = $1 and revoked_at is null',
    [sessionId]
  );
  return publicSession(result.rows[0]);
}

/** "Log out my other devices": the current session is deliberately preserved. */
async function revokeOtherSessions(client, { actorType, ownerId, keepSessionId, reason = 'user_revoked_others' }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `update auth_sessions
        set revoked_at = now(), revoke_reason = $4, updated_at = now()
      where actor_type = $1 and ${owner.column} = $2 and revoked_at is null
        and ($3::uuid is null or id <> $3::uuid)
     returning id`,
    [actorType, owner.value, keepSessionId || null, reason]
  );
  const ids = result.rows.map((row) => row.id);
  if (ids.length) {
    await client.query(
      'update refresh_tokens set revoked_at = now() where session_id = any($1::uuid[]) and revoked_at is null',
      [ids]
    );
  }
  return ids.length;
}

/**
 * Revokes a whole session family. Used when a refresh token is REPLAYED: a reused token
 * means either the legitimate client retried or somebody stole it, and the only safe
 * reading is the second — so the family goes, and the user re-authenticates.
 */
async function revokeSessionFamily(client, { sessionFamilyId, reason = 'refresh_reuse' }) {
  const result = await client.query(
    `update auth_sessions set revoked_at = now(), revoke_reason = $2, updated_at = now()
      where session_family_id = $1 and revoked_at is null
     returning id`,
    [sessionFamilyId, reason]
  );
  const ids = result.rows.map((row) => row.id);
  if (ids.length) {
    await client.query(
      'update refresh_tokens set revoked_at = now() where session_id = any($1::uuid[]) and revoked_at is null',
      [ids]
    );
  }
  return ids;
}

/** Raises a session to MFA assurance. Recorded on the session, never in a token claim. */
async function markMfaVerified(client, { sessionId, method }) {
  const result = await client.query(
    `update auth_sessions
        set mfa_level = 'mfa', mfa_verified_at = now(), last_auth_method = $2,
            step_up_verified_at = now(), step_up_method = $2, updated_at = now()
      where id = $1 and revoked_at is null
     returning *`,
    [sessionId, method]
  );
  return result.rows[0] || null;
}

async function markStepUp(client, { sessionId, method }) {
  const result = await client.query(
    `update auth_sessions
        set step_up_verified_at = now(), step_up_method = $2, last_auth_method = $2, updated_at = now()
      where id = $1 and revoked_at is null
     returning *`,
    [sessionId, method]
  );
  return result.rows[0] || null;
}

/**
 * Is this session's step-up still recent? Evaluated against the clock every time rather
 * than stored as a flag, so it lapses on its own with nothing needing to run.
 */
function stepUpIsRecent(session, now = Date.now()) {
  if (!session || !session.step_up_verified_at) return false;
  const verifiedAt = new Date(session.step_up_verified_at).getTime();
  return (now - verifiedAt) <= (STEP_UP_TTL_MINUTES * 60 * 1000);
}

/** Devices this person has used before, for the "new device" signal. */
async function knownDeviceHashes(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select distinct user_agent_hash from auth_sessions
      where actor_type = $1 and ${owner.column} = $2 and user_agent_hash is not null`,
    [actorType, owner.value]
  );
  return result.rows.map((row) => row.user_agent_hash);
}

function newSessionFamilyId() {
  return crypto.randomUUID();
}

module.exports = {
  LAST_SEEN_THROTTLE_SECONDS,
  SESSION_TTL_DAYS,
  STEP_UP_TTL_MINUTES,
  createSession,
  knownDeviceHashes,
  listSessions,
  loadActiveSession,
  markMfaVerified,
  markStepUp,
  newSessionFamilyId,
  publicSession,
  revokeOtherSessions,
  revokeSession,
  revokeSessionFamily,
  sessionError,
  stepUpIsRecent,
  touchSession,
};
