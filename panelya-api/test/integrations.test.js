'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const apiKeys = require('../modules/integrations/apiKeys');
const { SCOPES, hasScope, normalizeScopes } = require('../modules/integrations/scopes');
const { isAllowed, normalizeAllowlist } = require('../modules/integrations/ipAllowlist');
const secretCrypto = require('../modules/integrations/secretCrypto');
const signature = require('../modules/integrations/signature');
const { isPublicAddress, validateWebhookUrl } = require('../modules/integrations/webhookUrl');
const events = require('../modules/integrations/events');
const worker = require('../modules/integrations/worker');
const service = require('../modules/integrations/service');

const TEST_ENV = { WEBHOOK_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
const PROD_ENV = { NODE_ENV: 'production' };

// ---------------------------------------------------------------------------------------
// API key material
// ---------------------------------------------------------------------------------------

test('a generated key carries a public prefix and a full-entropy secret', () => {
  const first = apiKeys.generateApiKey();
  const second = apiKeys.generateApiKey();
  assert.match(first.prefix, /^pk_[0-9a-f]{12}$/);
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.token, `${first.prefix}.${first.secret}`);
  assert.notEqual(first.secret, second.secret);
  assert.notEqual(first.prefix, second.prefix);
  // 32 random bytes: the reason a plain sha256 is the right primitive here rather than a
  // password KDF. If this ever shrinks, the hashing decision has to be revisited.
  assert.equal(Buffer.from(first.secret, 'base64url').length, 32);
});

test('only the hash is derivable from the stored value, never the secret', () => {
  const key = apiKeys.generateApiKey();
  assert.match(key.secretHash, /^[0-9a-f]{64}$/);
  assert.notEqual(key.secretHash, key.secret);
  assert.ok(!key.secretHash.includes(key.secret));
  // The hash is deterministic, so verification needs no stored salt.
  assert.equal(apiKeys.hashSecret(key.secret), key.secretHash);
});

test('a presented secret is verified in constant time and a wrong one is refused', () => {
  const key = apiKeys.generateApiKey();
  assert.equal(apiKeys.verifySecret(key.secret, key.secretHash), true);
  assert.equal(apiKeys.verifySecret(`${key.secret.slice(0, -1)}x`, key.secretHash), false);
  assert.equal(apiKeys.verifySecret(apiKeys.generateSecret(), key.secretHash), false);
  // A malformed stored hash must answer false, never throw: an exception here would be a
  // control-flow oracle and a 500 instead of a 401.
  assert.equal(apiKeys.verifySecret(key.secret, ''), false);
  assert.equal(apiKeys.verifySecret(key.secret, 'not-a-hash'), false);
  assert.equal(apiKeys.verifySecret(key.secret, key.secretHash.slice(0, 40)), false);
});

test('a malformed credential is rejected before any lookup', () => {
  const key = apiKeys.generateApiKey();
  assert.deepEqual(apiKeys.parseApiKey(key.token), { prefix: key.prefix, secret: key.secret });
  for (const bad of ['', 'nonsense', 'pk_short.abc', `${key.prefix}`, `${key.prefix}.`, `.${key.secret}`,
    `sk_abcdefabcdef.${key.secret}`, `${key.prefix}.${key.secret}extra`, 'x'.repeat(500)]) {
    assert.equal(apiKeys.parseApiKey(bad), null, `${bad.slice(0, 20)} must not parse`);
  }
});

test('a masked key shows the prefix and never the secret', () => {
  const key = apiKeys.generateApiKey();
  const masked = apiKeys.maskToken(key.token);
  assert.equal(masked, `${key.prefix}.****`);
  assert.ok(!masked.includes(key.secret));
});

// ---------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------

test('scopes are an allowlist and an unknown one is refused, not dropped', () => {
  assert.deepEqual(normalizeScopes(['orders:read', 'products:read']), ['products:read', 'orders:read']);
  // Canonical order, so two keys with the same powers store the same array.
  assert.deepEqual(normalizeScopes(['products:read', 'orders:read']), normalizeScopes(['orders:read', 'products:read']));
  assert.throws(() => normalizeScopes(['products:*']), (error) => error.code === 'API_KEY_SCOPE_UNKNOWN');
  assert.throws(() => normalizeScopes(['admin']), (error) => error.code === 'API_KEY_SCOPE_UNKNOWN');
  assert.throws(() => normalizeScopes([]), (error) => error.code === 'API_KEY_SCOPES_REQUIRED');
  // A dashboard role is not a scope, and must never be storable as one.
  assert.throws(() => normalizeScopes(['owner']), (error) => error.code === 'API_KEY_SCOPE_UNKNOWN');
  assert.throws(() => normalizeScopes(['super_admin']), (error) => error.code === 'API_KEY_SCOPE_UNKNOWN');
});

