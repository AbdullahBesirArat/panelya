'use strict';

// A27 domain/certificate provider adapters.
//
// There is NO Vercel/Cloudflare/Railway domain API client here. This repo has no verified
// credentials, endpoint contract or token scope for one, and inventing them would produce
// code that looks finished and fails in production — worse, it would let the UI claim a
// certificate is active when nothing was provisioned. The default adapter therefore
// reports `not_configured` and never fabricates an active certificate.

function providerError(message, code, status = 400, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

function isTestEnv() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return env === 'test' || String(process.env.E2E_TEST_MODE || '') === 'true';
}

// Manual/default: the operator points DNS at the platform and terminates TLS at the edge
// out of band. Ownership is still proven by DNS TXT, so activation is safe; we simply do
// not claim to manage the certificate.
const manualProvider = {
  name: 'manual',
  configured: false,
  async attachDomain() {
    // not_configured is an honest state, not a failure: the domain still activates, the
    // certificate is just not managed by us.
    return { attached: false, sslStatus: 'not_configured', reason: 'certificate_not_managed' };
  },
  async detachDomain() {
    return { detached: false, reason: 'certificate_not_managed' };
  },
  async getDomainStatus() {
    return { status: 'unknown', configured: false };
  },
  async getCertificateStatus() {
    return { sslStatus: 'not_configured', configured: false };
  },
};

// Deterministic adapter for tests/E2E: it models a real provider's lifecycle without any
// network call, and it still cannot produce 'active' unless explicitly driven there.
const testProvider = {
  name: 'test',
  configured: true,
  async attachDomain() {
    return { attached: true, sslStatus: 'provisioning', reason: null };
  },
  async detachDomain() {
    return { detached: true, reason: null };
  },
  async getDomainStatus() {
    return { status: 'attached', configured: true };
  },
  async getCertificateStatus({ simulate = 'active' } = {}) {
    const allowed = ['pending', 'provisioning', 'active', 'failed'];
    if (!allowed.includes(simulate)) {
      throw providerError('Gecersiz sertifika durumu', 'INVALID_SSL_STATUS', 400);
    }
    return { sslStatus: simulate, configured: true };
  },
};

// A real provider slot that refuses every operation until a verified integration exists.
function unconfiguredProvider(name) {
  const reject = (operation) => async () => {
    throw providerError(
      `${name} alan adi entegrasyonu yapilandirilmamis`,
      'DOMAIN_PROVIDER_NOT_CONFIGURED', 503,
      { provider: name, operation, status: 'not_configured' }
    );
  };
  return {
    name,
    configured: false,
    attachDomain: reject('attachDomain'),
    detachDomain: reject('detachDomain'),
    getDomainStatus: reject('getDomainStatus'),
    getCertificateStatus: reject('getCertificateStatus'),
  };
}

const ADAPTERS = {
  manual: manualProvider,
  test: testProvider,
  vercel: unconfiguredProvider('vercel'),
};

function getDomainProvider(name = process.env.DOMAIN_PROVIDER) {
  const provider = String(name || 'manual').trim().toLowerCase();
  if (!ADAPTERS[provider]) {
    throw providerError(`Bilinmeyen alan adi saglayicisi: ${provider}`, 'UNKNOWN_DOMAIN_PROVIDER', 400);
  }
  if (provider === 'test' && !isTestEnv()) {
    throw providerError(
      'Test alan adi saglayicisi yalnizca test ortaminda kullanilabilir',
      'TEST_DOMAIN_PROVIDER_NOT_ALLOWED', 500
    );
  }
  return ADAPTERS[provider];
}

function domainProviderCapabilities(name = process.env.DOMAIN_PROVIDER) {
  const adapter = getDomainProvider(name);
  return { provider: adapter.name, configured: adapter.configured !== false };
}

module.exports = {
  getDomainProvider,
  domainProviderCapabilities,
  providerError,
  isTestEnv,
};
