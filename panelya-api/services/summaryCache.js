const DEFAULT_TTL_MS = Math.max(Number(process.env.ORGANIZATION_SUMMARY_CACHE_TTL_MS || 60000), 5000);

const summaryCache = new Map();

function cacheKey(organizationId) {
  return String(organizationId || '');
}

function getOrganizationSummary(organizationId) {
  const entry = summaryCache.get(cacheKey(organizationId));
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    summaryCache.delete(cacheKey(organizationId));
    return null;
  }

  return entry.value;
}

function setOrganizationSummary(organizationId, value, ttlMs = DEFAULT_TTL_MS) {
  summaryCache.set(cacheKey(organizationId), {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function invalidateOrganizationSummary(organizationId) {
  if (!organizationId) return;
  summaryCache.delete(cacheKey(organizationId));
}

module.exports = {
  getOrganizationSummary,
  invalidateOrganizationSummary,
  setOrganizationSummary,
};