test('scope checks are exact: write never implies read', () => {
  assert.equal(hasScope(['products:write'], 'products:write'), true);
  assert.equal(hasScope(['products:write'], 'products:read'), false, 'implication is where authz bugs live');
  assert.equal(hasScope(['products:read'], 'orders:read'), false);
  assert.equal(hasScope([], 'products:read'), false);
  assert.equal(hasScope(null, 'products:read'), false);
  for (const scope of SCOPES) assert.equal(hasScope([scope], scope), true);
});

// ---------------------------------------------------------------------------------------
// IP allowlist
// ---------------------------------------------------------------------------------------

test('an empty allowlist means unrestricted; a configured one denies everything else', () => {
  assert.equal(isAllowed([], '203.0.113.7'), true);
  assert.equal(isAllowed(null, '203.0.113.7'), true);
  assert.equal(isAllowed(['203.0.113.7'], '203.0.113.7'), true);
  assert.equal(isAllowed(['203.0.113.7'], '203.0.113.8'), false);
  // A configured allowlist with an unresolvable client address denies: a resolution failure
  // must not become an authorization bypass.
  assert.equal(isAllowed(['203.0.113.7'], ''), false);
  assert.equal(isAllowed(['203.0.113.7'], 'not-an-ip'), false);
});

test('CIDR blocks match on the prefix, for both address families', () => {
  assert.equal(isAllowed(['203.0.113.0/24'], '203.0.113.99'), true);
  assert.equal(isAllowed(['203.0.113.0/24'], '203.0.114.1'), false);
  assert.equal(isAllowed(['10.0.0.0/8'], '10.255.255.254'), true);
  assert.equal(isAllowed(['192.168.1.0/28'], '192.168.1.15'), true);
  assert.equal(isAllowed(['192.168.1.0/28'], '192.168.1.16'), false);
  assert.equal(isAllowed(['2001:db8::/32'], '2001:db8:1234::1'), true);
  assert.equal(isAllowed(['2001:db8::/32'], '2001:db9::1'), false);
  // A v4 address must not match a v6 block: ::/0 meaning "everything" would silently
  // unrestrict an allowlist an operator believed was narrow.
  assert.equal(isAllowed(['::/0'], '203.0.113.7'), false);
  assert.equal(isAllowed(['0.0.0.0/0'], '2001:db8::1'), false);
});

test('an IPv4-mapped IPv6 client address matches its IPv4 rule', () => {
  // A dual-stack proxy presents ::ffff:203.0.113.7; locking that client out of a rule they
  // wrote as 203.0.113.7 would be a bug they cannot diagnose.
  assert.equal(isAllowed(['203.0.113.7'], '::ffff:203.0.113.7'), true);
  assert.equal(isAllowed(['203.0.113.0/24'], '::ffff:203.0.113.7'), true);
  assert.equal(isAllowed(['203.0.113.7'], '::ffff:203.0.113.8'), false);
});

test('an invalid allowlist entry is refused at write time', () => {
  assert.deepEqual(normalizeAllowlist(['203.0.113.7', '10.0.0.0/8']), ['203.0.113.7', '10.0.0.0/8']);
  assert.deepEqual(normalizeAllowlist(['203.0.113.7', '203.0.113.7']), ['203.0.113.7'], 'duplicates collapse');
  assert.deepEqual(normalizeAllowlist([]), []);
  for (const bad of ['999.1.1.1', '10.0.0.0/33', '10.0.0.0/-1', 'example.com', '10.0.0.0/abc', '::1/129']) {
    assert.throws(() => normalizeAllowlist([bad]), (error) => error.code === 'API_KEY_IP_INVALID', bad);
  }
  assert.throws(() => normalizeAllowlist(Array(51).fill('203.0.113.7')),
    (error) => error.code === 'API_KEY_IP_ALLOWLIST_TOO_LARGE');
});

// ---------------------------------------------------------------------------------------
// Webhook secret encryption
// ---------------------------------------------------------------------------------------

