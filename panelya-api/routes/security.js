'use strict';

// A30 account-security API: sessions, TOTP, recovery codes, passkeys and step-up.
//
// Serves BOTH actor types from one router. A super-admin's second factor and a tenant
// owner's second factor obey the same rules, and two parallel implementations would drift
// — which for authentication means one of them eventually being the weaker one.
//
// These endpoints are deliberately reachable while an account is in the enrolment-required
// state: that is the whole bootstrap. `requireMfaPolicy` is applied to the platform's
// business routes, never to the routes a person needs in order to comply with the policy.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { loadAssurance, ownerIdFromAuth, requireSession, requireStepUp } = require('../middleware/authSession');
const { rateLimit } = require('../middleware/security');
const sessionService = require('../modules/security/sessions');
const mfa = require('../modules/security/mfa');
const mfaCrypto = require('../modules/security/mfaCrypto');
const webauthn = require('../modules/security/webauthn');
const securityEvents = require('../modules/security/events');
const authAssurance = require('../modules/security/authAssurance');

const router = express.Router();

// Guessing a 6-digit code or a recovery code has to be expensive. DB-backed like every
// other limiter here, so it holds across processes rather than resetting on deploy.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.MFA_VERIFY_RATE_LIMIT || 10),
  message: 'Cok fazla dogrulama denemesi. Lutfen biraz sonra tekrar deneyin.',
});

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.MFA_SETUP_RATE_LIMIT || 30),
  message: 'Cok fazla guvenlik istegi. Lutfen biraz sonra tekrar deneyin.',
});

/** One-time secret material must not survive in any cache between us and the browser. */
function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

function actorOf(req) {
  return { actorType: req.auth.actorType, ownerId: ownerIdFromAuth(req.auth) };
}

