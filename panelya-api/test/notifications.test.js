'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../modules/notifications/identity');
const providers = require('../modules/notifications/providers');
const consent = require('../modules/notifications/consent');
const service = require('../modules/notifications/service');
const worker = require('../modules/notifications/worker');

// --- identity: normalize / hash / mask ------------------------------------

test('normalizeEmail lowercases and trims', () => {
  assert.equal(identity.normalizeEmail('  Ali@Example.COM '), 'ali@example.com');
  assert.equal(identity.normalizeEmail(null), '');
  // Same address in different case resolves to one stable hash.
  assert.equal(
    identity.targetHash('o', 'email', 'Ali@Example.COM'),
    identity.targetHash('o', 'email', 'ali@example.com')
  );
});

test('normalizePhone keeps a single leading + and digits only', () => {
  assert.equal(identity.normalizePhone(' +90 (555) 123-45-67 '), '+905551234567');
  assert.equal(identity.normalizePhone('0555+123'), '0555123');
  assert.equal(identity.normalizePhone(null), '');
});

test('isValidContact validates email shape and phone length', () => {
  assert.equal(identity.isValidContact('email', 'a@b.co'), true);
  assert.equal(identity.isValidContact('email', 'nope'), false);
  assert.equal(identity.isValidContact('sms', '+905551234567'), true);
  assert.equal(identity.isValidContact('sms', '12345'), false);
});

test('targetHash is deterministic, tenant-scoped and channel-scoped', () => {
  const a = identity.targetHash('org-1', 'email', 'User@Example.com');
  const b = identity.targetHash('org-1', 'email', 'user@example.com');
  const otherTenant = identity.targetHash('org-2', 'email', 'user@example.com');
  const otherChannel = identity.targetHash('org-1', 'sms', 'user@example.com');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b, 'normalized address hashes identically');
  assert.notEqual(a, otherTenant, 'different tenant => different hash');
  assert.notEqual(a, otherChannel, 'different channel => different hash');
  assert.equal(identity.targetHash('org-1', 'email', ''), null);
});

test('maskRecipient never returns the raw address', () => {
  const email = 'alice@example.com';
  const masked = identity.maskRecipient('email', email);
  assert.notEqual(masked, email);
  assert.ok(masked.includes('@example.com'));
  assert.ok(!masked.includes('alice'));
  const phone = identity.maskRecipient('sms', '+905551234567');
  assert.ok(!phone.includes('5551234'));
  assert.match(phone, /\*\*\*/);
});

// --- providers: deterministic test adapter + selection --------------------

test('test provider maps recipient markers to normalized outcomes', async () => {
  const p = providers.testProvider('email');
  assert.equal((await p.send({ recipient: 'x-invalid@e.com' })).status, providers.RESULT.INVALID);
  assert.equal((await p.send({ recipient: 'permfail@e.com' })).status, providers.RESULT.PERMANENT);
  assert.equal((await p.send({ recipient: 'tempfail@e.com' })).status, providers.RESULT.TEMPORARY);
  const limited = await p.send({ recipient: 'ratelimit@e.com' });
  assert.equal(limited.status, providers.RESULT.RATE_LIMITED);
  assert.equal(limited.retryAfterSeconds, 30);
  const ok = await p.send({ recipient: 'real@e.com' });
  assert.equal(ok.status, providers.RESULT.SENT);
  assert.ok(ok.providerMessageId);
});

test('RETRYABLE contains only transient outcomes', () => {
  assert.ok(providers.RETRYABLE.has(providers.RESULT.TEMPORARY));
  assert.ok(providers.RETRYABLE.has(providers.RESULT.RATE_LIMITED));
  assert.ok(!providers.RETRYABLE.has(providers.RESULT.PERMANENT));
  assert.ok(!providers.RETRYABLE.has(providers.RESULT.INVALID));
  assert.ok(!providers.RETRYABLE.has(providers.RESULT.SENT));
});

test('getProvider never silently mocks in production, but falls back in dev', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedEmail = process.env.NOTIFICATION_EMAIL_PROVIDER;
  const savedSms = process.env.NOTIFICATION_SMS_PROVIDER;
  try {
    delete process.env.NOTIFICATION_EMAIL_PROVIDER;
    delete process.env.NOTIFICATION_SMS_PROVIDER;

    process.env.NODE_ENV = 'production';
    assert.throws(() => providers.getProvider('email'), /PROVIDER_NOT_CONFIGURED|provider tanimli degil/i);
    assert.throws(() => providers.getProvider('sms'), (err) => err.code === 'PROVIDER_NOT_CONFIGURED');

    process.env.NODE_ENV = 'development';
    assert.equal(providers.getProvider('email').name, 'test');

    process.env.NODE_ENV = 'production';
    process.env.NOTIFICATION_EMAIL_PROVIDER = 'test';
    assert.equal(providers.getProvider('email').name, 'test');

    process.env.NOTIFICATION_SMS_PROVIDER = 'nonsense';
    assert.throws(() => providers.getProvider('sms'), (err) => err.code === 'PROVIDER_UNSUPPORTED');
  } finally {
    process.env.NODE_ENV = savedEnv;
    if (savedEmail === undefined) delete process.env.NOTIFICATION_EMAIL_PROVIDER; else process.env.NOTIFICATION_EMAIL_PROVIDER = savedEmail;
    if (savedSms === undefined) delete process.env.NOTIFICATION_SMS_PROVIDER; else process.env.NOTIFICATION_SMS_PROVIDER = savedSms;
  }
});

