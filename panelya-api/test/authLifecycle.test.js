const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertEmailVerificationAllowed,
  buildPublicUrl,
  isEmailVerificationRequired,
} = require('../services/accountTokens');

test('isEmailVerificationRequired allows users inside the grace period', () => {
  const now = new Date('2026-04-22T10:00:00.000Z');
  const user = {
    created_at: '2026-04-21T18:30:00.000Z',
    email_verified_at: null,
  };

  assert.equal(isEmailVerificationRequired(user, now), false);
  assert.doesNotThrow(() => assertEmailVerificationAllowed(user, now));
});

test('isEmailVerificationRequired blocks users after the grace period', () => {
  const now = new Date('2026-04-22T10:00:00.000Z');
  const user = {
    created_at: '2026-04-20T08:00:00.000Z',
    email_verified_at: null,
  };

  assert.equal(isEmailVerificationRequired(user, now), true);
  assert.throws(
    () => assertEmailVerificationAllowed(user, now),
    (error) => error.message.includes('Email adresinizi dogrulamaniz gerekiyor') && error.status === 403
  );
});

test('buildPublicUrl appends token with the requested query parameter', () => {
  process.env.PUBLIC_SITE_URL = 'https://demo.panelya.com';

  const url = buildPublicUrl('/login', 'abc123', 'resetToken');

  assert.equal(url, 'https://demo.panelya.com/login?resetToken=abc123');
});
