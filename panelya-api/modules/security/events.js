'use strict';

// A30 security events.
//
// These go through the EXISTING audit trail rather than a second store. A parallel security
// log would mean two places to look during an incident and two things to keep in sync, and
// the audit table already has the actor/organization/timestamp plumbing these events need.
//
// The one rule that matters here is what a payload may contain. A security event describes
// something that happened to a credential; it must never contain the credential. No TOTP
// secret, no recovery code, no WebAuthn challenge, no token, no full IP address — only the
// privacy-safe device summary the session row already holds.

const { auditLog } = require('../../services/audit');

const EVENTS = Object.freeze({
  NEW_DEVICE: 'SECURITY_NEW_DEVICE',
  REFRESH_REUSE: 'SECURITY_REFRESH_TOKEN_REUSE',
  MFA_ENABLED: 'SECURITY_MFA_ENABLED',
  MFA_DISABLED: 'SECURITY_MFA_DISABLED',
  MFA_FAILED: 'SECURITY_MFA_FAILED',
  RECOVERY_CODE_USED: 'SECURITY_RECOVERY_CODE_USED',
  RECOVERY_CODES_REGENERATED: 'SECURITY_RECOVERY_CODES_REGENERATED',
  PASSKEY_ADDED: 'SECURITY_PASSKEY_ADDED',
  PASSKEY_REMOVED: 'SECURITY_PASSKEY_REMOVED',
  PASSKEY_COUNTER_ANOMALY: 'SECURITY_PASSKEY_COUNTER_ANOMALY',
  SESSION_REVOKED: 'SECURITY_SESSION_REVOKED',
  OTHER_SESSIONS_REVOKED: 'SECURITY_OTHER_SESSIONS_REVOKED',
  STEP_UP_VERIFIED: 'SECURITY_STEP_UP_VERIFIED',
  MFA_POLICY_CHANGED: 'SECURITY_MFA_POLICY_CHANGED',
});

// Anything matching these keys is dropped before an event is written. The allowlist is the
// caller's responsibility, but a deny pass is what stops a future caller from casually
// spreading a secret into the audit trail.
const FORBIDDEN_KEYS = /secret|token|challenge|code_hash|password|otpauth|public_key|ciphertext/i;

function sanitize(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitize(value);
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 200);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Records one security event.
 *
 * Never throws: an audit write failing must not turn a successful login into a 500, and
 * must certainly not roll back the security change it was describing.
 */
async function record(req, { action, resourceType = 'security', resourceId = null, payload = {}, success = true, organizationId = null }) {
  try {
    await auditLog(req, {
      action,
      resourceType,
      resourceId: resourceId == null ? null : String(resourceId),
      newValue: sanitize(payload),
      success,
      organizationId,
    });
  } catch (_) { /* audit is best-effort; the security action already happened */ }
}

module.exports = { EVENTS, record, sanitize };
