'use strict';

// A27 central customer-facing URL resolution.
//
// One rule, in one place: a customer-facing link uses the tenant's ACTIVE CANONICAL custom
// domain when it has one, then that tenant's configured storefront URL. A platform
// fallback is allowed only during local development. The URL is never built from a
// request Host header (that is attacker-controlled), and a
// pending / verified-but-not-active / failed / disabled / released domain is never used —
// emailing a link to a host the tenant has not proven they own would be handing an
// attacker a verified-looking phishing target.

const { canonicalHostname } = require('./customDomains');
const net = require('node:net');

function storefrontUrlError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'STOREFRONT_URL_INVALID' });
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

function isValidPublicHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  if (normalized.length > 253 || !normalized.includes('.') || net.isIP(normalized)) return false;
  return normalized.split('.').every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function normalizeStorefrontUrl(value, { environment = process.env.NODE_ENV || 'development' } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw storefrontUrlError('Gecerli bir storefront adresi girin');
  }
  const production = environment === 'production';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !production && isLocalHostname(parsed.hostname))) {
    throw storefrontUrlError(production
      ? 'Production storefront adresi HTTPS olmali'
      : 'HTTP yalnizca local development icin kullanilabilir');
  }
  const originOnly = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(raw);
  if (!parsed.hostname || parsed.username || parsed.password || !originOnly
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw storefrontUrlError('Storefront adresi yalnizca guvenli bir origin olmali');
  }
  if (production && (isLocalHostname(parsed.hostname) || !isValidPublicHostname(parsed.hostname))) {
    throw storefrontUrlError('Production storefront adresi gecerli bir public hostname olmali');
  }
  return parsed.origin;
}

function platformStorefrontBase() {
  try {
    return normalizeStorefrontUrl(process.env.PUBLIC_SITE_URL || '');
  } catch {
    return '';
  }
}

// Resolves the base origin for links sent to this tenant's customers. Returns '' when no
// usable base exists, so callers skip sending rather than emitting a broken/unsafe link.
async function resolveStorefrontBaseUrl(client, organizationId, {
  environment = process.env.NODE_ENV || 'development',
} = {}) {
  if (organizationId && client) {
    try {
      const hostname = await canonicalHostname(client, organizationId);
      // canonicalHostname only ever returns an ACTIVE canonical row, so this cannot leak
      // an unverified host into an email.
      if (hostname) return { baseUrl: `https://${hostname}`, source: 'custom_domain' };
    } catch (_) {
      // Continue to the tenant's stored deployment URL.
    }
    try {
      const result = await client.query(
        'select storefront_url from organizations where id = $1 limit 1',
        [organizationId]
      );
      const configured = normalizeStorefrontUrl(result.rows[0]?.storefront_url || '', { environment });
      if (configured) return { baseUrl: configured, source: 'storefront_url' };
    } catch (error) {
      if (error?.code === 'STOREFRONT_URL_INVALID') {
        return { baseUrl: '', source: 'invalid_storefront_url' };
      }
    }
  }
  if (environment !== 'production') {
    const fallback = platformStorefrontBase();
    if (fallback) return { baseUrl: fallback, source: 'development_fallback' };
  }
  return { baseUrl: '', source: 'unconfigured' };
}

async function storefrontBaseUrl(client, organizationId, options) {
  return (await resolveStorefrontBaseUrl(client, organizationId, options)).baseUrl;
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
  normalizeStorefrontUrl,
  platformStorefrontBase,
  resolveStorefrontBaseUrl,
  storefrontBaseUrl,
  buildCustomerUrl,
};