test('a signing secret round-trips, because the sender must reproduce it', () => {
  const secret = secretCrypto.generateSigningSecret();
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  const ciphertext = secretCrypto.encryptSecret(secret, { endpointId: 42 }, TEST_ENV);
  assert.ok(!ciphertext.includes(secret), 'the plaintext must not survive in the ciphertext');
  assert.match(ciphertext, /^v1:/);
  assert.equal(secretCrypto.decryptSecret(ciphertext, { endpointId: 42 }, TEST_ENV), secret);
});

test('a ciphertext is bound to its endpoint and cannot be moved to another', () => {
  const secret = secretCrypto.generateSigningSecret();
  const ciphertext = secretCrypto.encryptSecret(secret, { endpointId: 42 }, TEST_ENV);
  // Copying a row onto another endpoint must fail the tag check, not silently sign that
  // endpoint's deliveries with a secret its owner never saw.
  assert.throws(() => secretCrypto.decryptSecret(ciphertext, { endpointId: 43 }, TEST_ENV),
    (error) => error.code === 'WEBHOOK_SECRET_UNREADABLE');
});

test('a tampered ciphertext and a wrong key both fail closed', () => {
  const secret = secretCrypto.generateSigningSecret();
  const ciphertext = secretCrypto.encryptSecret(secret, { endpointId: 7 }, TEST_ENV);
  const [version, iv, tag, data] = ciphertext.split(':');
  const flipped = `${version}:${iv}:${tag}:${Buffer.from('tampered').toString('base64')}`;
  assert.throws(() => secretCrypto.decryptSecret(flipped, { endpointId: 7 }, TEST_ENV),
    (error) => error.code === 'WEBHOOK_SECRET_UNREADABLE');
  assert.throws(() => secretCrypto.decryptSecret(`${version}:${iv}:${Buffer.from('x'.repeat(16)).toString('base64')}:${data}`,
    { endpointId: 7 }, TEST_ENV), (error) => error.code === 'WEBHOOK_SECRET_UNREADABLE');
  const otherKey = { WEBHOOK_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
  assert.throws(() => secretCrypto.decryptSecret(ciphertext, { endpointId: 7 }, otherKey),
    (error) => error.code === 'WEBHOOK_SECRET_UNREADABLE');
});

test('encryption refuses to run without its own configured key', () => {
  assert.equal(secretCrypto.isConfigured({}), false);
  assert.equal(secretCrypto.isConfigured(TEST_ENV), true);
  assert.throws(() => secretCrypto.encryptSecret('x', { endpointId: 1 }, {}),
    (error) => error.code === 'WEBHOOK_ENCRYPTION_NOT_CONFIGURED');
  // Deliberately its OWN key: reusing the invoice identity key would mean one compromise
  // exposes both, and neither could be rotated independently.
  assert.equal(secretCrypto.KEY_ENV, 'WEBHOOK_SECRET_ENCRYPTION_KEY');
  assert.equal(secretCrypto.isConfigured({ INVOICE_IDENTITY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') }), false);
});

test('two encryptions of the same secret differ, so a repeated value is not visible', () => {
  const secret = secretCrypto.generateSigningSecret();
  const a = secretCrypto.encryptSecret(secret, { endpointId: 1 }, TEST_ENV);
  const b = secretCrypto.encryptSecret(secret, { endpointId: 1 }, TEST_ENV);
  assert.notEqual(a, b, 'a random IV per encryption');
  assert.equal(secretCrypto.decryptSecret(a, { endpointId: 1 }, TEST_ENV),
    secretCrypto.decryptSecret(b, { endpointId: 1 }, TEST_ENV));
});

// ---------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------

test('a signature is deterministic over the exact bytes that are sent', () => {
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'order.created' }), 'utf8');
  const first = signature.signPayload({ secret: 'whsec_test', timestamp: 1700000000, rawBody: body });
  const second = signature.signPayload({ secret: 'whsec_test', timestamp: 1700000000, rawBody: body });
  assert.equal(first, second);
  assert.match(first, /^v1=[0-9a-f]{64}$/);
  // The canonical input is timestamp + "." + body, so a changed timestamp changes the
  // signature — that is what stops a captured request being replayed with a fresh header.
  assert.notEqual(first, signature.signPayload({ secret: 'whsec_test', timestamp: 1700000001, rawBody: body }));
  assert.notEqual(first, signature.signPayload({ secret: 'whsec_other', timestamp: 1700000000, rawBody: body }));
});

test('a single changed byte in the body invalidates the signature', () => {
  const secret = 'whsec_test';
  const timestamp = Math.floor(Date.now() / 1000);
  const body = Buffer.from('{"amount":"10.00"}', 'utf8');
  const sig = signature.signPayload({ secret, timestamp, rawBody: body });
  assert.equal(signature.verifySignature({ secret, timestamp, rawBody: body, signature: sig }).valid, true);
  const tampered = Buffer.from('{"amount":"90.00"}', 'utf8');
  const result = signature.verifySignature({ secret, timestamp, rawBody: tampered, signature: sig });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SIGNATURE_MISMATCH');
});

test('the replay window rejects an old request and a far-future one', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{}', 'utf8');
  const now = 1_700_000_000_000;
  const fresh = Math.floor(now / 1000);
  const sign = (timestamp) => signature.signPayload({ secret, timestamp, rawBody: body });

  assert.equal(signature.verifySignature({
    secret, timestamp: fresh, rawBody: body, signature: sign(fresh), now,
  }).valid, true);

  const old = fresh - 400;
  assert.deepEqual(signature.verifySignature({
    secret, timestamp: old, rawBody: body, signature: sign(old), now,
  }), { valid: false, reason: 'TIMESTAMP_EXPIRED' });

  const future = fresh + 400;
  assert.deepEqual(signature.verifySignature({
    secret, timestamp: future, rawBody: body, signature: sign(future), now,
  }), { valid: false, reason: 'TIMESTAMP_IN_FUTURE' });

  // Inside the window, both directions are accepted: clocks drift, and a receiver that
  // refuses a two-second skew is a receiver that drops real events.
  const skewed = fresh - 60;
  assert.equal(signature.verifySignature({
    secret, timestamp: skewed, rawBody: body, signature: sign(skewed), now,
  }).valid, true);
});

