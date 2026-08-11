'use strict';

// A24.2 related / complementary / upsell products. Admin curates explicit links;
// the storefront falls back to a deterministic same-category / shared-collection query
// (active + in-stock, excludes the source, no personalization) when none are curated.
const { productSelect } = require('./repository');

const RELATION_TYPES = ['related', 'complementary', 'upsell'];
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

function relationError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function assertType(relationType) {
  if (!RELATION_TYPES.includes(relationType)) throw relationError('Gecersiz iliski turu', 'INVALID_RELATION_TYPE', 400);
}

// Admin: replace the curated target list for (source, relation_type) atomically.
async function setRelations(client, { organizationId, sourceProductId, relationType, targetProductIds = [] }) {
  assertType(relationType);
  const source = Number(sourceProductId);
  const src = await client.query('select id from products where organization_id = $1 and id = $2', [organizationId, source]);
  if (!src.rows[0]) throw relationError('Kaynak urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);

  const targets = [...new Set((targetProductIds || [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0 && id !== source))];
  if (targets.length) {
    const found = await client.query(
      'select id from products where organization_id = $1 and id = any($2::bigint[])',
      [organizationId, targets]
    );
    if (found.rows.length !== targets.length) throw relationError('Bazi hedef urunler bulunamadi', 'TARGET_NOT_FOUND', 400);
  }

  await client.query(
    'delete from product_relations where organization_id = $1 and source_product_id = $2 and relation_type = $3',
    [organizationId, source, relationType]
  );
  for (let index = 0; index < targets.length; index += 1) {
    await client.query(
      `insert into product_relations (organization_id, source_product_id, target_product_id, relation_type, sort_order)
       values ($1,$2,$3,$4,$5)`,
      [organizationId, source, targets[index], relationType, index]
    );
  }
  return { source_product_id: source, relation_type: relationType, target_product_ids: targets };
}

// Admin: the current curated target ids for a source, grouped by relation type.
async function listRelations(client, { organizationId, sourceProductId }) {
  const result = await client.query(
    `select relation_type, target_product_id from product_relations
      where organization_id = $1 and source_product_id = $2
      order by relation_type, sort_order, id`,
    [organizationId, Number(sourceProductId)]
  );
  const grouped = { related: [], complementary: [], upsell: [] };
  for (const row of result.rows) grouped[row.relation_type].push(Number(row.target_product_id));
  return grouped;
}

// Storefront: the product cards to show for a source. Curated links win; otherwise a
// deterministic fallback. Draft/deleted targets never surface (card filter on status).
async function resolveRelated(client, { organizationId, productId, relationType = 'related', limit = DEFAULT_LIMIT }) {
  assertType(relationType);
  const source = Number(productId);
  const cap = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));

  const curated = await client.query(
    `select target_product_id from product_relations
      where organization_id = $1 and source_product_id = $2 and relation_type = $3
      order by sort_order, id limit $4`,
    [organizationId, source, relationType, cap]
  );
  let ids = curated.rows.map((row) => Number(row.target_product_id));
  let usedFallback = false;

  if (!ids.length) {
    usedFallback = true;
    const fallback = await client.query(
      `select distinct p.id
         from products p
         left join product_collections pc
           on pc.organization_id = p.organization_id and pc.product_id = p.id
        where p.organization_id = $1
          and p.id <> $2
          and p.status = 'active'
          and (
            p.category_id = (select category_id from products where organization_id = $1 and id = $2)
            or pc.collection_id in (select collection_id from product_collections where organization_id = $1 and product_id = $2)
          )
          and exists (
            select 1 from product_variants v
             where v.organization_id = p.organization_id and v.product_id = p.id
               and v.is_active and v.available > 0
          )
        order by p.id
        limit $3`,
      [organizationId, source, cap]
    );
    ids = fallback.rows.map((row) => Number(row.id));
  }

  if (!ids.length) return { relation_type: relationType, fallback: usedFallback, items: [] };

  const cards = await client.query(
    productSelect("p.organization_id = $1 and p.id = any($2::bigint[]) and p.status in ('active', 'out')"),
    [organizationId, ids]
  );
  const byId = new Map(cards.rows.map((row) => [Number(row.id), row]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  return { relation_type: relationType, fallback: usedFallback, items: ordered };
}

module.exports = { RELATION_TYPES, setRelations, listRelations, resolveRelated };
