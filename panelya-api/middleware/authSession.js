'use strict';

// A30 session binding and assurance guards.
//
// `requireAuth` proves a token is well-formed and unexpired. That is not enough on its own:
// a token stays cryptographically valid until it expires, so without a server-side check a
// "log out this device" would do nothing for the next fifteen minutes. These middlewares
// resolve the session the token names and make every session-level decision in one place.
//
// Sessions are looked up on the SYSTEM connection because auth_sessions is not tenant data
// — a person's devices are theirs across every organization they belong to — and because
// the tenant context is not established yet when authentication runs.

const db = require('../db');
const sessions = require('../modules/security/sessions');
const authAssurance = require('../modules/security/authAssurance');

function ownerIdFromAuth(auth) {
  return auth.actorType === 'admin' ? auth.sub : (auth.userId || auth.sub);
}

/**
 * Resolves req.auth.sid into req.authSession.
 *
 * A token WITHOUT a sid is accepted and left session-less. That is deliberate and
 * temporary: tokens issued before this deploy have no sid, and rejecting them would log
 * every admin out at the moment A30 ships. They expire within the access-token lifetime and
 * every refresh after that issues a bound one. What such a token cannot do is pass any
 * assurance guard below, because those require a session.
 */
async function attachSession(req, res, next) {
  try {
    if (!req.auth || !req.auth.sid) return next();
    // An impersonation token names the impersonated tenant, not a device session of the
    // acting admin, so it carries no sid and never reaches here.
    const client = await db.getSystemPool().connect();
    try {
      const session = await sessions.loadActiveSession(client, {
        sessionId: req.auth.sid,
        actorType: req.auth.actorType,
        ownerId: ownerIdFromAuth(req.auth),
      });
      if (!session) {
        // The token is valid but its session is gone: revoked, expired, or belonging to
        // somebody else. This is the check that makes a revoke take effect at once.
        return res.status(401).json({
          error: 'Oturum sonlandirilmis', code: 'SESSION_REVOKED',
        });
      }
      req.authSession = session;
      await sessions.touchSession(client, session.id);
    } finally {
      client.release();
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/** A session is mandatory here, so a pre-A30 token cannot slip past an assurance check. */
function requireSession(req, res, next) {
  if (!req.authSession) {
    return res.status(401).json({
      error: 'Oturum dogrulanamadi', code: 'SESSION_REQUIRED',
    });
  }
  return next();
}

async function loadAssurance(req) {
  const client = await db.getSystemPool().connect();
  try {
    return await authAssurance.describeAssurance(client, {
      session: req.authSession,
      actorType: req.auth.actorType,
      ownerId: ownerIdFromAuth(req.auth),
      role: req.auth.role,
      organizationId: req.auth.organizationId || null,
    });
  } finally {
    client.release();
  }
}

/**
 * Enforces the MFA policy for an ordinary authenticated endpoint. Answers with a
 * machine-readable code so the UI can send the user to enrolment or a challenge rather
 * than showing them a generic failure they cannot act on.
 */
function requireMfaPolicy(req, res, next) {
  (async () => {
    // Public/storefront/customer/API-key routes do not carry an admin/app JWT and must
    // remain completely outside A30. Impersonation tokens intentionally have no device
    // session; they may use ordinary tenant screens, while every critical route still
    // fails closed in requireStepUp because it requires a real session.
    if (!req.auth || req.auth.impersonated) return next();
    if (!req.authSession) {
      return res.status(401).json({ error: 'Oturum dogrulanamadi', code: 'SESSION_REQUIRED' });
    }
    const assurance = await loadAssurance(req);
    req.authAssurance = assurance;
    try {
      authAssurance.assertPolicySatisfied(assurance);
    } catch (error) {
      return res.status(error.status || 403).json({
        error: error.message, code: error.code, ...(error.meta || {}),
      });
    }
    return next();
  })().catch(next);
}

/**
 * Enforces a recent re-authentication for a critical operation.
 *
 * Applied at the route, in the backend. Hiding a button is not a control: the endpoint is
 * what an attacker reaches, and it is the endpoint that has to refuse.
 */
function requireStepUp(purpose) {
  return (req, res, next) => {
    (async () => {
      if (!req.auth) return res.status(401).json({ error: 'Oturum gerekli' });
      if (!req.authSession) {
        return res.status(401).json({ error: 'Oturum dogrulanamadi', code: 'SESSION_REQUIRED' });
      }
      const assurance = req.authAssurance || await loadAssurance(req);
      req.authAssurance = assurance;
      try {
        // Enrollment is the one deliberate exception: a required user with no factor must
        // be able to re-enter their password and add the first one. Every business purpose
        // remains policy-gated, so enrollment never becomes a bypass to critical work.
        if (purpose !== 'mfa_enrollment') authAssurance.assertPolicySatisfied(assurance);
        authAssurance.assertStepUp(req.authSession, purpose);
      } catch (error) {
        return res.status(error.status || 403).json({
          error: error.message, code: error.code, ...(error.meta || {}),
        });
      }
      return next();
    })().catch(next);
  };
}

module.exports = {
  attachSession,
  loadAssurance,
  ownerIdFromAuth,
  requireMfaPolicy,
  requireSession,
  requireStepUp,
};