test('verification accepts either secret during a rotation', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = Buffer.from('{"a":1}', 'utf8');
  const signedWithOld = signature.signPayload({ secret: 'whsec_old', timestamp, rawBody: body });
  assert.equal(signature.verifySignature({
    secrets: ['whsec_new', 'whsec_old'], timestamp, rawBody: body, signature: signedWithOld,
  }).valid, true);
  assert.equal(signature.verifySignature({
    secrets: ['whsec_new'], timestamp, rawBody: body, signature: signedWithOld,
  }).reason, 'SIGNATURE_MISMATCH');
});

test('malformed signature input answers false instead of throwing', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = Buffer.from('{}', 'utf8');
  const cases = [
    [{ signature: '' }, 'MALFORMED_SIGNATURE'],
    [{ signature: 'garbage' }, 'MALFORMED_SIGNATURE'],
    [{ signature: 'v1=nothex' }, 'MALFORMED_SIGNATURE'],
    [{ signature: 'v2=' + 'a'.repeat(64) }, 'MALFORMED_SIGNATURE'],
    [{ signature: 'v1=' + 'a'.repeat(63) }, 'MALFORMED_SIGNATURE'],
    [{ timestamp: 'abc', signature: 'v1=' + 'a'.repeat(64) }, 'INVALID_TIMESTAMP'],
    [{ timestamp: -1, signature: 'v1=' + 'a'.repeat(64) }, 'INVALID_TIMESTAMP'],
  ];
  for (const [overrides, reason] of cases) {
    const result = signature.verifySignature({ secret: 'whsec_test', timestamp, rawBody: body, ...overrides });
    assert.equal(result.valid, false);
    assert.equal(result.reason, reason, JSON.stringify(overrides));
  }
  assert.equal(signature.verifySignature({ secrets: [], timestamp, rawBody: body, signature: 'v1=' + 'a'.repeat(64) }).reason, 'NO_SECRET');
});

test('comparison is length-checked before it is constant-time', () => {
  // timingSafeEqual throws on a length mismatch; answering false is what keeps a malformed
  // signature from becoming an exception (and a 500) instead of a rejection.
  assert.equal(signature.constantTimeEquals('abc', 'abcd'), false);
  assert.equal(signature.constantTimeEquals('abc', 'abc'), true);
  assert.equal(signature.constantTimeEquals('', ''), true);
  assert.equal(signature.constantTimeEquals('a', ''), false);
});

// ---------------------------------------------------------------------------------------
// SSRF: URL validation
// ---------------------------------------------------------------------------------------

