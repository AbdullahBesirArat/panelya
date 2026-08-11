'use strict';

// A27 DNS resolver abstraction.
//
// Ownership verification needs exactly one capability: read TXT records. It does NOT make
// HTTP requests to the domain, so there is no SSRF surface here to defend — the safest
// way to be SSRF-proof is to have no fetch at all, which is the design.
//
// There is no Cloudflare/Route53/registrar API client here: this repo has no verified
// credentials or integration for one, and inventing endpoints would produce code that
// looks finished and fails in production. Standard DNS lookup is sufficient to prove
// ownership.

const dns = require('node:dns');

const DEFAULT_TIMEOUT_MS = Math.min(Math.max(Number(process.env.DOMAIN_DNS_TIMEOUT_MS || 5000), 500), 20000);

function dnsError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// A single lookup must never hang a request. Node's resolver has no per-query timeout
// option, so the promise is raced against an explicit deadline and the resolver is
// cancelled so the socket does not leak.
function withTimeout(promise, resolver, timeoutMs) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { resolver.cancel(); } catch (_) { /* already settled */ }
      reject(dnsError('DNS sorgusu zaman asimina ugradi', 'DNS_TIMEOUT', 504));
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

// Production adapter: the system resolver, TXT only.
function systemResolver({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    name: 'system',
    async resolveTxt(hostname) {
      const resolver = new dns.promises.Resolver();
      try {
        const records = await withTimeout(resolver.resolveTxt(hostname), resolver, timeoutMs);
        // Node returns chunked strings per record; a TXT value split across chunks must be
        // rejoined before comparison or a long challenge would never match.
        return records.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
      } catch (error) {
        if (error.code === 'DNS_TIMEOUT') throw error;
        // ENOTFOUND/ENODATA are normal "not published yet" states, not failures.
        if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(error.code)) return [];
        throw dnsError('DNS sorgusu basarisiz', 'DNS_LOOKUP_FAILED', 502);
      }
    },
    // A29: address resolution for outbound webhook delivery. Separate from resolveTxt on
    // purpose — A27 verifies ownership, A29 decides where a socket is allowed to connect —
    // but it shares this adapter so tests override one resolver, not two.
    async resolveAddresses(hostname) {
      const resolver = new dns.promises.Resolver();
      const settled = await Promise.allSettled([
        withTimeout(resolver.resolve4(hostname), resolver, timeoutMs),
        withTimeout(new dns.promises.Resolver().resolve6(hostname), resolver, timeoutMs),
      ]);
      const addresses = [];
      for (const [index, result] of settled.entries()) {
        if (result.status !== 'fulfilled') continue;
        for (const address of result.value || []) {
          addresses.push({ address: String(address), family: index === 0 ? 4 : 6 });
        }
      }
      return addresses;
    },
  };
}

// Deterministic adapter for tests/E2E. Records are supplied in-process; nothing touches
// the network, so the suite never depends on real internet DNS.
function staticResolver(records = new Map()) {
  const table = records instanceof Map ? records : new Map(Object.entries(records || {}));
  // A29 address table, kept apart from the TXT table so a test cannot accidentally answer
  // an address query with a verification challenge.
  const addressTable = new Map();
  return {
    name: 'static',
    table,
    addressTable,
    set(hostname, values) { table.set(String(hostname).toLowerCase(), [].concat(values || [])); },
    setAddresses(hostname, values) {
      addressTable.set(String(hostname).toLowerCase(), [].concat(values || []).map((entry) => (
        typeof entry === 'string'
          ? { address: entry, family: entry.includes(':') ? 6 : 4 }
          : entry
      )));
    },
    clear() { table.clear(); addressTable.clear(); },
    async resolveTxt(hostname) {
      return table.get(String(hostname).toLowerCase()) || [];
    },
    async resolveAddresses(hostname) {
      const key = String(hostname).toLowerCase();
      const entry = addressTable.get(key);
      // A function lets a test model a REBINDING host: successive calls return different
      // answers, which is exactly the attack the delivery client has to survive.
      if (typeof entry === 'function') return entry();
      return entry || [];
    },
  };
}

// Process-wide resolver, overridable by tests. The test resolver is refused outside a test
// environment so a misconfiguration cannot make production verification fake.
let activeResolver = null;

function isTestEnv() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return env === 'test' || String(process.env.E2E_TEST_MODE || '') === 'true';
}

function getResolver() {
  if (activeResolver) return activeResolver;
  const configured = String(process.env.DOMAIN_DNS_RESOLVER || '').trim().toLowerCase();
  if (configured === 'static') {
    if (!isTestEnv()) {
      throw dnsError(
        'Statik DNS resolver yalnizca test ortaminda kullanilabilir',
        'DNS_STATIC_RESOLVER_NOT_ALLOWED', 500
      );
    }
    activeResolver = staticResolver();
    return activeResolver;
  }
  activeResolver = systemResolver();
  return activeResolver;
}

function setResolver(resolver) {
  activeResolver = resolver || null;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  dnsError,
  systemResolver,
  staticResolver,
  getResolver,
  setResolver,
  isTestEnv,
};
