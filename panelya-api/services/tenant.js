const db = require('../db');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/\u011f/g, 'g').replace(/\u00fc/g, 'u').replace(/\u015f/g, 's')
    .replace(/\u0131/g, 'i').replace(/\u00f6/g, 'o').replace(/\u00e7/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function requestedOrganizationSlug(req) {
  if (req.auth?.actorType === 'app' && req.auth.organizationSlug) {
    return slugify(req.auth.organizationSlug);
  }

  return slugify(
    req.get('x-organization-slug')
    || req.query.organizationSlug
    || req.query.organization
    || req.body?.organizationSlug
    || process.env.DEFAULT_ORGANIZATION_SLUG
    || 'panelya'
  );
}

function requestedPublicAccessToken(req) {
  return String(
    req.get('x-public-access-token')
    || req.query.publicAccessToken
    || req.body?.publicAccessToken
    || ''
  ).trim();
}

// A27 Host -> tenant. Loaded lazily to avoid a require cycle (customDomains needs
// planLimits, which needs planVersions). Returns null for any host that is not a live
// tenant domain, so the caller falls back to the existing slug/token model.
async function resolveOrganizationByHost(req, client) {
  const { requestHostname } = require('./hostResolution');
  const { isPlatformHostname } = require('./domainNames');
  const hostname = requestHostname(req);
  if (!hostname || isPlatformHostname(hostname)) return null;
  // This lookup necessarily runs BEFORE any tenant context exists — deciding which tenant
  // a Host belongs to is the whole point — and custom_domains is FORCE RLS, so a
  // tenant-scoped client would filter every row away. The system pool is the correct tool
  // here, and the query is still tightly bounded: one exact hostname, active only.
  const result = await db.systemQuery(
    `select o.id, o.name, o.slug, o.plan, o.status, o.store_settings, o.public_access_token
       from custom_domains d
       join organizations o on o.id = d.organization_id
      where d.hostname = $1 and d.status = 'active' and o.status <> 'suspended'
      limit 1`,
    [hostname]
  );
  return result.rows[0] || null;
}

async function resolveOrganization(req, client = db, options = {}) {
  const { allowPublic = false } = options;
  if (allowPublic && !req.auth) {
    const publicAccessToken = requestedPublicAccessToken(req);
    const slug = slugify(
      req.get('x-organization-slug')
      || req.query.organizationSlug
      || req.query.organization
      || req.body?.organizationSlug
      || ''
    );

    // A27: a VERIFIED + ACTIVE custom domain is an additional public entry point. It is
    // consulted before the token path so a storefront served from the tenant's own domain
    // works, but it never widens access: the Host must belong to an active domain row, and
    // if the request ALSO carries a slug or token they have to agree with it. A mismatch
    // is refused rather than resolved to either side, so a valid token for tenant B cannot
    // be replayed against tenant A's host (or the reverse).
    const hostOrganization = await resolveOrganizationByHost(req, client);
    if (hostOrganization) {
      if (slug && slug !== hostOrganization.slug) {
        throw Object.assign(new Error('Alan adi ve magaza uyusmuyor'), {
          status: 400, code: 'HOST_TENANT_MISMATCH',
        });
      }
      if (publicAccessToken && publicAccessToken !== hostOrganization.public_access_token) {
        throw Object.assign(new Error('Alan adi ve erisim anahtari uyusmuyor'), {
          status: 403, code: 'HOST_TOKEN_MISMATCH',
        });
      }
      if (client === db) await db.activateTenantContext(hostOrganization.id);
      return hostOrganization;
    }

    if (!publicAccessToken) {
      throw Object.assign(new Error('Public access token zorunlu'), { status: 401 });
    }

    const params = [publicAccessToken];
    const conditions = ['public_access_token = $1', "status <> 'suspended'"];
    if (slug) {
      params.push(slug);
      conditions.push(`slug = $${params.length}`);
    }

    const result = await client.query(
      `select id, name, slug, plan, status, store_settings, storefront_url
       from organizations
       where ${conditions.join(' and ')}
       limit 1`,
      params
    );

    if (!result.rows[0]) {
      throw Object.assign(new Error('Organizasyon bulunamadi'), { status: 404 });
    }

    const organization = result.rows[0];
    if (client === db) {
      await db.activateTenantContext(organization.id);
    }
    return organization;
  }

  const slug = requestedOrganizationSlug(req);
  const result = await client.query(
    `select id, name, slug, plan, status, store_settings, storefront_url
     from organizations
     where slug = $1 and status <> 'suspended'
     limit 1`,
    [slug]
  );

  if (!result.rows[0]) {
    throw Object.assign(new Error('Organizasyon bulunamadi'), { status: 404 });
  }

  const organization = result.rows[0];
  if (client === db) {
    await db.activateTenantContext(organization.id);
  }
  return organization;
}

module.exports = {
  resolveOrganizationByHost,
  requestedOrganizationSlug,
  requestedPublicAccessToken,
  resolveOrganization,
  slugify,
};