test('a production webhook URL must be https on an allowed port', () => {
  assert.equal(validateWebhookUrl('https://hooks.example.com/panelya', PROD_ENV).hostname, 'hooks.example.com');
  assert.equal(validateWebhookUrl('https://hooks.example.com:443/x', PROD_ENV).port, 443);
  for (const [url, code] of [
    ['http://hooks.example.com/x', 'WEBHOOK_URL_NOT_HTTPS'],
    ['ftp://hooks.example.com/x', 'WEBHOOK_URL_NOT_HTTPS'],
    ['https://hooks.example.com:8443/x', 'WEBHOOK_URL_PORT_NOT_ALLOWED'],
    ['https://user:pass@hooks.example.com/x', 'WEBHOOK_URL_HAS_CREDENTIALS'],
    ['https://hooks.example.com/x#frag', 'WEBHOOK_URL_HAS_FRAGMENT'],
    ['not a url', 'WEBHOOK_URL_INVALID'],
    ['', 'WEBHOOK_URL_REQUIRED'],
  ]) {
    assert.throws(() => validateWebhookUrl(url, PROD_ENV), (error) => error.code === code, `${url} -> ${code}`);
  }
});

test('a literal private address is refused at save time', () => {
  const cases = [
    'https://127.0.0.1/x', 'https://localhost/x', 'https://10.1.2.3/x', 'https://172.16.0.1/x',
    'https://192.168.1.1/x', 'https://169.254.169.254/latest/meta-data', 'https://0.0.0.0/x',
    'https://[::1]/x', 'https://[fc00::1]/x', 'https://[fe80::1]/x', 'https://[::ffff:127.0.0.1]/x',
    'https://224.0.0.1/x', 'https://255.255.255.255/x', 'https://100.64.0.1/x',
  ];
  for (const url of cases) {
    assert.throws(() => validateWebhookUrl(url, PROD_ENV),
      (error) => ['WEBHOOK_URL_PRIVATE_ADDRESS', 'WEBHOOK_URL_INVALID'].includes(error.code), url);
  }
});

test('address classification covers every non-public range, mapped forms included', () => {
  for (const address of ['203.0.113.9', '8.8.8.8', '2606:4700::1111']) {
    // 203.0.113.0/24 is TEST-NET-3 and is blocked; the point of listing it is that a
    // documentation range is not a public destination either.
    if (address === '203.0.113.9') assert.equal(isPublicAddress(address, PROD_ENV), false);
    else assert.equal(isPublicAddress(address, PROD_ENV), true, address);
  }
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
    '0.0.0.0', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', 'not-an-ip', '',
    // The hex spelling of an IPv4-mapped address. `new URL()` rewrites
    // [::ffff:127.0.0.1] into this form, so a text-pattern unwrap misses it and loopback
    // is classified as an ordinary public v6 address.
    '::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '::FFFF:7F00:0001',
  ]) {
    assert.equal(isPublicAddress(address, PROD_ENV), false, address);
  }
});

test('loopback is reachable only when a test process explicitly opts in', () => {
  const optedIn = { NODE_ENV: 'test', WEBHOOK_ALLOW_LOCAL_DELIVERY: 'true' };
  assert.equal(isPublicAddress('127.0.0.1', optedIn), true);
  assert.equal(validateWebhookUrl('http://127.0.0.1:9099/hook', optedIn).hostname, '127.0.0.1');
  // Two independent conditions. A flag left on in production unlocks nothing, and a test
  // process without the flag unlocks nothing either.
  assert.equal(isPublicAddress('127.0.0.1', { NODE_ENV: 'production', WEBHOOK_ALLOW_LOCAL_DELIVERY: 'true' }), false);
  assert.equal(isPublicAddress('127.0.0.1', { NODE_ENV: 'test' }), false);
  // Even opted in, the rest of the private space stays closed.
  assert.equal(isPublicAddress('169.254.169.254', optedIn), false);
  assert.equal(isPublicAddress('10.0.0.1', optedIn), false);
});

// ---------------------------------------------------------------------------------------
// SSRF: DNS resolution and pinning
// ---------------------------------------------------------------------------------------

const httpDelivery = require('../modules/integrations/httpDelivery');
const dnsResolver = require('../services/dnsResolver');

/** Installs a deterministic resolver; nothing in these tests touches real DNS. */
function withResolver(addressesByHost) {
  const resolver = {
    name: 'a29-test',
    async resolveTxt() { return []; },
    async resolveAddresses(hostname) {
      const entry = addressesByHost[String(hostname).toLowerCase()];
      return typeof entry === 'function' ? entry() : (entry || []);
    },
  };
  dnsResolver.setResolver(resolver);
  return () => dnsResolver.setResolver(null);
}

