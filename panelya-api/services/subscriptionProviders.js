'use strict';

// A26 subscription provider adapters.
//
// Canonical interface every adapter implements:
//   createCustomer, startSubscription, changePlan, cancel, resume, getStatus,
//   handleWebhook, verifyWebhook
//
// There is deliberately NO Stripe or iyzico subscription adapter here. This repo has a
// verified iyzico adapter for one-off PAYMENTS (services/paymentProviders.js), but no
// verified subscription/billing API integration for either provider — so inventing
// endpoints, payload shapes or webhook signature formats would produce code that looks
// finished and fails in production. Those adapters report `not_configured` instead, and
// every mutation refuses rather than pretending. Nothing here can mark money as received:
// `paid` is only ever produced from a real settlement recorded through the manual
// provider by a super-admin, or by the deterministic test provider.

const { lifecycleError } = require('./subscriptionLifecycle');

const PROVIDERS = Object.freeze(['manual', 'test', 'stripe', 'iyzico']);

function providerError(message, code, status = 400, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

function notConfigured(provider, operation) {
  return providerError(
    `${provider} abonelik entegrasyonu yapilandirilmamis`,
    'SUBSCRIPTION_PROVIDER_NOT_CONFIGURED',
    503,
    { provider, operation, status: 'not_configured' }
  );
}

function isTestEnv() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return env === 'test' || String(process.env.E2E || '') === 'true';
}

// --- manual / admin-operated provider ------------------------------------------------
//
// Fully functional: a super-admin performs the billing action out of band (bank transfer,
// invoice, contract) and records it here. Every result is explicit about the fact that no
// automated charge happened, so no caller can mistake it for a settled payment.

const manualProvider = {
  name: 'manual',
  supportsProration: false,

  async createCustomer({ organizationId }) {
    // A manual customer needs no remote object; the tenant IS the customer reference.
    return { provider: 'manual', customerReference: `manual:${organizationId}`, created: true };
  },

  async startSubscription({ organizationId, planName, planVersionId, periodEnd, trialEnd }) {
    return {
      provider: 'manual',
      subscriptionReference: `manual:${organizationId}:${planName}`,
      status: trialEnd ? 'trialing' : 'active',
      planName,
      planVersionId,
      currentPeriodEnd: periodEnd || null,
      trialEnd: trialEnd || null,
      // No money moved: the admin records an invoice separately if one is owed.
      settled: false,
    };
  },

  async changePlan({ targetPlanName, targetPlanVersionId }) {
    return {
      provider: 'manual',
      status: 'applied',
      planName: targetPlanName,
      planVersionId: targetPlanVersionId,
      // Explicit, deterministic business rule rather than imitated Stripe/iyzico maths.
      proration: { supported: false, reason: 'manual_provider_no_proration', amount: null },
      settled: false,
    };
  },

  async cancel({ atPeriodEnd = true }) {
    return { provider: 'manual', status: atPeriodEnd ? 'cancel_at_period_end' : 'cancelled' };
  },

  async resume() {
    return { provider: 'manual', status: 'active' };
  },

  async getStatus({ currentStatus }) {
    // The manual provider has no remote truth; local state IS the truth.
    return { provider: 'manual', status: currentStatus, authoritative: false };
  },

  async verifyWebhook() {
    // A manual provider never receives webhooks; accepting one would be an open door.
    throw providerError('Manual saglayici webhook kabul etmez', 'WEBHOOK_NOT_SUPPORTED', 400);
  },

  async handleWebhook() {
    throw providerError('Manual saglayici webhook kabul etmez', 'WEBHOOK_NOT_SUPPORTED', 400);
  },
};

// --- deterministic test provider ------------------------------------------------------
//
// Only selectable under NODE_ENV=test / E2E. It is deterministic (no randomness, no
// clock-dependent behaviour) so E2E can drive the whole lifecycle, and it still never
// fabricates a settlement it was not explicitly asked to produce.

