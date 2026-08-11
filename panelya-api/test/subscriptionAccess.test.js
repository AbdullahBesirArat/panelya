const test = require('node:test');
const assert = require('node:assert/strict');

const access = require('../services/subscriptionAccess');
const providers = require('../services/subscriptionProviders');

test('every lifecycle state has an explicit capability set', () => {
  const states = ['trialing', 'active', 'past_due', 'grace_period', 'suspended', 'cancelled', 'expired'];
  for (const status of states) {
    assert.ok(Array.isArray(access.POLICY[status]), `${status} must have a policy`);
    assert.ok(access.POLICY[status].includes('read'), `${status} always keeps read access`);
  }
});

test('paying and at-risk states keep full access; withdrawn states go read-only', () => {
  for (const status of ['trialing', 'active', 'past_due', 'grace_period']) {
    assert.equal(access.can({ status }, 'write'), true, `${status} may write`);
  }
  for (const status of ['suspended', 'cancelled', 'expired']) {
    assert.equal(access.can({ status }, 'write'), false, `${status} may not write`);
    assert.equal(access.can({ status }, 'read'), true, `${status} keeps read access`);
    // Billing stays reachable precisely so the tenant can recover on their own.
    assert.equal(access.can({ status }, 'billing'), true, `${status} keeps billing access`);
  }
});

test('a denied write explains itself with a machine-readable payment-required error', () => {
  assert.throws(
    () => access.assertCan({ status: 'suspended' }, 'write'),
    (error) => error.status === 402
      && error.code === 'SUBSCRIPTION_ACCESS_DENIED'
      && error.meta.subscriptionStatus === 'suspended'
      && error.meta.capability === 'write'
      && Array.isArray(error.meta.allowed)
  );
});

test('a tenant with no subscription row is not retroactively locked out', () => {
  const resolved = access.resolveAccess(null);
  assert.equal(resolved.unrestricted, true);
  assert.equal(access.can(null, 'write'), true);
  assert.doesNotThrow(() => access.assertCan(undefined, 'write'));
});

test('an unknown capability is a programming error, not a silent allow', () => {
  assert.throws(() => access.can({ status: 'active' }, 'delete_everything'), /Bilinmeyen yetki/);
});

test('the manual provider is fully operational and never reports a settlement', async () => {
  const manual = providers.getProvider('manual');
  const started = await manual.startSubscription({
    organizationId: 'org-1', planName: 'growth', planVersionId: 3, periodEnd: null, trialEnd: null,
  });
  assert.equal(started.status, 'active');
  assert.equal(started.settled, false, 'starting a manual subscription never marks money received');

  const changed = await manual.changePlan({ targetPlanName: 'business', targetPlanVersionId: 4 });
  assert.equal(changed.status, 'applied');
  assert.equal(changed.proration.supported, false);
  assert.equal(changed.proration.amount, null, 'no proration maths is invented for a manual provider');
  assert.equal(changed.settled, false);

  const cancelled = await manual.cancel({ atPeriodEnd: true });
  assert.equal(cancelled.status, 'cancel_at_period_end');
});

test('the manual provider refuses webhooks outright', async () => {
  const manual = providers.getProvider('manual');
  await assert.rejects(() => manual.verifyWebhook({}), (e) => e.code === 'WEBHOOK_NOT_SUPPORTED');
  await assert.rejects(() => manual.handleWebhook({}), (e) => e.code === 'WEBHOOK_NOT_SUPPORTED');
});

test('stripe and iyzico report not_configured instead of pretending', async () => {
  for (const name of ['stripe', 'iyzico']) {
    const adapter = providers.getProvider(name);
    assert.equal(adapter.configured, false);
    for (const operation of ['createCustomer', 'startSubscription', 'changePlan', 'cancel', 'resume', 'getStatus']) {
      await assert.rejects(
        () => adapter[operation]({}),
        (error) => error.code === 'SUBSCRIPTION_PROVIDER_NOT_CONFIGURED'
          && error.status === 503
          && error.meta.status === 'not_configured',
        `${name}.${operation} must refuse`
      );
    }
    // An unverifiable webhook can never be treated as authentic.
    await assert.rejects(
      () => adapter.verifyWebhook({ signature: 'anything' }),
      (error) => error.code === 'SUBSCRIPTION_PROVIDER_NOT_CONFIGURED'
    );
  }
});

test('capabilities are reported honestly per provider', () => {
  assert.deepEqual(providers.providerCapabilities('manual'), {
    provider: 'manual', configured: true, supportsProration: false,
  });
  assert.deepEqual(providers.providerCapabilities('stripe'), {
    provider: 'stripe', configured: false, supportsProration: false,
  });
});

test('the test provider is unavailable outside a test environment', () => {
  const previous = process.env.NODE_ENV;
  const previousE2E = process.env.E2E;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.E2E;
    assert.throws(() => providers.getProvider('test'), (error) => error.code === 'TEST_PROVIDER_NOT_ALLOWED');
  } finally {
    process.env.NODE_ENV = previous;
    if (previousE2E !== undefined) process.env.E2E = previousE2E;
  }
});

test('provider events are normalized and stripped of secrets before storage', () => {
  const normalized = providers.normalizeProviderEvent('test', {
    id: 'evt_1', type: 'invoice.paid', sequence: '42',
    data: { amount: 100, signature: 'sig_should_not_persist', nested: { api_key: 'k', ok: 1 } },
  });
  assert.equal(normalized.providerEventId, 'evt_1');
  assert.equal(normalized.eventType, 'invoice.paid');
  assert.equal(normalized.eventSequence, 42);
  assert.equal(normalized.payload.signature, '[REDACTED]');
  assert.equal(normalized.payload.nested.api_key, '[REDACTED]');
  assert.equal(normalized.payload.nested.ok, 1);
  assert.equal(JSON.stringify(normalized).includes('sig_should_not_persist'), false);
});

test('an event without an id or type is rejected rather than stored unidentifiable', () => {
  assert.throws(() => providers.normalizeProviderEvent('test', { type: 'x' }),
    (e) => e.code === 'BILLING_EVENT_ID_REQUIRED');
  assert.throws(() => providers.normalizeProviderEvent('test', { id: 'e1' }),
    (e) => e.code === 'BILLING_EVENT_TYPE_REQUIRED');
});