/** Runs a handler on a pooled client in a transaction. Sessions/MFA are not tenant data. */
function securityRoute(run, { status = 200 } = {}) {
  return async (req, res, next) => {
    const client = await db.getSystemPool().connect();
    try {
      await client.query('begin');
      const result = await run({ req, res, client, actor: actorOf(req) });
      await client.query('commit');
      if (res.headersSent) return undefined;
      return res.status(result?.statusOverride || status).json(result?.body ?? result);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  };
}

// ---------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------

/**
 * Everything the UI needs to decide what to show, in one call.
 *
 * `enrollmentRequired` in particular: without it the admin would render the whole console
 * and discover the policy one 403 at a time.
 */
router.get('/summary', requireAuth, requireSession, securityRoute(async ({ req, client, actor }) => {
  const assurance = await loadAssurance(req);
  const [methods, credentials, recoveryCount, sessions] = await Promise.all([
    mfa.listMethods(client, actor),
    mfa.listCredentials(client, actor),
    mfa.countUnusedRecoveryCodes(client, actor),
    sessionService.listSessions(client, { ...actor, currentSessionId: req.authSession.id }),
  ]);
  return {
    assurance,
    methods,
    passkeys: credentials.map(mfa.publicCredential),
    recoveryCodesRemaining: recoveryCount,
    sessions,
    webauthnAvailable: webauthn.isConfigured(),
  };
}));

// ---------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------

router.get('/sessions', requireAuth, requireSession, securityRoute(async ({ req, client, actor }) => ({
  items: await sessionService.listSessions(client, { ...actor, currentSessionId: req.authSession.id }),
})));

router.post('/sessions/:id/revoke', requireAuth, requireSession, securityRoute(async ({ req, client, actor }) => {
  // Scoped by owner inside the query: knowing another user's session id achieves nothing.
  const revoked = await sessionService.revokeSession(client, {
    ...actor, sessionId: req.params.id, reason: 'user_revoked',
  });
  await securityEvents.record(req, {
    action: securityEvents.EVENTS.SESSION_REVOKED,
    resourceId: revoked.id,
    payload: { device: revoked.device_label },
  });
  return { session: revoked };
}));

router.post('/sessions/revoke-others', requireAuth, requireSession, securityRoute(async ({ req, client, actor }) => {
  // The current session is preserved on purpose: "log out my other devices" that also logs
  // you out is a feature nobody uses twice.
  const count = await sessionService.revokeOtherSessions(client, {
    ...actor, keepSessionId: req.authSession.id,
  });
  await securityEvents.record(req, {
    action: securityEvents.EVENTS.OTHER_SESSIONS_REVOKED,
    resourceId: req.authSession.id,
    payload: { revoked: count },
  });
  return { revoked: count };
}));

// ---------------------------------------------------------------------------------------
// Tenant MFA policy
// ---------------------------------------------------------------------------------------

function policyOrganization(req) {
  const organizationId = req.auth?.organizationId;
  if (req.auth?.actorType !== 'app' || !organizationId
      || !['owner', 'admin'].includes(req.auth?.role)) {
    throw authAssurance.assuranceError(
      'Guvenlik politikasini yonetme yetkiniz yok', 'MFA_POLICY_FORBIDDEN', 403
    );
  }
  return organizationId;
}

router.get('/policy', requireAuth, requireSession, securityRoute(async ({ req, client }) => {
  const organizationId = policyOrganization(req);
  const result = await client.query(
    `select require_mfa_for_owner, require_mfa_for_admin, updated_at
       from organization_security_policies where organization_id = $1`,
    [organizationId]
  );
  return {
    policy: result.rows[0] || {
      require_mfa_for_owner: false,
      require_mfa_for_admin: false,
      updated_at: null,
    },
  };
}));

router.put('/policy', requireAuth, requireSession, requireStepUp('mfa_change'),
  securityRoute(async ({ req, client, actor }) => {
    const organizationId = policyOrganization(req);
    const allowed = new Set(['require_mfa_for_owner', 'require_mfa_for_admin']);
    const unknown = Object.keys(req.body || {}).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw authAssurance.assuranceError('Bilinmeyen politika alani', 'MFA_POLICY_INVALID', 400);
    }
    const requireOwner = req.body?.require_mfa_for_owner;
    const requireAdmin = req.body?.require_mfa_for_admin;
    if (typeof requireOwner !== 'boolean' || typeof requireAdmin !== 'boolean') {
      throw authAssurance.assuranceError('Politika alanlari boolean olmali', 'MFA_POLICY_INVALID', 400);
    }
    const result = await client.query(
      `insert into organization_security_policies
         (organization_id, require_mfa_for_owner, require_mfa_for_admin, updated_by)
       values ($1,$2,$3,$4)
       on conflict (organization_id) do update set
         require_mfa_for_owner = excluded.require_mfa_for_owner,
         require_mfa_for_admin = excluded.require_mfa_for_admin,
         updated_by = excluded.updated_by,
         updated_at = now()
       returning require_mfa_for_owner, require_mfa_for_admin, updated_at`,
      [organizationId, requireOwner, requireAdmin, actor.ownerId]
    );
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.MFA_POLICY_CHANGED,
      resourceType: 'organization_security_policy',
      resourceId: organizationId,
      organizationId,
      payload: { require_mfa_for_owner: requireOwner, require_mfa_for_admin: requireAdmin },
    });
    return { policy: result.rows[0] };
  }));

// ---------------------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------------------

/**
 * Begins enrolment. The secret and the otpauth URI are returned exactly once, here.
 *
 * Deliberately NOT step-up gated: an account that owes an enrolment has no factor to step
 * up with, so requiring one would be a deadlock. Adding a SECOND factor when one already
 * exists is refused by the service, and disabling one IS step-up gated below.
 */
router.post('/totp/setup', requireAuth, requireSession, setupLimiter, requireStepUp('mfa_enrollment'),
  securityRoute(async ({ req, res, client, actor }) => {
    const accountName = req.auth.email || req.auth.username || String(actor.ownerId);
    const setup = await mfa.beginTotpSetup(client, { ...actor, accountName });
    noStore(res);
    return setup;
  }));

