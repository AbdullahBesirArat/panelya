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
      `select id, name, slug, plan, status, store_settings
       from organizations
       where ${conditions.join(' and ')}
       limit 1`,
      params
    );

    if (!result.rows[0]) {
      throw Object.assign(new Error('Organizasyon bulunamadi'), { status: 404 });
    }

    return result.rows[0];
  }

  const slug = requestedOrganizationSlug(req);
  const result = await client.query(
    `select id, name, slug, plan, status, store_settings
     from organizations
     where slug = $1 and status <> 'suspended'
     limit 1`,
    [slug]
  );

  if (!result.rows[0]) {
    throw Object.assign(new Error('Organizasyon bulunamadi'), { status: 404 });
  }

  return result.rows[0];
}

module.exports = {
  requestedOrganizationSlug,
  requestedPublicAccessToken,
  resolveOrganization,
  slugify,
};
