'use strict';

// A30 TOTP.
//
// The RFC6238/HOTP/base32 machinery comes from otplib rather than being written here. What
// this module owns is the POLICY, because otplib's defaults are not the ones we want:
//
//   * `window: 0` by default means zero tolerance, which rejects a user whose phone clock
//     is two seconds off. `window: 1` accepts the immediately previous and next step —
//     enough for real clock drift, and no wider, because every extra step is another
//     30-second slice during which a shoulder-surfed code still works.
//   * Every parameter is set explicitly. Inheriting a library default means a library
//     upgrade could silently change what codes this platform accepts.

const { authenticator } = require('otplib');

const ALGORITHM = 'sha1'; // What every authenticator app implements. Not a security choice.
const DIGITS = 6;
const STEP_SECONDS = 30;
// One step either side. Deliberately narrow: see above.
const WINDOW = 1;
const ISSUER = 'Panelya';

/** A configured instance, so no caller can accidentally verify with library defaults. */
function configured() {
  return authenticator.clone({
    algorithm: ALGORITHM,
    digits: DIGITS,
    step: STEP_SECONDS,
    window: WINDOW,
  });
}

function generateSecret() {
  return configured().generateSecret();
}

/** The time-step a code belongs to. This is what makes a used code un-replayable. */
function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Verifies a code and returns WHICH step it belonged to, not just whether it matched.
 *
 * The step is the point: a TOTP code stays valid for its whole window, so "was this code
 * correct" is not enough — the caller has to record the step and refuse it a second time.
 * Returns null when nothing in the accepted window matches.
 */
function verifyCode({ secret, token, now = Date.now() }) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const instance = configured();
  const current = currentStep(now);
  // Checked one step at a time so the matching step is known; otplib's own verify only
  // answers yes/no across the window.
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const step = current + offset;
    const epoch = step * STEP_SECONDS * 1000;
    let expected;
    try {
      expected = instance.clone({ epoch }).generate(secret);
    } catch (_) {
      return null;
    }
    if (timingSafeStringEquals(expected, code)) return { step };
  }
  return null;
}

const crypto = require('crypto');

/** Length-checked first: timingSafeEqual throws on a mismatch, and a throw is an oracle. */
function timingSafeStringEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * The otpauth:// URI an authenticator app scans. Every parameter is explicit so the app
 * enrols with exactly the policy above rather than its own assumptions about defaults.
 */
function otpauthUri({ accountName, secret }) {
  const label = String(accountName || 'user').slice(0, 100);
  return configured().keyuri(label, ISSUER, secret);
}

module.exports = {
  ALGORITHM,
  DIGITS,
  ISSUER,
  STEP_SECONDS,
  WINDOW,
  currentStep,
  generateSecret,
  otpauthUri,
  timingSafeStringEquals,
  verifyCode,
};