test('a hostname resolving only to public addresses is pinned to one of them', async () => {
  const restore = withResolver({ 'hooks.example.com': [{ address: '93.184.216.34', family: 4 }] });
  try {
    const pinned = await httpDelivery.resolvePinnedAddress('hooks.example.com', PROD_ENV);
    assert.equal(pinned.address, '93.184.216.34');
    assert.equal(pinned.family, 4);
  } finally {
    restore();
  }
});

test('a hostname resolving to a private address is refused', async () => {
  const restore = withResolver({
    'evil.example.com': [{ address: '127.0.0.1', family: 4 }],
    'meta.example.com': [{ address: '169.254.169.254', family: 4 }],
    'v6.example.com': [{ address: '::1', family: 6 }],
    'empty.example.com': [],
  });
  try {
    for (const [host, code] of [
      ['evil.example.com', 'SSRF_PRIVATE_ADDRESS'],
      ['meta.example.com', 'SSRF_PRIVATE_ADDRESS'],
      ['v6.example.com', 'SSRF_PRIVATE_ADDRESS'],
      ['empty.example.com', 'DNS_NO_ADDRESS'],
    ]) {
      await assert.rejects(
        httpDelivery.resolvePinnedAddress(host, PROD_ENV),
        (error) => error.code === code, host
      );
    }
  } finally {
    restore();
  }
});

test('a MIXED public/private answer is refused outright, not filtered down to the good one', async () => {
  // "Just use the public one" is the tempting behaviour and the wrong one: a resolver that
  // can be made to return 127.0.0.1 at all is not trustworthy for this request.
  const restore = withResolver({
    'mixed.example.com': [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ],
  });
  try {
    await assert.rejects(
      httpDelivery.resolvePinnedAddress('mixed.example.com', PROD_ENV),
      (error) => error.code === 'SSRF_PRIVATE_ADDRESS'
    );
  } finally {
    restore();
  }
});

test('DNS rebinding cannot move the connection: the validated address is what gets pinned', async () => {
  // The attack: answer public while being validated, then private when the socket is
  // opened. Pinning means the second answer is never consulted — there is no second lookup.
  let call = 0;
  const restore = withResolver({
    'rebind.example.com': () => {
      call += 1;
      return call === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    },
  });
  try {
    const pinned = await httpDelivery.resolvePinnedAddress('rebind.example.com', PROD_ENV);
    assert.equal(pinned.address, '93.184.216.34');
    assert.equal(call, 1, 'exactly one resolution, whose result is the one used');
    // Proof the resolver really does rebind: asking again now answers privately. The
    // client never asks again — the socket target is the pinned value above — so this
    // second answer can never become a connection.
    await assert.rejects(
      httpDelivery.resolvePinnedAddress('rebind.example.com', PROD_ENV),
      (error) => error.code === 'SSRF_PRIVATE_ADDRESS'
    );
    assert.equal(call, 2);
  } finally {
    restore();
  }
});

test('a literal address skips DNS entirely and is validated directly', async () => {
  const restore = withResolver({});
  try {
    await assert.rejects(
      httpDelivery.resolvePinnedAddress('127.0.0.1', PROD_ENV),
      (error) => error.code === 'SSRF_PRIVATE_ADDRESS'
    );
    const pinned = await httpDelivery.resolvePinnedAddress('93.184.216.34', PROD_ENV);
    assert.equal(pinned.address, '93.184.216.34');
  } finally {
    restore();
  }
});

test('the worker sends the exact bytes it signed', () => {
  // This shipped broken once: the body was serialized and signed, then sendWebhook was
  // called without it, so every receiver verified a signature over bytes it never got.
  // Asserting on the call site catches the same omission without needing a live socket.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'integrations', 'worker.js'), 'utf8'
  );
  const call = /await sendWebhook\(\{[\s\S]*?\n {4}\}\);/.exec(source)?.[0] ?? '';
  assert.ok(call.length > 0, 'the sendWebhook call site must be findable');
  assert.match(call, /^\s*body,$/m, 'the signed buffer is what gets sent');
  // Exactly one serialization, so there is nothing for a second one to disagree with.
  assert.equal((source.match(/JSON\.stringify\(eventBody/g) || []).length, 1);
  assert.match(source, /const body = Buffer\.from\(JSON\.stringify\(eventBody\(context\)\), 'utf8'\);/);
  assert.match(source, /signPayload\(\{ secret, timestamp, rawBody: body \}\)/);
});

