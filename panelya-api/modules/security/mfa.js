'use strict';

// A30 MFA service: TOTP enrolment/verification and recovery codes.
//
// Every write goes through here so the two surfaces that can change a factor — the tenant
// admin API and the platform console — cannot end up with different rules about what
// enabling, verifying or disabling a factor means.

const mfaCrypto = require('./mfaCrypto');
const totp = require('./totp');

function mfaError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function ownerColumns({ actorType, ownerId }) {
  if (actorType === 'admin') return { column: 'admin_id', value: ownerId };
  return { column: 'user_id', value: ownerId };
}

/** Public shape. There is no branch that puts a secret or a ciphertext in this. */
function publicMethod(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    enabled: Boolean(row.enabled),
    verified_at: row.verified_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

async function listMethods(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select * from user_mfa_methods
      where actor_type = $1 and ${owner.column} = $2 and disabled_at is null
      order by created_at`,
    [actorType, owner.value]
  );
  return result.rows.map(publicMethod);
}

async function activeTotpMethod(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select * from user_mfa_methods
      where actor_type = $1 and ${owner.column} = $2 and type = 'totp'
        and disabled_at is null and enabled = true
      limit 1`,
    [actorType, owner.value]
  );
  return result.rows[0] || null;
}

/**
 * Begins TOTP enrolment.
 *
 * The secret is returned ONCE, here, and stored encrypted. The method is created DISABLED:
 * an unconfirmed factor that already counted as MFA would lock out anyone whose scan
 * silently failed.
 */
async function beginTotpSetup(client, { actorType, ownerId, accountName, env = process.env }) {
  const owner = ownerColumns({ actorType, ownerId });
  // Restarting setup replaces any unconfirmed attempt: the old secret was never confirmed
  // and keeping it around would just be a second thing that might match.
  await client.query(
    `delete from user_mfa_methods
      where actor_type = $1 and ${owner.column} = $2 and type = 'totp'
        and enabled = false and disabled_at is null`,
    [actorType, owner.value]
  );
  const existing = await activeTotpMethod(client, { actorType, ownerId });
  if (existing) throw mfaError('TOTP zaten kurulu', 'MFA_TOTP_ALREADY_ENABLED', 409);

  const secret = totp.generateSecret();
  const encrypted = mfaCrypto.encryptSecret(secret, { actorType, ownerId, purpose: 'totp' }, env);
  const inserted = await client.query(
    `insert into user_mfa_methods (actor_type, ${owner.column}, type, encrypted_secret, encryption_version)
     values ($1,$2,'totp',$3,$4) returning *`,
    [actorType, owner.value, encrypted, mfaCrypto.ENCRYPTION_VERSION]
  );
  return {
    method: publicMethod(inserted.rows[0]),
    // The only two places the raw secret exists outside the ciphertext, both in this
    // response, both never persisted by the caller.
    secret,
    otpauthUri: totp.otpauthUri({ accountName, secret }),
  };
}

/**
 * Confirms enrolment with the first working code, which is what proves the authenticator
 * actually holds the secret.
 */
async function confirmTotpSetup(client, { actorType, ownerId, token, env = process.env, now = Date.now() }) {
  const owner = ownerColumns({ actorType, ownerId });
  const pending = await client.query(
    `select * from user_mfa_methods
      where actor_type = $1 and ${owner.column} = $2 and type = 'totp'
        and enabled = false and disabled_at is null
      order by created_at desc limit 1
      for update`,
    [actorType, owner.value]
  );
  const method = pending.rows[0];
  if (!method) throw mfaError('Bekleyen TOTP kurulumu yok', 'MFA_TOTP_SETUP_NOT_FOUND', 404);

  const secret = mfaCrypto.decryptSecret(
    method.encrypted_secret, { actorType, ownerId, purpose: 'totp' }, env
  );
  const match = totp.verifyCode({ secret, token, now });
  if (!match) throw mfaError('Dogrulama kodu hatali', 'MFA_CODE_INVALID', 400);

  const updated = await client.query(
    `update user_mfa_methods
        set enabled = true, verified_at = now(), last_used_step = $2, last_used_at = now(), updated_at = now()
      where id = $1 returning *`,
    [method.id, match.step]
  );
  return publicMethod(updated.rows[0]);
}

/**
 * Verifies a TOTP code for an already-enrolled factor.
 *
 * The row is locked and the accepted time-step recorded, which is what makes a code
 * single-use: a TOTP code stays valid for its whole window, so without this a shoulder-
 * surfed code would keep working for the rest of it. Two concurrent submissions of the same
 * code serialise on the lock and only the first one wins.
 */
