'use strict';

// A27 Host -> tenant resolution.
//
// The Host header is attacker-controlled. This module is the ONLY place a hostname is
// turned into a tenant, and it refuses everything that is not a canonically-normalized
// hostname belonging to an ACTIVE custom domain. Pending, verified-but-not-activated,
// failed and disabled rows deliberately do not resolve, so a half-finished claim can never
// serve or read another tenant's data.
//
// The existing slug + public-access-token model is untouched: a custom domain is an
// ADDITIONAL entry point, never a replacement, and it never widens what a caller may do.

const { hostnameFromHeader, isPlatformHostname } = require('./domainNames');
const { resolveActiveHost, canonicalHostname } = require('./customDomains');

// X-Forwarded-Host is only meaningful behind a proxy we control. Express sets req.hostname
// from it when `trust proxy` is configured, which this app does deliberately; taking the
// raw header from any request would let a client pick its own tenant.
function requestHostname(req, { trustForwarded = null } = {}) {
  const trusted = trustForwarded == null
    ? Boolean(req.app && req.app.get && req.app.get('trust proxy'))
    : trustForwarded;
  const forwarded = trusted ? req.get('x-forwarded-host') : '';
  // A forwarded chain may carry a comma-separated list; only the first entry is the
  // original client-facing host.
  const candidate = String(forwarded || '').split(',')[0].trim() || req.get('host') || '';
  return hostnameFromHeader(candidate);
}

// Resolves a request to a tenant by custom domain, or null when the host is not a live
// tenant domain. Returning null is the safe default: callers fall back to the existing
// slug/token resolution rather than guessing.
async function resolveTenantByHost(req, client, options = {}) {
  const hostname = requestHostname(req, options);
  if (!hostname) return null;
  // The platform's own hosts never resolve to a tenant, even if a row somehow existed.
  if (isPlatformHostname(hostname)) return null;
  const row = await resolveActiveHost(client, hostname);
  if (!row) return null;
  return {
    hostname,
    domainId: Number(row.domain_id),
    isCanonical: Boolean(row.is_canonical),
    redirectToCanonical: Boolean(row.redirect_to_canonical),
    organization: {
      id: row.organization_id,
      slug: row.slug,
      name: row.name,
      plan: row.plan,
      status: row.organization_status,
      store_settings: row.store_settings,
    },
  };
}

// Only GET/HEAD are redirected. Redirecting a mutating request to another host would move
// its body and credentials across an origin boundary, so those are served in place.
const REDIRECTABLE_METHODS = new Set(['GET', 'HEAD']);

function shouldRedirectToCanonical(resolved, method) {
  if (!resolved) return false;
  if (!REDIRECTABLE_METHODS.has(String(method || 'GET').toUpperCase())) return false;
  if (resolved.isCanonical) return false;
  return resolved.redirectToCanonical;
}

// Builds the canonical redirect target. The host comes exclusively from the database —
// never from a query parameter, a header, or anything the client supplied — so this cannot
// become an open redirect. Only the path and query are carried over.
function buildCanonicalRedirect(canonicalHost, originalUrl) {
  if (!canonicalHost) return null;
  const raw = String(originalUrl || '/');
  // Reject a protocol-relative or absolute original URL: only a path is ever forwarded.
  if (raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return `https://${canonicalHost}/`;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `https://${canonicalHost}${path}`;
}

// Resolves the canonical host for a tenant, for use in customer-facing URLs (verification
// links, magic links, order claims, unsubscribe links). Returns null when the tenant has
// no ACTIVE canonical domain, so callers fall back to the platform URL instead of ever
// emitting a link pointing at an unverified host.
async function canonicalHostFor(client, organizationId) {
  return canonicalHostname(client, organizationId);
}

// Origin trust for CSRF/CORS. A hostname is trusted for a tenant only when it is that
// tenant's ACTIVE domain — being present in the table is not enough, and a domain
// belonging to another tenant never authorises this one.
async function isTrustedOriginForOrganization(client, origin, organizationId) {
  const hostname = hostnameFromHeader(String(origin || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
  if (!hostname) return false;
  const result = await client.query(
    `select 1 from custom_domains
      where hostname = $1 and organization_id = $2 and status = 'active' limit 1`,
    [hostname, organizationId]
  );
  return Boolean(result.rows[0]);
}

module.exports = {
  REDIRECTABLE_METHODS,
  requestHostname,
  resolveTenantByHost,
  shouldRedirectToCanonical,
  buildCanonicalRedirect,
  canonicalHostFor,
  isTrustedOriginForOrganization,
};