// --- worker: retry backoff + template escaping ----------------------------

test('backoffSeconds is exponential, honours retry-after and caps at one hour', () => {
  assert.equal(worker.backoffSeconds(1), 60);
  assert.equal(worker.backoffSeconds(2), 120);
  assert.equal(worker.backoffSeconds(3), 240);
  assert.equal(worker.backoffSeconds(99), 3600, 'capped');
  assert.equal(worker.backoffSeconds(1, 30), 30, 'retry-after wins when smaller');
  assert.equal(worker.backoffSeconds(1, 999999), 3600, 'retry-after capped too');
});

test('escapeHtml neutralizes markup so templates cannot inject', () => {
  assert.equal(worker.escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  assert.equal(worker.escapeHtml(null), '');
});

// --- consent: transactional/marketing split + suppression gate ------------

test('requiresConsent separates transactional from marketing purposes', () => {
  assert.equal(consent.requiresConsent('transactional'), false);
  assert.equal(consent.requiresConsent('marketing'), true);
  assert.equal(consent.requiresConsent('stock_alert'), true);
  assert.ok(!consent.MARKETING_PURPOSES.includes('transactional'));
});

// Minimal fake client for canSend: answers the two SELECTs it issues.
function consentGateClient({ suppressed = false, granted = false } = {}) {
  return {
    async query(text) {
      if (/from communication_suppressions/i.test(text)) return { rows: suppressed ? [{ '?column?': 1 }] : [] };
      if (/from communication_consents/i.test(text)) return { rows: granted ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    },
  };
}

test('canSend: transactional always passes without querying consent', async () => {
  let queried = false;
  const client = { async query() { queried = true; return { rows: [] }; } };
  const ok = await consent.canSend(client, { organizationId: 'o', channel: 'email', targetHash: 'h', purpose: 'transactional' });
  assert.equal(ok, true);
  assert.equal(queried, false);
});

test('canSend: marketing needs granted consent AND no active suppression', async () => {
  assert.equal(await consent.canSend(consentGateClient({ granted: true, suppressed: false }), { organizationId: 'o', channel: 'email', targetHash: 'h', purpose: 'stock_alert' }), true);
  assert.equal(await consent.canSend(consentGateClient({ granted: false }), { organizationId: 'o', channel: 'email', targetHash: 'h', purpose: 'stock_alert' }), false);
  assert.equal(await consent.canSend(consentGateClient({ granted: true, suppressed: true }), { organizationId: 'o', channel: 'email', targetHash: 'h', purpose: 'stock_alert' }), false);
});

test('consent channel/purpose enums and opt-out event map stay consistent', () => {
  assert.deepEqual(consent.CHANNELS, ['email', 'sms', 'whatsapp', 'push']);
  assert.ok(consent.PURPOSES.includes('transactional'));
  // Each price/stock/favorite purpose maps to the outbox event it must cancel on opt-out.
  assert.deepEqual(consent.PURPOSE_TO_EVENT, {
    stock_alert: 'back_in_stock', price_drop: 'price_drop', favorite_update: 'favorite_update',
  });
  // resolveTargetHash yields a stable 64-hex hash for a valid contact.
  assert.match(consent.resolveTargetHash('o', 'email', { email: 'a@b.co' }), /^[0-9a-f]{64}$/);
});

// --- service: price threshold + enqueue idempotency key -------------------

test('effectivePrice prefers sale price when present', () => {
  assert.equal(service.effectivePrice({ price: 100, sale_price: 80 }), 80);
  assert.equal(service.effectivePrice({ price: 100, sale_price: null }), 100);
  assert.ok(service.PRICE_SENSITIVE_TYPES.includes('price_drop'));
  assert.ok(service.PRICE_SENSITIVE_TYPES.includes('favorite_update'));
});

test('enqueue writes an idempotency-keyed outbox row and never a raw token', async () => {
  const captured = [];
  const client = {
    async query(text, params) {
      captured.push({ text, params });
      return { rows: [{ id: 1 }] };
    },
  };
  const row = await service.enqueue(client, {
    organizationId: 'org-1', eventType: 'price_drop', channel: 'email',
    recipient: 'buyer@example.com', payload: { product_id: 5 }, idempotencyKey: 'price_drop:9:80.00',
  });
  assert.ok(row);
  const insert = captured.find((q) => /insert into notification_outbox/i.test(q.text));
  assert.ok(insert, 'issued an outbox insert');
  assert.match(insert.text, /on conflict \(organization_id, idempotency_key\) do nothing/i);
  // recipient_hash is derived; the raw recipient is a bind param, never interpolated.
  assert.ok(insert.params.includes('price_drop:9:80.00'));
  const hashParam = insert.params.find((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p));
  assert.ok(hashParam, 'a recipient hash is persisted');
});

test('enqueue returns null for an unroutable (empty) recipient', async () => {
  const client = { async query() { return { rows: [] }; } };
  const row = await service.enqueue(client, {
    organizationId: 'org-1', eventType: 'price_drop', channel: 'email',
    recipient: '', idempotencyKey: 'k',
  });
  assert.equal(row, null);
});

test('subscription purpose/event maps stay aligned with allowed enums', () => {
  assert.deepEqual(service.SUBSCRIPTION_PURPOSE, { back_in_stock: 'stock_alert', price_drop: 'price_drop', favorite_update: 'favorite_update' });
  assert.deepEqual(service.SUBSCRIPTION_EVENT, { back_in_stock: 'back_in_stock', price_drop: 'price_drop', favorite_update: 'favorite_update' });
});
