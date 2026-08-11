const crypto = require('crypto');

function stableQuery(query) {
  return Object.fromEntries(Object.keys(query).sort().map((key) => [key, query[key]]));
}

function catalogCacheKey({ organizationId, organizationSlug, host, query }) {
  return JSON.stringify({
    organizationId: String(organizationId || ''),
    organizationSlug: String(organizationSlug || ''),
    host: String(host || '').toLowerCase(),
    query: stableQuery(query),
  });
}

function responseEtag(cacheKey, body) {
  const digest = crypto.createHash('sha256').update(cacheKey).update('\0').update(JSON.stringify(body)).digest('base64url');
  return `"${digest}"`;
}

function applyCatalogCache(req, res, organization, query, body) {
  if (req.auth) {
    res.setHeader('Cache-Control', 'private, no-store');
    return false;
  }
  const key = catalogCacheKey({
    organizationId: organization.id,
    organizationSlug: organization.slug,
    host: req.get('host'),
    query,
  });
  const etag = responseEtag(key, body);
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
  res.setHeader('Vary', 'Origin, Host, X-Organization-Slug, X-Public-Access-Token');
  res.setHeader('ETag', etag);
  if (req.get('if-none-match') === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

module.exports = { applyCatalogCache, catalogCacheKey, responseEtag, stableQuery };
