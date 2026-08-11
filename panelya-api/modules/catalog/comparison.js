'use strict';

// A24.4 product comparison list for signed-in customers. Capped, deduped, tenant-scoped;
// only same-tenant existing products are accepted and passive products are hidden at read.
const { productCardsByIds } = require('./cards');

const MAX_COMPARE = 4;

function cmpError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

async function currentIds(client, organizationId, customerAccountId) {
  const result = await client.query(
    'select product_id from customer_comparisons where organization_id = $1 and customer_account_id = $2 order by added_at, id',
    [organizationId, customerAccountId]
  );
  return result.rows.map((row) => Number(row.product_id));
}

async function addToComparison(client, { organizationId, customerAccountId, productId }) {
  const product = Number(productId);
  if (!Number.isInteger(product) || product < 1) throw cmpError('Gecerli urun kimligi zorunlu', 'INVALID_PRODUCT_ID', 400);
  const exists = await client.query('select 1 from products where organization_id = $1 and id = $2', [organizationId, product]);
  if (!exists.rows[0]) throw cmpError('Urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);

  const already = await client.query(
    'select 1 from customer_comparisons where organization_id = $1 and customer_account_id = $2 and product_id = $3',
    [organizationId, customerAccountId, product]
  );
  if (already.rows[0]) return listComparison(client, { organizationId, customerAccountId });

  const ids = await currentIds(client, organizationId, customerAccountId);
  if (ids.length >= MAX_COMPARE) throw cmpError(`En fazla ${MAX_COMPARE} ürün karşılaştırılabilir`, 'COMPARE_LIMIT_REACHED', 409);

  await client.query(
    `insert into customer_comparisons (organization_id, customer_account_id, product_id) values ($1,$2,$3)
     on conflict (organization_id, customer_account_id, product_id) do nothing`,
    [organizationId, customerAccountId, product]
  );
  return listComparison(client, { organizationId, customerAccountId });
}

async function removeFromComparison(client, { organizationId, customerAccountId, productId }) {
  await client.query(
    'delete from customer_comparisons where organization_id = $1 and customer_account_id = $2 and product_id = $3',
    [organizationId, customerAccountId, Number(productId)]
  );
  return listComparison(client, { organizationId, customerAccountId });
}

async function clearComparison(client, { organizationId, customerAccountId }) {
  await client.query('delete from customer_comparisons where organization_id = $1 and customer_account_id = $2', [organizationId, customerAccountId]);
  return { items: [] };
}

async function listComparison(client, { organizationId, customerAccountId }) {
  const ids = await currentIds(client, organizationId, customerAccountId);
  const items = await productCardsByIds(client, organizationId, ids, { limit: MAX_COMPARE });
  return { items };
}

// Merge a guest's comparison ids (from URL/localStorage) on login, capped at MAX.
async function mergeGuestComparison(client, { organizationId, customerAccountId, productIds = [] }) {
  const clean = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!clean.length) return listComparison(client, { organizationId, customerAccountId });
  const found = await client.query('select id from products where organization_id = $1 and id = any($2::bigint[])', [organizationId, clean]);
  const allowed = new Set(found.rows.map((row) => Number(row.id)));
  let existing = await currentIds(client, organizationId, customerAccountId);
  for (const id of clean) {
    if (existing.length >= MAX_COMPARE) break;
    if (!allowed.has(id) || existing.includes(id)) continue;
    await client.query(
      `insert into customer_comparisons (organization_id, customer_account_id, product_id) values ($1,$2,$3)
       on conflict (organization_id, customer_account_id, product_id) do nothing`,
      [organizationId, customerAccountId, id]
    );
    existing.push(id);
  }
  return listComparison(client, { organizationId, customerAccountId });
}

module.exports = {
  MAX_COMPARE, addToComparison, removeFromComparison, clearComparison, listComparison, mergeGuestComparison,
};