test('the delivery client never offers a way to disable TLS verification', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'integrations', 'httpDelivery.js'), 'utf8'
  );
  assert.ok(!/rejectUnauthorized/.test(source), 'there is deliberately no such option');
  assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(source));
  // A redirect is data on the response, never a second request.
  assert.ok(!/followRedirect|maxRedirects/.test(source));
  assert.match(source, /servername:/, 'SNI keeps the original hostname so the certificate still verifies');
});

// ---------------------------------------------------------------------------------------
// Event registry
// ---------------------------------------------------------------------------------------

test('every event the master list requires is registered with a version and an aggregate', () => {
  const required = [
    'product.created', 'product.updated', 'product.deleted', 'inventory.changed',
    'order.created', 'order.status_changed', 'payment.paid', 'payment.failed',
    'payment.refunded', 'fulfillment.shipped', 'fulfillment.delivered',
    'return.requested', 'return.updated', 'customer.created', 'customer.updated',
    'subscription.updated',
  ];
  for (const eventType of required) {
    const definition = events.getEventDefinition(eventType);
    assert.ok(definition.aggregateType, `${eventType} needs an aggregate type`);
    assert.ok(definition.schemaVersion >= 1, `${eventType} needs a schema version`);
    assert.equal(typeof definition.build, 'function');
  }
});

test('an arbitrary event name cannot be emitted or subscribed to', () => {
  assert.throws(() => events.getEventDefinition('order.anything'),
    (error) => error.code === 'EVENT_TYPE_UNKNOWN');
  assert.throws(() => events.normalizeEventTypes(['not.an.event']),
    (error) => error.code === 'WEBHOOK_EVENT_UNKNOWN');
  assert.throws(() => events.normalizeEventTypes([]),
    (error) => error.code === 'WEBHOOK_EVENTS_REQUIRED');
  // webhook.test is delivered on demand and must not be subscribable, or it would look
  // like something that can arrive unprompted.
  assert.throws(() => events.normalizeEventTypes(['webhook.test']),
    (error) => error.code === 'WEBHOOK_EVENT_UNKNOWN');
  assert.deepEqual(events.normalizeEventTypes(['order.created', 'order.created']), ['order.created']);
});

test('payloads are minimised: no address, identity, token or card data escapes', () => {
  const hostile = {
    id: 55, orderCode: 'ORD-1', status: 'processing', total: '129.90', customerId: 9,
    // Everything below is what a careless caller might pass in; none of it may survive.
    email: 'person@example.com', phone: '05550000000', tckn: '12345678901',
    shippingAddress: { line1: 'Gizli Sokak 1', city: 'Istanbul' },
    cardNumber: '4111111111111111', accessToken: 'secret-token', password: 'hunter2',
  };
  const order = events.getEventDefinition('order.created').build(hostile);
  const serialized = JSON.stringify(order);
  for (const leak of ['person@example.com', '05550000000', '12345678901', 'Gizli Sokak',
    '4111111111111111', 'secret-token', 'hunter2']) {
    assert.ok(!serialized.includes(leak), `${leak} must not reach a webhook payload`);
  }
  assert.equal(order.id, '55');
  assert.equal(order.total, '129.90');

  const customer = events.getEventDefinition('customer.created').build(hostile);
  assert.deepEqual(Object.keys(customer), ['id'], 'a customer event is an identity, not a profile');
});

test('the envelope carries the ordering metadata a consumer needs', () => {
  const body = events.buildEventBody({
    eventId: 'evt_1', eventType: 'order.status_changed', occurredAt: new Date('2026-01-01T00:00:00Z'),
    schemaVersion: 1, aggregateType: 'order', aggregateId: '55', aggregateVersion: 7,
    payload: { id: '55' },
  });
  assert.equal(body.schemaVersion, 1);
  // The ordering contract is IN the message, not in prose: a receiver holding version 8
  // can see that this one is stale without asking us.
  assert.deepEqual(body.aggregate, { type: 'order', id: '55', version: 7 });
  assert.equal(body.occurredAt, '2026-01-01T00:00:00.000Z');
  assert.equal(body.type, 'order.status_changed');
});

// ---------------------------------------------------------------------------------------
// Worker policy
// ---------------------------------------------------------------------------------------

