'use strict';

// Ordered public product cards for a set of ids. Tenant-scoped, active/out only, so
// draft / deleted / other-tenant ids silently drop out. Input order is preserved.
// Shared by recently-viewed (guest rendering) and product comparison.
const { productSelect } = require('./repository');

const MAX_CARDS = 48;

async function productCardsByIds(client, organizationId, ids, { limit = MAX_CARDS } = {}) {
  const cleanIds = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, limit);
  if (!cleanIds.length) return [];
  const result = await client.query(
    productSelect("p.organization_id = $1 and p.id = any($2::bigint[]) and p.status in ('active', 'out')", { includeSpinManifest: false }),
    [organizationId, cleanIds]
  );
  const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
  return cleanIds.map((id) => byId.get(id)).filter(Boolean);
}

module.exports = { productCardsByIds, MAX_CARDS };