router.post('/totp/verify', requireAuth, requireSession, verifyLimiter,
  securityRoute(async ({ req, client, actor }) => {
    let method;
    try {
      method = await mfa.confirmTotpSetup(client, { ...actor, token: req.body?.token });
    } catch (error) {
      await securityEvents.record(req, {
        action: securityEvents.EVENTS.MFA_FAILED,
        payload: { stage: 'setup', reason: error.code || 'unknown' },
        success: false,
      });
      throw error;
    }
    // Enrolling proves possession right now, so the session becomes MFA-verified without a
    // second challenge — otherwise the user would immediately be asked for another code.
    await sessionService.markMfaVerified(client, { sessionId: req.authSession.id, method: 'totp' });
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.MFA_ENABLED,
      resourceId: method.id,
      payload: { type: 'totp' },
    });
    return { method };
  }));

router.post('/totp/disable', requireAuth, requireSession, requireStepUp('mfa_change'),
  securityRoute(async ({ req, client, actor }) => {
    // Removing the last factor from an account that is REQUIRED to have one would lock it
    // out of everything it is supposed to protect. Refused rather than allowed-then-broken.
    const credentials = await mfa.listCredentials(client, actor);
    const assurance = await loadAssurance(req);
    if (assurance.mfaRequired && credentials.length === 0) {
      throw authAssurance.assuranceError(
        'Bu hesap icin iki adimli dogrulama zorunlu. Once bir passkey ekleyin.',
        'MFA_REQUIRED_CANNOT_DISABLE', 409
      );
    }
    const method = await mfa.disableTotp(client, actor);
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.MFA_DISABLED,
      resourceId: method.id,
      payload: { type: 'totp' },
    });
    return { method };
  }));

// ---------------------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------------------

router.post('/recovery-codes/regenerate', requireAuth, requireSession, requireStepUp('mfa_change'),
  securityRoute(async ({ req, res, client, actor }) => {
    const result = await mfa.regenerateRecoveryCodes(client, actor);
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.RECOVERY_CODES_REGENERATED,
      payload: { generation: result.generation, count: result.codes.length },
    });
    noStore(res);
    // The raw codes exist here and nowhere else. There is no endpoint that can show them
    // again, by design.
    return { codes: result.codes, generation: result.generation };
  }));

// ---------------------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------------------

router.get('/passkeys', requireAuth, requireSession, securityRoute(async ({ client, actor }) => ({
  items: (await mfa.listCredentials(client, actor)).map(mfa.publicCredential),
})));

router.post('/passkeys/registration-options', requireAuth, requireSession, setupLimiter, requireStepUp('mfa_enrollment'),
  securityRoute(async ({ req, res, client, actor }) => {
    const existing = await mfa.listCredentials(client, actor);
    const options = await webauthn.registrationOptions({
      ...actor,
      accountName: req.auth.email || req.auth.username || String(actor.ownerId),
      displayName: req.auth.name || req.auth.username || '',
      existingCredentials: existing,
    });
    // The challenge is held server-side and single-use: accepting a client-supplied one
    // would make the whole ceremony replayable.
    const challenge = await client.query(
      `insert into webauthn_challenges (actor_type, ${actor.actorType === 'admin' ? 'admin_id' : 'user_id'}, purpose, challenge, session_id, expires_at)
       values ($1,$2,'registration',$3,$4, now() + make_interval(secs => $5))
       returning id`,
      [actor.actorType, actor.ownerId, options.challenge, req.authSession.id, webauthn.CHALLENGE_TTL_SECONDS]
    );
    noStore(res);
    return { options, challengeId: challenge.rows[0].id };
  }));