test('only a 2xx is a success; a redirect is a permanent failure', () => {
  for (const status of [200, 201, 202, 204, 299]) {
    assert.equal(worker.classifyResponse(status).outcome, 'delivered', String(status));
  }
  for (const status of [301, 302, 307, 308]) {
    const verdict = worker.classifyResponse(status);
    assert.equal(verdict.outcome, 'failed_permanent', String(status));
    assert.equal(verdict.code, 'REDIRECT_NOT_FOLLOWED');
  }
  // A refusal the receiver understood: retrying it eight times helps nobody.
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(worker.classifyResponse(status).outcome, 'failed_permanent', String(status));
  }
  // Overload and timeouts are exactly what retries exist for.
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(worker.classifyResponse(status).outcome, 'failed_retryable', String(status));
  }
});

test('backoff grows exponentially, is capped, and is jittered deterministically', () => {
  // A fixed RNG rather than a sleep: measuring elapsed wall time is how a backoff test
  // becomes flaky.
  const max = () => 1;
  const min = () => 0;
  assert.equal(worker.backoffSeconds(1, max), worker.BACKOFF_BASE_SECONDS);
  assert.equal(worker.backoffSeconds(2, max), worker.BACKOFF_BASE_SECONDS * 2);
  assert.equal(worker.backoffSeconds(3, max), worker.BACKOFF_BASE_SECONDS * 4);
  assert.equal(worker.backoffSeconds(40, max), worker.MAX_BACKOFF_SECONDS);
  // Full jitter halves the ceiling at the low end, so a fleet of retries spreads out
  // instead of arriving together.
  assert.equal(worker.backoffSeconds(3, min), (worker.BACKOFF_BASE_SECONDS * 4) / 2);
  assert.ok(worker.backoffSeconds(1, min) >= 1, 'never schedules an immediate retry');
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const value = worker.backoffSeconds(attempt, () => 0.5);
    assert.ok(value >= 1 && value <= worker.MAX_BACKOFF_SECONDS, `attempt ${attempt}`);
  }
});

test('the disable threshold and stale-lock window are configuration, not magic numbers', () => {
  assert.ok(Number.isInteger(worker.FAILURE_DISABLE_THRESHOLD) && worker.FAILURE_DISABLE_THRESHOLD > 0);
  assert.ok(Number.isInteger(worker.STALE_LOCK_SECONDS) && worker.STALE_LOCK_SECONDS > 0);
});

// ---------------------------------------------------------------------------------------
// Idempotency fingerprinting
// ---------------------------------------------------------------------------------------

test('the request fingerprint ignores key order but not values', () => {
  const a = service.requestFingerprint({ product_id: 1, stock: 5 });
  const b = service.requestFingerprint({ stock: 5, product_id: 1 });
  assert.equal(a, b, 'a client serializing in a different order is not a different request');
  assert.notEqual(a, service.requestFingerprint({ product_id: 1, stock: 6 }));
  assert.notEqual(a, service.requestFingerprint({ product_id: 2, stock: 5 }));
  // Nested objects and arrays are canonicalised too, or the comparison would be shallow.
  assert.equal(
    service.requestFingerprint({ a: { x: 1, y: 2 }, list: [1, 2] }),
    service.requestFingerprint({ list: [1, 2], a: { y: 2, x: 1 } })
  );
  assert.notEqual(
    service.requestFingerprint({ list: [1, 2] }),
    service.requestFingerprint({ list: [2, 1] }),
    'array order is meaningful'
  );
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('the public key shape has no field a secret could occupy', () => {
  const row = {
    id: 1, name: 'k', prefix: 'pk_abcdef123456', secret_hash: 'a'.repeat(64),
    scopes: ['products:read'], status: 'active', ip_allowlist: [], created_at: new Date(),
  };
  const shaped = service.publicKey(row);
  const serialized = JSON.stringify(shaped);
  assert.ok(!serialized.includes('a'.repeat(64)), 'not even the hash is published');
  assert.ok(!('secret' in shaped) && !('token' in shaped) && !('secret_hash' in shaped));
  assert.equal(shaped.prefix, 'pk_abcdef123456');
});

test('the public endpoint shape never carries encrypted secret material', () => {
  const shaped = service.publicEndpoint({
    id: 3, name: 'e', url: 'https://hooks.example.com/x', status: 'active',
    consecutive_failures: 0, secret_version: 2, created_at: new Date(),
    ciphertext: 'v1:aaa:bbb:ccc',
  }, ['order.created']);
  assert.equal(shaped.secret_version, 2, 'the version is safe to show');
  assert.ok(!('ciphertext' in shaped) && !('secret' in shaped));
  assert.ok(!JSON.stringify(shaped).includes('v1:aaa'));
});