const testProvider = {
  ...manualProvider,
  name: 'test',
  supportsProration: true,

  async createCustomer({ organizationId }) {
    return { provider: 'test', customerReference: `test_cus_${organizationId}`, created: true };
  },

  async startSubscription({ organizationId, planName, planVersionId, periodEnd, trialEnd }) {
    return {
      provider: 'test',
      subscriptionReference: `test_sub_${organizationId}`,
      status: trialEnd ? 'trialing' : 'active',
      planName,
      planVersionId,
      currentPeriodEnd: periodEnd || null,
      trialEnd: trialEnd || null,
      settled: false,
    };
  },

  async changePlan({ targetPlanName, targetPlanVersionId, prorationAmount = null }) {
    return {
      provider: 'test',
      status: 'applied',
      planName: targetPlanName,
      planVersionId: targetPlanVersionId,
      // The amount is whatever the caller states; this adapter computes no money itself.
      proration: {
        supported: true,
        reason: prorationAmount == null ? 'no_proration_reported' : 'provider_reported',
        amount: prorationAmount,
      },
      settled: false,
    };
  },

  async verifyWebhook({ signature }) {
    // Deterministic and explicit: the test harness passes a known shared value.
    const expected = String(process.env.TEST_BILLING_WEBHOOK_SECRET || 'test-billing-secret');
    if (String(signature || '') !== expected) {
      throw providerError('Webhook imzasi dogrulanamadi', 'WEBHOOK_SIGNATURE_INVALID', 401);
    }
    return { verified: true };
  },

  async handleWebhook({ event }) {
    // Normalises into the canonical shape the billing event processor consumes.
    return normalizeProviderEvent('test', event);
  },
};

// --- unconfigured real providers ------------------------------------------------------

function unconfiguredProvider(name) {
  const reject = (operation) => async () => { throw notConfigured(name, operation); };
  return {
    name,
    supportsProration: false,
    configured: false,
    createCustomer: reject('createCustomer'),
    startSubscription: reject('startSubscription'),
    changePlan: reject('changePlan'),
    cancel: reject('cancel'),
    resume: reject('resume'),
    getStatus: reject('getStatus'),
    // Refusing to verify means an unverified webhook can never be treated as authentic.
    verifyWebhook: reject('verifyWebhook'),
    handleWebhook: reject('handleWebhook'),
  };
}

// Normalises any provider event into the shape billing_events stores, so the processor
// never has to know provider-specific field names.
function normalizeProviderEvent(provider, event = {}) {
  const id = String(event.id || event.event_id || '').trim();
  if (!id) throw providerError('Saglayici olay kimligi zorunlu', 'BILLING_EVENT_ID_REQUIRED', 400);
  const type = String(event.type || event.event_type || '').trim();
  if (!type) throw providerError('Saglayici olay tipi zorunlu', 'BILLING_EVENT_TYPE_REQUIRED', 400);
  const sequenceRaw = event.sequence ?? event.created ?? null;
  const sequence = sequenceRaw == null ? null : Number(sequenceRaw);
  return {
    provider,
    providerEventId: id.slice(0, 200),
    eventType: type.slice(0, 120),
    eventSequence: Number.isFinite(sequence) ? Math.trunc(sequence) : null,
    eventCreatedAt: event.created_at ? new Date(event.created_at) : null,
    // Signatures/secrets are never carried into the stored payload.
    payload: sanitizeEventPayload(event.data || event.payload || {}),
  };
}

const SECRET_KEYS = /(signature|secret|token|authorization|api[_-]?key|password)/i;

function sanitizeEventPayload(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeEventPayload(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, nested]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : sanitizeEventPayload(nested, depth + 1)])
  );
}

const ADAPTERS = {
  manual: manualProvider,
  test: testProvider,
  stripe: unconfiguredProvider('stripe'),
  iyzico: unconfiguredProvider('iyzico'),
};

// Resolves the adapter for a subscription's provider. The test adapter is refused outside
// a test environment so a misconfiguration can never make production deterministic-fake.
function getProvider(name) {
  const provider = String(name || 'manual').trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw providerError(`Bilinmeyen abonelik saglayicisi: ${provider}`, 'UNKNOWN_SUBSCRIPTION_PROVIDER', 400);
  }
  if (provider === 'test' && !isTestEnv()) {
    throw providerError(
      'Test abonelik saglayicisi yalnizca test ortaminda kullanilabilir',
      'TEST_PROVIDER_NOT_ALLOWED', 500
    );
  }
  return ADAPTERS[provider];
}

function providerCapabilities(name) {
  const adapter = getProvider(name);
  return {
    provider: adapter.name,
    configured: adapter.configured !== false,
    supportsProration: Boolean(adapter.supportsProration),
  };
}

module.exports = {
  PROVIDERS,
  getProvider,
  providerCapabilities,
  normalizeProviderEvent,
  sanitizeEventPayload,
  notConfigured,
  providerError,
  lifecycleError,
};