router.post('/passkeys/register', requireAuth, requireSession, setupLimiter, requireStepUp('mfa_enrollment'),
  securityRoute(async ({ req, client, actor }) => {
    const response = req.body?.response;
    if (!response || typeof response !== 'object') {
      throw webauthn.webauthnError('Passkey yaniti eksik', 'WEBAUTHN_RESPONSE_REQUIRED', 400);
    }
    const challengeId = String(req.body?.challengeId || '').trim();
    if (!challengeId) {
      throw webauthn.webauthnError('Passkey oturum kimligi eksik', 'WEBAUTHN_CHALLENGE_REQUIRED', 400);
    }
    const owner = actor.actorType === 'admin' ? 'admin_id' : 'user_id';
    // Consumed in the same statement that reads it, so a replayed response cannot find its
    // challenge still unused.
    const challengeRow = await client.query(
      `update webauthn_challenges set used_at = now()
        where id = (
          select id from webauthn_challenges
           where id = $3 and actor_type = $1 and ${owner} = $2 and purpose = 'registration'
             and session_id = $4 and used_at is null and expires_at > now()
           limit 1 for update skip locked
        )
       returning challenge`,
      [actor.actorType, actor.ownerId, challengeId, req.authSession.id]
    );
    if (!challengeRow.rows[0]) {
      throw webauthn.webauthnError('Passkey oturumu gecersiz veya suresi dolmus', 'WEBAUTHN_CHALLENGE_INVALID', 400);
    }

    const verified = await webauthn.verifyRegistration({
      response,
      expectedChallenge: challengeRow.rows[0].challenge,
    });

    const duplicate = await client.query(
      'select id from webauthn_credentials where credential_id = $1',
      [verified.credentialId]
    );
    if (duplicate.rows[0]) {
      throw webauthn.webauthnError('Bu passkey zaten kayitli', 'WEBAUTHN_CREDENTIAL_EXISTS', 409);
    }

    const name = String(req.body?.name || '').trim().slice(0, 60) || 'Passkey';
    const inserted = await client.query(
      `insert into webauthn_credentials
         (actor_type, ${owner}, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        actor.actorType, actor.ownerId, verified.credentialId, verified.publicKey,
        verified.counter, verified.transports, verified.deviceType, verified.backedUp,
        verified.aaguid, name,
      ]
    );
    // Registering proves user verification right now, so it counts as an MFA proof.
    await sessionService.markMfaVerified(client, { sessionId: req.authSession.id, method: 'webauthn' });
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.PASSKEY_ADDED,
      resourceId: inserted.rows[0].id,
      payload: { name, device_type: verified.deviceType, backed_up: verified.backedUp },
    });
    return { statusOverride: 201, body: { passkey: mfa.publicCredential(inserted.rows[0]) } };
  }));

router.put('/passkeys/:id', requireAuth, requireSession, securityRoute(async ({ req, client, actor }) => {
  const owner = actor.actorType === 'admin' ? 'admin_id' : 'user_id';
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) throw webauthn.webauthnError('Passkey adi zorunlu', 'WEBAUTHN_NAME_REQUIRED', 400);
  const updated = await client.query(
    `update webauthn_credentials set name = $4
      where id = $3 and actor_type = $1 and ${owner} = $2 and revoked_at is null
     returning *`,
    [actor.actorType, actor.ownerId, req.params.id, name]
  );
  if (!updated.rows[0]) throw webauthn.webauthnError('Passkey bulunamadi', 'WEBAUTHN_NOT_FOUND', 404);
  return { passkey: mfa.publicCredential(updated.rows[0]) };
}));

router.delete('/passkeys/:id', requireAuth, requireSession, requireStepUp('mfa_change'),
  securityRoute(async ({ req, client, actor }) => {
    const owner = actor.actorType === 'admin' ? 'admin_id' : 'user_id';
    const assurance = await loadAssurance(req);
    const credentials = await mfa.listCredentials(client, actor);
    const totpMethod = await mfa.activeTotpMethod(client, actor);
    // Same rule as disabling TOTP: an account required to hold a factor may not remove its
    // last one.
    if (assurance.mfaRequired && credentials.length <= 1 && !totpMethod) {
      throw authAssurance.assuranceError(
        'Bu hesap icin iki adimli dogrulama zorunlu. Son passkey silinemez.',
        'MFA_REQUIRED_CANNOT_DISABLE', 409
      );
    }
    const revoked = await client.query(
      `update webauthn_credentials set revoked_at = now()
        where id = $3 and actor_type = $1 and ${owner} = $2 and revoked_at is null
       returning *`,
      [actor.actorType, actor.ownerId, req.params.id]
    );
    if (!revoked.rows[0]) throw webauthn.webauthnError('Passkey bulunamadi', 'WEBAUTHN_NOT_FOUND', 404);
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.PASSKEY_REMOVED,
      resourceId: revoked.rows[0].id,
      payload: { name: revoked.rows[0].name },
    });
    return { passkey: mfa.publicCredential(revoked.rows[0]) };
  }));

// ---------------------------------------------------------------------------------------
// Step-up / MFA challenge
// ---------------------------------------------------------------------------------------

router.get('/step-up/status', requireAuth, requireSession, securityRoute(async ({ req, client, actor }) => {
  const assurance = await loadAssurance(req);
  const totpMethod = await mfa.activeTotpMethod(client, actor);
  const credentials = await mfa.listCredentials(client, actor);
  const recoveryCount = await mfa.countUnusedRecoveryCodes(client, actor);
  return {
    assurance,
    // What the step-up dialog may offer. Showing a factor the account does not hold would
    // send the user looking for an authenticator app they never set up.
    available: {
      password: req.auth.actorType === 'app' || req.auth.actorType === 'admin',
      totp: Boolean(totpMethod),
      webauthn: credentials.length > 0 && webauthn.isConfigured(),
      recovery_code: recoveryCount > 0,
    },
  };
}));

async function verifyPassword(client, { actorType, ownerId, password }) {
  const table = actorType === 'admin' ? 'admins' : 'app_users';
  const result = await client.query(
    `select password_hash from ${table} where id = $1 limit 1`,
    [ownerId]
  );
  const hash = result.rows[0]?.password_hash;
  // Same canonical comparison the login routes use; a second implementation is a second
  // place for a timing or a truncation bug.
  if (!hash) return false;
  return bcrypt.compare(String(password || ''), hash);
}

/**
 * Proves a factor and raises the session.
 *
 * One endpoint for both "complete the MFA challenge for this session" and "step up for a
 * critical operation", because they are the same act: prove a factor now. The session
 * records both consequences.
 */
router.post('/step-up/verify', requireAuth, requireSession, verifyLimiter,
  securityRoute(async ({ req, client, actor }) => {
    const method = String(req.body?.method || '').trim();
    let verifiedMethod = null;

    if (method === 'password') {
      const ok = await verifyPassword(client, { ...actor, password: req.body?.password });
      if (!ok) {
        await securityEvents.record(req, {
          action: securityEvents.EVENTS.MFA_FAILED,
          payload: { method: 'password' }, success: false,
        });
        throw authAssurance.assuranceError('Sifre hatali', 'STEP_UP_INVALID', 400);
      }
      verifiedMethod = 'password';
    } else if (method === 'totp') {
      await mfa.verifyTotp(client, { ...actor, token: req.body?.token });
      verifiedMethod = 'totp';
    } else if (method === 'recovery_code') {
      await mfa.consumeRecoveryCode(client, {
        ...actor, code: req.body?.code, sessionId: req.authSession.id,
      });
      await securityEvents.record(req, {
        action: securityEvents.EVENTS.RECOVERY_CODE_USED,
        resourceId: req.authSession.id,
        payload: { remaining: await mfa.countUnusedRecoveryCodes(client, actor) },
      });
      verifiedMethod = 'recovery_code';
    } else {
      throw authAssurance.assuranceError('Desteklenmeyen dogrulama yontemi', 'STEP_UP_METHOD_INVALID', 400);
    }

    // A password re-entry proves it is still the same person, which is what a step-up is
    // for — but it is NOT a second factor and must never raise the session to `mfa`.
    if (verifiedMethod === 'password') {
      await sessionService.markStepUp(client, { sessionId: req.authSession.id, method: verifiedMethod });
    } else {
      await sessionService.markMfaVerified(client, { sessionId: req.authSession.id, method: verifiedMethod });
    }
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.STEP_UP_VERIFIED,
      resourceId: req.authSession.id,
      payload: { method: verifiedMethod },
    });
    const assurance = await loadAssurance(req);
    return { assurance, method: verifiedMethod };
  }));

router.post('/step-up/webauthn/options', requireAuth, requireSession, verifyLimiter,
  securityRoute(async ({ req, res, client, actor }) => {
    const credentials = await mfa.listCredentials(client, actor);
    if (!credentials.length) {
      throw webauthn.webauthnError('Kayitli passkey yok', 'WEBAUTHN_NO_CREDENTIAL', 404);
    }
    const options = await webauthn.authenticationOptions({ allowCredentials: credentials });
    const challenge = await client.query(
      `insert into webauthn_challenges (actor_type, ${actor.actorType === 'admin' ? 'admin_id' : 'user_id'}, purpose, challenge, session_id, expires_at)
       values ($1,$2,'step_up',$3,$4, now() + make_interval(secs => $5))
       returning id`,
      [actor.actorType, actor.ownerId, options.challenge, req.authSession.id, webauthn.CHALLENGE_TTL_SECONDS]
    );
    noStore(res);
    return { options, challengeId: challenge.rows[0].id };
  }));

router.post('/step-up/webauthn/verify', requireAuth, requireSession, verifyLimiter,
  securityRoute(async ({ req, client, actor }) => {
    const response = req.body?.response;
    if (!response || typeof response !== 'object') {
      throw webauthn.webauthnError('Passkey yaniti eksik', 'WEBAUTHN_RESPONSE_REQUIRED', 400);
    }
    const challengeId = String(req.body?.challengeId || '').trim();
    if (!challengeId) {
      throw webauthn.webauthnError('Passkey oturum kimligi eksik', 'WEBAUTHN_CHALLENGE_REQUIRED', 400);
    }
    const owner = actor.actorType === 'admin' ? 'admin_id' : 'user_id';
    const challengeRow = await client.query(
      `update webauthn_challenges set used_at = now()
        where id = (
          select id from webauthn_challenges
           where id = $3 and actor_type = $1 and ${owner} = $2 and purpose = 'step_up'
             and session_id = $4 and used_at is null and expires_at > now()
           limit 1 for update skip locked
        )
       returning challenge`,
      [actor.actorType, actor.ownerId, challengeId, req.authSession.id]
    );
    if (!challengeRow.rows[0]) {
      throw webauthn.webauthnError('Passkey oturumu gecersiz veya suresi dolmus', 'WEBAUTHN_CHALLENGE_INVALID', 400);
    }

    // The credential must belong to THIS account: a valid assertion for somebody else's
    // passkey is still somebody else's.
    const stored = await client.query(
      `select * from webauthn_credentials
        where credential_id = $3 and actor_type = $1 and ${owner} = $2 and revoked_at is null
        limit 1 for update`,
      [actor.actorType, actor.ownerId, String(response.id || '')]
    );
    if (!stored.rows[0]) {
      throw webauthn.webauthnError('Passkey bulunamadi', 'WEBAUTHN_NOT_FOUND', 404);
    }

    const verified = await webauthn.verifyAuthentication({
      response,
      expectedChallenge: challengeRow.rows[0].challenge,
      credential: stored.rows[0],
    });

    await client.query(
      `update webauthn_credentials
          set counter = $2, last_used_at = now(), backed_up = $3, device_type = coalesce($4, device_type)
        where id = $1`,
      [stored.rows[0].id, verified.newCounter, verified.backedUp, verified.deviceType]
    );
    if (verified.counterAnomaly) {
      // Recorded as a signal, not a verdict: synced passkeys legitimately report a
      // non-increasing counter, so calling this a clone would cry wolf on ordinary users.
      await securityEvents.record(req, {
        action: securityEvents.EVENTS.PASSKEY_COUNTER_ANOMALY,
        resourceId: stored.rows[0].id,
        payload: { device_type: verified.deviceType, backed_up: verified.backedUp },
        success: false,
      });
    }
    await sessionService.markMfaVerified(client, { sessionId: req.authSession.id, method: 'webauthn' });
    await securityEvents.record(req, {
      action: securityEvents.EVENTS.STEP_UP_VERIFIED,
      resourceId: req.authSession.id,
      payload: { method: 'webauthn' },
    });
    return { assurance: await loadAssurance(req), method: 'webauthn' };
  }));

module.exports = router;
