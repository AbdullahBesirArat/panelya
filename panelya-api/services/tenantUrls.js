'use strict';

// A27 central customer-facing URL resolution.
//
// One rule, in one place: a customer-facing link uses the tenant's ACTIVE CANONICAL custom
// domain when it has one, and the configured platform storefront URL otherwise. It is
// never built from a request Host header (that is attacker-controlled), and a
// pending / verified-but-not-active / failed / disabled / released domain is never used —
// emailing a link to a host the tenant has not proven they own would be handing an
// attacker a verified-looking phishing target.

const { canonicalHostname } = require('./customDomains');

function platformStorefrontBase() {
  const configured = String(process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  if (!configured) return '';
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return configured;
  } catch {
    return '';
  }
}

// Resolves the base origin for links sent to this tenant's customers. Returns '' when no
// usable base exists, so callers skip sending rather than emitting a broken/unsafe link.
async function storefrontBaseUrl(client, organizationId) {
  if (organizationId && client) {
    try {
      const hostname = await canonicalHostname(client, organizationId);
      // canonicalHostname only ever returns an ACTIVE canonical row, so this cannot leak
      // an unverified host into an email.
      if (hostname) return `https://${hostname}`;
    } catch (_) {
      // A lookup failure must not break transactional email; fall back to the platform URL.
    }
  }
  return platformStorefrontBase();
}

// Builds a customer-facing link from a resolved base. The path is fixed by the caller and
// the query is built with URLSearchParams, so nothing the customer supplied can steer the
// destination.
function buildCustomerUrl(base, path, params = {}) {
  const origin = String(base || '').replace(/\/$/, '');
  if (!origin) return '';
  const safePath = String(path || '/').startsWith('/') ? String(path) : `/${path}`;
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value != null && value !== ''))
  ).toString();
  return `${origin}${safePath}${query ? `?${query}` : ''}`;
}

module.exports = {
  platformStorefrontBase,
  storefrontBaseUrl,
  buildCustomerUrl,
};
