'use strict';

// A30 WebAuthn / passkeys.
//
// The cryptography is @simplewebauthn/server's, not ours. What this module owns is the
// configuration and the trust decisions the library deliberately refuses to guess:
//
//   * The RP ID and the expected origins come from SERVER CONFIG, never from the request.
//     Deriving them from Host, X-Forwarded-Host or Origin would let a caller nominate the
//     domain their assertion is valid for, which is the whole attack WebAuthn's origin
//     binding exists to prevent. In particular an A27 tenant custom domain must NEVER end
//     up in the admin console's origin allowlist — a tenant controls that hostname.
//   * User verification is REQUIRED. A passkey used as a second factor or a step-up proof
//     has to prove a person was present and identified, not just that a key was reachable.
//
// Written against the v13 API (`registrationInfo.credential`, `credential` on verify), read
// from the installed .d.ts rather than from memory of older releases.

const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require('@simplewebauthn/server');

const CHALLENGE_TTL_SECONDS = 300;

function webauthnError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * The relying-party configuration. Missing config is a hard failure rather than a guessed
 * default: a wrong RP ID silently produces passkeys that work on a domain we did not mean.
 */
function rpConfig(env = process.env) {
  const rpID = String(env.WEBAUTHN_RP_ID || '').trim().toLowerCase();
  const rpName = String(env.WEBAUTHN_RP_NAME || 'Panelya').trim().slice(0, 80);
  const origins = String(env.WEBAUTHN_EXPECTED_ORIGINS || '')
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!rpID || !origins.length) {
    throw webauthnError(
      'Passkey yapilandirmasi eksik', 'WEBAUTHN_NOT_CONFIGURED', 503
    );
  }
  // An exact allowlist. A wildcard or a suffix match would re-open exactly what the origin
  // check is for.
  for (const origin of origins) {
    if (origin.includes('*')) {
      throw webauthnError('Passkey origin listesi joker karakter iceremez', 'WEBAUTHN_ORIGIN_WILDCARD', 500);
    }
  }
  return { rpID, rpName, origins };
}

function isConfigured(env = process.env) {
  try {
    rpConfig(env);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * A stable, opaque WebAuthn user handle. It is the account id, which the authenticator
 * stores and hands back on a discoverable login — so it must be stable for the life of the
 * account and must not be something the client can choose.
 */
function userHandle({ actorType, ownerId }) {
  return Buffer.from(`${actorType}:${ownerId}`, 'utf8');
}

function parseUserHandle(value) {
  let raw = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  // Browser JSON responses carry ArrayBuffer values as base64url strings. Accept the raw
  // form as well for server-side callers/tests, but never treat an arbitrary undecodable
  // string as an identity.
  if (!/^(app|admin):/i.test(raw) && raw) {
    try { raw = Buffer.from(raw, 'base64url').toString('utf8'); } catch (_) { return null; }
  }
  const app = /^app:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  if (app) return { actorType: 'app', ownerId: app[1] };
  // The existing admins table predates the app_users UUID model and has a bigint key.
  const admin = /^admin:([1-9][0-9]{0,18})$/.exec(raw);
  return admin ? { actorType: 'admin', ownerId: admin[1] } : null;
}

async function registrationOptions({
  actorType, ownerId, accountName, displayName, existingCredentials = [], env = process.env,
}) {
  const { rpID, rpName } = rpConfig(env);
  return generateRegistrationOptions({
    rpName,
    rpID,
    userID: userHandle({ actorType, ownerId }),
    userName: String(accountName || 'user').slice(0, 100),
    userDisplayName: String(displayName || accountName || 'user').slice(0, 100),
    // 'none' because we do not run an attestation policy: asking for attestation we never
    // check would collect device identifiers for nothing.
    attestationType: 'none',
    // Registering the same authenticator twice would create a second credential the user
    // cannot tell apart from the first.
    excludeCredentials: existingCredentials.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports || undefined,
    })),
    authenticatorSelection: {
      // Discoverable, so the credential can identify its own account and a login does not
      // have to start by naming the user.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    timeout: CHALLENGE_TTL_SECONDS * 1000,
  });
}

async function verifyRegistration({ response, expectedChallenge, env = process.env }) {
  const { rpID, origins } = rpConfig(env);
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo) {
    throw webauthnError('Passkey dogrulanamadi', 'WEBAUTHN_REGISTRATION_FAILED', 400);
  }
  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: Number(credential.counter || 0),
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: Boolean(credentialBackedUp),
    aaguid: aaguid || null,
  };
}

async function authenticationOptions({ allowCredentials = [], env = process.env } = {}) {
  const { rpID } = rpConfig(env);
  return generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    // An empty allow-list is what makes a discoverable login possible: the authenticator
    // picks the credential and tells us whose it is, rather than us naming it first.
    allowCredentials: allowCredentials.length
      ? allowCredentials.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports || undefined,
      }))
      : undefined,
    timeout: CHALLENGE_TTL_SECONDS * 1000,
  });
}

/**
 * Verifies an assertion against ONE stored credential.
 *
 * The counter comes back from the library's own verification, which already implements the
 * modern multi-device semantics — a synced passkey legitimately reports 0 forever, so a
 * naive `newCounter > oldCounter` rule would lock those users out. The caller persists the
 * new value and treats a genuine regression as a signal, not a certainty.
 */
async function verifyAuthentication({ response, expectedChallenge, credential, env = process.env }) {
  const { rpID, origins } = rpConfig(env);
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: credential.credential_id,
      publicKey: new Uint8Array(credential.public_key),
      counter: Number(credential.counter || 0),
      transports: credential.transports || undefined,
    },
  });
  if (!result.verified) {
    throw webauthnError('Passkey dogrulanamadi', 'WEBAUTHN_AUTHENTICATION_FAILED', 400);
  }
  const info = result.authenticationInfo;
  const storedCounter = Number(credential.counter || 0);
  return {
    credentialId: info.credentialID,
    newCounter: Number(info.newCounter || 0),
    userVerified: Boolean(info.userVerified),
    deviceType: info.credentialDeviceType,
    backedUp: Boolean(info.credentialBackedUp),
    // A counter that went backwards on a single-device authenticator is worth recording.
    // It is reported as an anomaly to audit, not as proof of cloning: synced credentials
    // report 0, and calling that an attack would cry wolf on ordinary users.
    counterAnomaly: storedCounter > 0
      && Number(info.newCounter || 0) > 0
      && Number(info.newCounter) <= storedCounter,
  };
}

module.exports = {
  CHALLENGE_TTL_SECONDS,
  authenticationOptions,
  isConfigured,
  parseUserHandle,
  registrationOptions,
  rpConfig,
  userHandle,
  verifyAuthentication,
  verifyRegistration,
  webauthnError,
};