async function verifyTotp(client, { actorType, ownerId, token, env = process.env, now = Date.now() }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select * from user_mfa_methods
      where actor_type = $1 and ${owner.column} = $2 and type = 'totp'
        and enabled = true and disabled_at is null
      limit 1 for update`,
    [actorType, owner.value]
  );
  const method = result.rows[0];
  if (!method) throw mfaError('Kurulu TOTP yok', 'MFA_TOTP_NOT_ENABLED', 404);

  const secret = mfaCrypto.decryptSecret(
    method.encrypted_secret, { actorType, ownerId, purpose: 'totp' }, env
  );
  const match = totp.verifyCode({ secret, token, now });
  if (!match) throw mfaError('Dogrulama kodu hatali', 'MFA_CODE_INVALID', 400);
  if (method.last_used_step != null && Number(match.step) <= Number(method.last_used_step)) {
    throw mfaError('Bu kod zaten kullanildi', 'MFA_CODE_REPLAYED', 400);
  }

  await client.query(
    'update user_mfa_methods set last_used_step = $2, last_used_at = now(), updated_at = now() where id = $1',
    [method.id, match.step]
  );
  return { method: publicMethod(method), step: match.step };
}

/**
 * Disables TOTP. The caller is responsible for having already proved a step-up — this
 * function does not decide policy, it applies it, and the routes enforce the gate.
 */
async function disableTotp(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `update user_mfa_methods
        set enabled = false, disabled_at = now(), updated_at = now()
      where actor_type = $1 and ${owner.column} = $2 and type = 'totp' and disabled_at is null
     returning *`,
    [actorType, owner.value]
  );
  if (!result.rows[0]) throw mfaError('Kurulu TOTP yok', 'MFA_TOTP_NOT_ENABLED', 404);
  return publicMethod(result.rows[0]);
}

// --- recovery codes --------------------------------------------------------------------

async function currentGeneration(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select coalesce(max(generation), 0) as generation from mfa_recovery_codes
      where actor_type = $1 and ${owner.column} = $2`,
    [actorType, owner.value]
  );
  return Number(result.rows[0].generation || 0);
}

/**
 * Issues a fresh set and returns the raw codes ONCE.
 *
 * Regenerating bumps the generation and deletes every unused code from earlier ones: a set
 * a user believes is void must actually be void, or a printout thrown away last year is
 * still a way in.
 */
async function regenerateRecoveryCodes(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const generation = (await currentGeneration(client, { actorType, ownerId })) + 1;
  await client.query(
    `delete from mfa_recovery_codes
      where actor_type = $1 and ${owner.column} = $2 and used_at is null`,
    [actorType, owner.value]
  );
  const codes = mfaCrypto.generateRecoveryCodes();
  for (const code of codes) {
    await client.query(
      `insert into mfa_recovery_codes (actor_type, ${owner.column}, code_hash, generation)
       values ($1,$2,$3,$4)`,
      [actorType, owner.value, mfaCrypto.hashRecoveryCode(code), generation]
    );
  }
  return { codes, generation };
}

async function countUnusedRecoveryCodes(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select count(*)::int as n from mfa_recovery_codes
      where actor_type = $1 and ${owner.column} = $2 and used_at is null`,
    [actorType, owner.value]
  );
  return Number(result.rows[0].n || 0);
}

/**
 * Consumes a recovery code, atomically.
 *
 * The `used_at is null` predicate is inside the UPDATE, so two concurrent submissions of
 * the same code cannot both succeed — the second one matches no row. Checking first and
 * updating after would be exactly the race this avoids.
 */
async function consumeRecoveryCode(client, { actorType, ownerId, code, sessionId = null }) {
  const owner = ownerColumns({ actorType, ownerId });
  const hash = mfaCrypto.hashRecoveryCode(code);
  const result = await client.query(
    `update mfa_recovery_codes
        set used_at = now(), used_session_id = $4
      where actor_type = $1 and ${owner.column} = $2 and code_hash = $3 and used_at is null
     returning id, generation`,
    [actorType, owner.value, hash, sessionId]
  );
  if (!result.rows[0]) throw mfaError('Kurtarma kodu gecersiz', 'MFA_RECOVERY_CODE_INVALID', 400);
  return { id: result.rows[0].id, generation: Number(result.rows[0].generation) };
}

// --- passkeys ----------------------------------------------------------------------------

function publicCredential(row) {
  return {
    id: row.id,
    name: row.name,
    device_type: row.device_type,
    backed_up: Boolean(row.backed_up),
    transports: row.transports || [],
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

async function listCredentials(client, { actorType, ownerId }) {
  const owner = ownerColumns({ actorType, ownerId });
  const result = await client.query(
    `select * from webauthn_credentials
      where actor_type = $1 and ${owner.column} = $2 and revoked_at is null
      order by created_at desc`,
    [actorType, owner.value]
  );
  return result.rows;
}

/** True when this person holds at least one usable second factor of any kind. */
async function hasAnyFactor(client, { actorType, ownerId }) {
  const totpMethod = await activeTotpMethod(client, { actorType, ownerId });
  if (totpMethod) return true;
  const credentials = await listCredentials(client, { actorType, ownerId });
  return credentials.length > 0;
}

module.exports = {
  activeTotpMethod,
  beginTotpSetup,
  confirmTotpSetup,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  currentGeneration,
  disableTotp,
  hasAnyFactor,
  listCredentials,
  listMethods,
  mfaError,
  publicCredential,
  publicMethod,
  regenerateRecoveryCodes,
  verifyTotp,
};
