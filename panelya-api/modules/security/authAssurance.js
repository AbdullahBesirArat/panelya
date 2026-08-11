'use strict';

// A30 central authentication-assurance policy.
//
// Every "is this caller allowed to do something dangerous" question is answered here. The
// alternative — a role check and an MFA check sprinkled through routes — is how a new
// critical endpoint ends up being the one that forgot, and how two endpoints end up
// disagreeing about what "recent" means.
//
// Three levels, in order:
//
//   password  authenticated, nothing more
//   mfa       a second factor was proved at some point in this session
//   step_up   a factor was proved RECENTLY, for this operation
//
// The session row is the authority for all three. A token claim cannot be, because a token
// already in the client's hands cannot be un-issued when a factor is removed.

const sessions = require('./sessions');
const mfa = require('./mfa');

const LEVELS = Object.freeze({ password: 0, mfa: 1, step_up: 2 });

// Operations that must not ride on a login from last week. Each one either hands out a
// secret, moves money, changes who controls the account, or takes over another user.
const STEP_UP_PURPOSES = Object.freeze([
  'impersonation',
  'integration_secret',
  'billing',
  'domain_release',
  'refund',
  'mfa_enrollment',
  'mfa_change',
  'owner_transfer',
]);

function assuranceError(message, code, status = 403, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

/** The effective level of a session, evaluated against the clock rather than stored. */
function sessionLevel(session, now = Date.now()) {
  if (!session) return 'password';
  if (sessions.stepUpIsRecent(session, now)) return 'step_up';
  return session.mfa_level === 'mfa' ? 'mfa' : 'password';
}

function meets(session, required, now = Date.now()) {
  return LEVELS[sessionLevel(session, now)] >= LEVELS[required];
}

/**
 * Does this person have to hold MFA at all?
 *
 * Two independent sources: super-admin is always required (the platform console can reach
 * every tenant), and a tenant may require it of its own owners/admins. Either one is enough.
 */
async function mfaRequirement(client, { actorType, ownerId, role, organizationId = null }) {
  if (actorType === 'admin') {
    return { required: true, reason: 'super_admin' };
  }
  if (!organizationId || !['owner', 'admin'].includes(role)) {
    return { required: false, reason: null };
  }
  const result = await client.query(
    `select require_mfa_for_owner, require_mfa_for_admin
       from organization_security_policies where organization_id = $1`,
    [organizationId]
  );
  const policy = result.rows[0];
  if (!policy) return { required: false, reason: null };
  const required = role === 'owner'
    ? Boolean(policy.require_mfa_for_owner)
    : Boolean(policy.require_mfa_for_admin);
  return { required, reason: required ? 'organization_policy' : null };
}

/**
 * The state the UI and every guard read.
 *
 * `enrollmentRequired` is the important one: it means the person authenticated correctly
 * but policy demands a factor they do not yet have. They are NOT locked out — they can
 * reach enrolment and logout — but nothing else.
 */
async function describeAssurance(client, { session, actorType, ownerId, role, organizationId = null, now = Date.now() }) {
  const requirement = await mfaRequirement(client, { actorType, ownerId, role, organizationId });
  const hasFactor = await mfa.hasAnyFactor(client, { actorType, ownerId });
  const level = sessionLevel(session, now);
  return {
    level,
    mfaRequired: requirement.required,
    mfaRequiredReason: requirement.reason,
    hasFactor,
    // Required, but nothing enrolled yet: the bootstrap state that keeps a policy from
    // locking out the very people who have to comply with it.
    enrollmentRequired: requirement.required && !hasFactor,
    // Enrolled and required, but this session never proved it.
    mfaChallengeRequired: requirement.required && hasFactor && level === 'password',
    stepUpRecent: sessions.stepUpIsRecent(session, now),
    stepUpExpiresInSeconds: session?.step_up_verified_at
      ? Math.max(0, Math.floor(
        ((new Date(session.step_up_verified_at).getTime() + (sessions.STEP_UP_TTL_MINUTES * 60 * 1000)) - now) / 1000
      ))
      : 0,
  };
}

/**
 * Guard for ordinary authenticated endpoints when a policy is in force.
 *
 * Throws MFA_ENROLLMENT_REQUIRED or MFA_REQUIRED with a machine-readable code, so the UI
 * can route the user to enrolment or a challenge instead of showing a generic error.
 */
function assertPolicySatisfied(assurance) {
  if (assurance.enrollmentRequired) {
    throw assuranceError(
      'Bu hesap icin iki adimli dogrulama zorunlu. Once bir yontem ekleyin.',
      'MFA_ENROLLMENT_REQUIRED', 403, { enrollmentRequired: true }
    );
  }
  if (assurance.mfaChallengeRequired) {
    throw assuranceError(
      'Bu oturumda iki adimli dogrulama tamamlanmadi.',
      'MFA_REQUIRED', 403, { mfaRequired: true }
    );
  }
}

/**
 * Guard for a critical operation. `purpose` is recorded in the audit trail so "why did this
 * need a step-up" is answerable afterwards.
 */
function assertStepUp(session, purpose, now = Date.now()) {
  if (!STEP_UP_PURPOSES.includes(purpose)) {
    throw new Error(`Bilinmeyen step-up amaci: ${purpose}`);
  }
  if (!meets(session, 'step_up', now)) {
    throw assuranceError(
      'Bu islem icin kimliginizi yeniden dogrulamaniz gerekiyor.',
      'STEP_UP_REQUIRED', 403, { purpose, stepUpRequired: true }
    );
  }
  // Removing or regenerating factors must be authorised by a factor the account already
  // owns (or a recovery code), not by replaying the same password that an attacker may
  // have used to enter the account in the first place.
  if (purpose === 'mfa_change' && session.step_up_method === 'password') {
    throw assuranceError(
      'Bu islem icin mevcut iki adimli dogrulama yonteminizi kullanin.',
      'STEP_UP_FACTOR_REQUIRED', 403, { purpose, stepUpRequired: true }
    );
  }
}

module.exports = {
  LEVELS,
  STEP_UP_PURPOSES,
  assertPolicySatisfied,
  assertStepUp,
  assuranceError,
  describeAssurance,
  meets,
  mfaRequirement,
  sessionLevel,
};
