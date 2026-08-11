'use strict';

// Normalized provider outcomes so the worker's retry / dead-letter logic never
// depends on a specific provider SDK.
const RESULT = Object.freeze({
  SENT: 'sent',
  TEMPORARY: 'temporary_failure',
  PERMANENT: 'permanent_failure',
  RATE_LIMITED: 'rate_limited',
  INVALID: 'invalid_recipient',
});

const RETRYABLE = new Set([RESULT.TEMPORARY, RESULT.RATE_LIMITED]);

function isProductionEnv() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

// Deterministic test provider: the recipient encodes the outcome so integration /
// E2E tests exercise every branch with no live credentials and no network.
function testProvider(channel) {
  return {
    channel,
    name: 'test',
    async send({ recipient }) {
      const target = String(recipient || '').toLowerCase();
      if (!target || target.includes('invalid')) {
        return { status: RESULT.INVALID, metadata: { marked: 'invalid' } };
      }
      if (target.includes('permfail')) return { status: RESULT.PERMANENT, metadata: { marked: 'blocked' } };
      if (target.includes('tempfail')) return { status: RESULT.TEMPORARY, metadata: { marked: 'transient' } };
      if (target.includes('ratelimit')) return { status: RESULT.RATE_LIMITED, retryAfterSeconds: 30, metadata: { marked: 'rate_limited' } };
      return {
        status: RESULT.SENT,
        providerMessageId: `test-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        metadata: {},
      };
    },
  };
}

// Real email bridges to the existing services/email.js abstraction. Transport errors
// map to transient (retry) unless clearly permanent, so a blip never dead-letters.
function emailProvider() {
  return {
    channel: 'email',
    name: 'email',
    async send({ recipient, subject, text, html }) {
      // Lazy-require so unit tests that never send email don't load the transport.
      const { sendEmail } = require('../../services/email');
      try {
        const result = await sendEmail({ to: recipient, subject, text, html, account: 'suvera' });
        if (result && result.skipped) return { status: RESULT.PERMANENT, metadata: { skipped: true } };
        return { status: RESULT.SENT, metadata: {} };
      } catch (error) {
        const message = String((error && error.message) || '');
        const transient = /timeout|network|429|rate|5\d\d|econn|temporarily/i.test(message);
        return { status: transient ? RESULT.TEMPORARY : RESULT.PERMANENT, metadata: { error: 'send_failed' } };
      }
    },
  };
}

function configuredProviderName(channel) {
  return String(process.env[`NOTIFICATION_${channel.toUpperCase()}_PROVIDER`] || '').trim().toLowerCase();
}

// Config-driven provider selection. Never silently mocks in production: an
// unconfigured channel is a hard error, so the message stays in the outbox for
// retry instead of vanishing.
function getProvider(channel) {
  const name = configuredProviderName(channel);
  if (name === 'test') return testProvider(channel);
  if (channel === 'email' && ['email', 'resend', 'brevo'].includes(name)) return emailProvider();
  if (!name) {
    if (isProductionEnv()) {
      throw Object.assign(new Error(`Bildirim provider tanimli degil: ${channel}`), { code: 'PROVIDER_NOT_CONFIGURED' });
    }
    return testProvider(channel);
  }
  throw Object.assign(new Error(`Desteklenmeyen bildirim provider: ${channel}=${name}`), { code: 'PROVIDER_UNSUPPORTED' });
}

module.exports = { RESULT, RETRYABLE, getProvider, testProvider, emailProvider, configuredProviderName };
