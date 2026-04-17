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
    || req.query.organization
    || req.body.organizationSlug
    || process.env.DEFAULT_ORGANIZATION_SLUG
    || 'maveran'
  );
}

async function resolveOrganization(req, client = db) {
  const slug = requestedOrganizationSlug(req);
  const result = await client.query(
    `select id, name, slug, plan, status
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
  resolveOrganization,
  slugify,
};
