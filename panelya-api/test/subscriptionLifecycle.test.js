const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../services/subscriptionLifecycle');

test('the canonical state set is exactly the A26 lifecycle', () => {
  assert.deepEqual([...lifecycle.STATES].sort(), [
    'active', 'cancelled', 'expired', 'grace_period', 'past_due', 'suspended', 'trialing',
  ]);
});

test('the transition matrix allows every lifecycle edge A26 requires', () => {
  const required = [
    ['trialing', 'active'],
    ['trialing', 'expired'],
    ['active', 'past_due'],
    ['active', 'cancelled'],
    ['past_due', 'active'],
    ['past_due', 'grace_period'],
    ['grace_period', 'active'],
    ['grace_period', 'suspended'],
    ['suspended', 'active'],
    ['cancelled', 'active'],
    ['expired', 'active'],
  ];
  for (const [from, to] of required) {
    assert.equal(lifecycle.canTransition(from, to), true, `${from} -> ${to} must be allowed`);
  }
});

test('transitions that would skip or reverse the lifecycle are refused', () => {
  const forbidden = [
    ['trialing', 'past_due'],
    ['trialing', 'grace_period'],
    ['trialing', 'suspended'],
    ['active', 'grace_period'],
    ['active', 'expired'],
    ['active', 'trialing'],
    ['suspended', 'grace_period'],
    ['suspended', 'past_due'],
    ['cancelled', 'past_due'],
    ['cancelled', 'suspended'],
    ['expired', 'trialing'],
    ['expired', 'suspended'],
  ];
  for (const [from, to] of forbidden) {
    assert.equal(lifecycle.canTransition(from, to), false, `${from} -> ${to} must be refused`);
  }
});

test('an invalid transition throws a machine-readable error instead of no-oping', () => {
  assert.throws(
    () => lifecycle.assertTransition('active', 'expired'),
    (error) => error.code === 'INVALID_SUBSCRIPTION_TRANSITION'
      && error.status === 409
      && error.meta.from === 'active'
      && error.meta.to === 'expired'
      && Array.isArray(error.meta.allowed)
  );
});

test('a same-state transition is reported, never silently accepted', () => {
  assert.throws(
    () => lifecycle.assertTransition('active', 'active'),
    (error) => error.code === 'SUBSCRIPTION_TRANSITION_NOOP' && error.status === 409
  );
});

test('unknown states are rejected on both sides of the edge', () => {
  assert.throws(
    () => lifecycle.assertTransition('active', 'unpaid'),
    (error) => error.code === 'UNKNOWN_SUBSCRIPTION_STATE'
  );
  assert.throws(
    () => lifecycle.assertTransition('unpaid', 'active'),
    (error) => error.code === 'UNKNOWN_SUBSCRIPTION_STATE' && error.status === 500
  );
});

test('restoring withdrawn access requires an explicit reason', () => {
  for (const from of ['suspended', 'cancelled', 'expired']) {
    assert.throws(
      () => lifecycle.assertTransition(from, 'active'),
      (error) => error.code === 'SUBSCRIPTION_TRANSITION_REASON_REQUIRED',
      `${from} -> active must demand a reason`
    );
    assert.doesNotThrow(() => lifecycle.assertTransition(from, 'active', { reason: 'payment recovered' }));
  }
  // Ordinary recovery edges do not need one: the provider event is the reason.
  assert.doesNotThrow(() => lifecycle.assertTransition('past_due', 'active'));
  assert.doesNotThrow(() => lifecycle.assertTransition('grace_period', 'active'));
});

test('entering active clears every access-withdrawal marker but not trial history', () => {
  const effects = lifecycle.transitionEffects('active');
  assert.equal(effects.grace_until, null);
  assert.equal(effects.suspended_at, null);
  assert.equal(effects.suspension_reason, null);
  assert.equal(effects.cancelled_at, null);
  assert.equal('trial_end' in effects, false, 'recovery never rewrites trial history');
  assert.equal('current_period_end' in effects, false, 'recovery never moves the billing period');
});

test('grace_period carries its deadline and suspension carries its reason', () => {
  const graceUntil = '2026-09-01T00:00:00.000Z';
  const grace = lifecycle.transitionEffects('grace_period', { graceUntil });
  assert.equal(grace.grace_until, graceUntil);
  assert.equal(grace.suspended_at, null);

  const suspended = lifecycle.transitionEffects('suspended', { suspensionReason: 'payment failed' });
  assert.equal(suspended.suspension_reason, 'payment failed');
  assert.equal(suspended.suspended_at, 'now()');
});

test('no transition effect ever deletes tenant data or downgrades a plan', () => {
  const destructive = ['plan', 'plan_version_id', 'organization_id', 'deleted_at'];
  for (const state of lifecycle.STATES) {
    const effects = lifecycle.transitionEffects(state);
    for (const key of destructive) {
      assert.equal(key in effects, false, `${state} must not touch ${key}`);
    }
  }
});

test('allowedTransitions is a copy, so the matrix cannot be mutated by a caller', () => {
  const allowed = lifecycle.allowedTransitions('active');
  allowed.push('expired');
  assert.equal(lifecycle.canTransition('active', 'expired'), false);
});
