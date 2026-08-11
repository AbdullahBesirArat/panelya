'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { authenticator } = require('otplib');

const assurance = require('../modules/security/authAssurance');
const device = require('../modules/security/deviceMetadata');
const events = require('../modules/security/events');
const mfaCrypto = require('../modules/security/mfaCrypto');
const sessions = require('../modules/security/sessions');
const totp = require('../modules/security/totp');
const webauthn = require('../modules/security/webauthn');

const MFA_ENV = { MFA_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
const RP_ENV = {
  WEBAUTHN_RP_ID: 'admin.example.test',
  WEBAUTHN_RP_NAME: 'Panelya Test',
  WEBAUTHN_EXPECTED_ORIGINS: 'https://admin.example.test,https://preview.example.test',
};

async function withProcessEnv(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('MFA secret encryption is randomised, owner-bound and authenticated', () => {
  const context = { actorType: 'app', ownerId: '11111111-1111-4111-8111-111111111111' };
  const first = mfaCrypto.encryptSecret('totp-seed', context, MFA_ENV);
  const second = mfaCrypto.encryptSecret('totp-seed', context, MFA_ENV);
  assert.notEqual(first, second);
  assert.equal(mfaCrypto.decryptSecret(first, context, MFA_ENV), 'totp-seed');
  assert.throws(
    () => mfaCrypto.decryptSecret(first, { ...context, ownerId: '22222222-2222-4222-8222-222222222222' }, MFA_ENV),
    (error) => error.code === 'MFA_SECRET_UNREADABLE'
  );
});

test('recovery codes are unique, high-entropy shaped, normalized and hash-only', () => {
  const codes = mfaCrypto.generateRecoveryCodes();
  assert.equal(codes.length, mfaCrypto.RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-TV-Z2-9]{5}-[A-HJ-NP-TV-Z2-9]{5}$/);
  assert.equal(mfaCrypto.hashRecoveryCode(codes[0]), mfaCrypto.hashRecoveryCode(codes[0].toLowerCase().replace('-', ' ')));
  assert.doesNotMatch(mfaCrypto.hashRecoveryCode(codes[0]), new RegExp(codes[0].replace('-', ''), 'i'));
});

test('TOTP policy accepts a real library code and reports its replay step', () => {
  const secret = totp.generateSecret();
  const instance = authenticator.clone({ algorithm: totp.ALGORITHM, digits: totp.DIGITS, step: totp.STEP_SECONDS, window: 0 });
  const token = instance.generate(secret);
  const verified = totp.verifyCode({ secret, token });
  assert.equal(verified.step, totp.currentStep());
  assert.equal(totp.verifyCode({ secret, token: '000000' })?.step === verified.step, false);
  assert.equal(totp.verifyCode({ secret, token: 'abc' }), null);
});

test('step-up expires against the central bounded TTL', () => {
  const now = Date.now();
  const recent = { mfa_level: 'mfa', step_up_verified_at: new Date(now - 1_000).toISOString(), step_up_method: 'totp' };
  const expired = { ...recent, step_up_verified_at: new Date(now - ((sessions.STEP_UP_TTL_MINUTES + 1) * 60_000)).toISOString() };
  assert.equal(assurance.sessionLevel(recent, now), 'step_up');
  assert.equal(assurance.sessionLevel(expired, now), 'mfa');
  assert.doesNotThrow(() => assurance.assertStepUp(recent, 'billing', now));
  assert.throws(() => assurance.assertStepUp(expired, 'billing', now), (error) => error.code === 'STEP_UP_REQUIRED');
});

test('MFA removal rejects password-only step-up but permits a current factor', () => {
  const now = Date.now();
  const base = { mfa_level: 'mfa', step_up_verified_at: new Date(now).toISOString() };
  assert.throws(
    () => assurance.assertStepUp({ ...base, step_up_method: 'password' }, 'mfa_change', now),
    (error) => error.code === 'STEP_UP_FACTOR_REQUIRED'
  );
  assert.doesNotThrow(() => assurance.assertStepUp({ ...base, step_up_method: 'webauthn' }, 'mfa_change', now));
});

test('WebAuthn configuration is exact and refuses wildcard or missing origins', () => {
  assert.deepEqual(webauthn.rpConfig(RP_ENV), {
    rpID: 'admin.example.test', rpName: 'Panelya Test',
    origins: ['https://admin.example.test', 'https://preview.example.test'],
  });
  assert.throws(
    () => webauthn.rpConfig({ ...RP_ENV, WEBAUTHN_EXPECTED_ORIGINS: 'https://*.example.test' }),
    (error) => error.code === 'WEBAUTHN_ORIGIN_WILDCARD'
  );
  assert.throws(() => webauthn.rpConfig({}), (error) => error.code === 'WEBAUTHN_NOT_CONFIGURED');
});

test('discoverable WebAuthn user handles round-trip from browser base64url', () => {
  const identity = { actorType: 'admin', ownerId: '42' };
  const handle = webauthn.userHandle(identity);
  assert.deepEqual(webauthn.parseUserHandle(handle.toString('base64url')), identity);
  assert.equal(webauthn.parseUserHandle(Buffer.from('app:not-a-uuid').toString('base64url')), null);
});

test('registration options require discoverable credentials and user verification', async () => {
  const options = await webauthn.registrationOptions({
    actorType: 'app', ownerId: '44444444-4444-4444-8444-444444444444',
    accountName: 'owner@example.test', displayName: 'Owner', env: RP_ENV,
  });
  assert.equal(options.rp.id, RP_ENV.WEBAUTHN_RP_ID);
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.equal(options.attestation, 'none');
});

test('authentication options support no-argument discoverable login without an allow-list', async () => {
  const options = await withProcessEnv(
    RP_ENV,
    () => webauthn.authenticationOptions()
  );
  assert.match(options.challenge, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(options.rpId, RP_ENV.WEBAUTHN_RP_ID);
  assert.equal(options.userVerification, 'required');
  assert.equal(options.allowCredentials, undefined);
});

test('authentication options preserve an explicit credential allow-list', async () => {
  const credential = {
    credential_id: Buffer.from('credential-id').toString('base64url'),
    transports: ['internal'],
  };
  const options = await webauthn.authenticationOptions({
    allowCredentials: [credential],
    env: RP_ENV,
  });
  assert.deepEqual(options.allowCredentials, [{
    id: credential.credential_id,
    transports: credential.transports,
    type: 'public-key',
  }]);
  assert.equal(options.userVerification, 'required');
});

test('device metadata stores a bounded summary, hash and network prefix, never raw values', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/130.0.0.0 Safari/537.36';
  const described = device.describeRequest({ ip: '203.0.113.77', get: () => ua });
  assert.equal(described.userAgentSummary, 'Chrome · Windows');
  assert.equal(described.ipPrefix, '203.0.113.0/24');
  assert.match(described.userAgentHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(described).includes(ua));
  assert.equal(device.ipPrefix('::ffff:198.51.100.42'), '198.51.100.0/24');
});

test('security event sanitization recursively drops credential material', () => {
  const clean = events.sanitize({
    method: 'totp', password: 'bad', challenge: 'nonce', nested: { token: 'secret', device: 'Chrome' },
  });
  assert.deepEqual(clean, { method: 'totp', nested: { device: 'Chrome' } });
});

test('real critical route seams are step-up gated before handlers', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
  assert.match(read('platform.js'), /\/impersonate', platformWriteLimiter, requireStepUp\('impersonation'\)/);
  assert.match(read('platform.js'), /\/plan', platformWriteLimiter, requireStepUp\('billing'\)/);
  assert.match(read('integrations.js'), /\/api-keys', requireAuth, requireRole\(MANAGE_ROLES\), writeLimiter, requireStepUp\('integration_secret'\)/);
  assert.match(read('domains.js'), /router\.delete\('\/:id'.*requireStepUp\('domain_release'\)/);
  assert.match(read('returns.js'), /\/refunds'.*requireStepUp\('refund'\)/);
  assert.match(read('subscriptionOperations.js'), /\/grant', requireBillingStepUp/);
});

test('security API is mounted before the central business-route MFA policy gate', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const securityMount = server.indexOf("app.use('/api/security', securityRoutes)");
  const policyGate = server.indexOf('app.use(requireMfaPolicy)');
  const firstBusinessRoute = server.indexOf("app.use('/api/products', productRoutes)");
  assert.ok(securityMount > 0 && securityMount < policyGate && policyGate < firstBusinessRoute);
});

test('challenge migration separates discoverable login from session-bound ceremonies', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '070_auth_session_challenge_invariants.sql'), 'utf8'
  );
  assert.match(migration, /purpose = 'authentication'[\s\S]*actor_type is null[\s\S]*session_id is null/);
  assert.match(migration, /purpose in \('registration', 'step_up'\)[\s\S]*session_id is not null/);
});
