'use strict';

// A24.1 server-canonical recently-viewed history for signed-in customers. Only the
// product id + timestamp are stored (no profiling). A re-view updates the timestamp;
// the list is capped and TTL-filtered, and passive products never surface.
const { productCardsByIds } = require('./cards');

const MAX_RECENTLY_VIEWED = 24;
const TTL_DAYS = 90;
const DEFAULT_LIST_LIMIT = 12;

function rvError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Keep only the most recent MAX rows for a customer.
async function prune(client, { organizationId, customerAccountId }) {
  await client.query(
    `delete from customer_recently_viewed r
      where r.organization_id = $1 and r.customer_account_id = $2
        and r.id not in (
          select id from customer_recently_viewed
           where organization_id = $1 and customer_account_id = $2
           order by viewed_at desc, id desc
           limit $3
        )`,
    [organizationId, customerAccountId, MAX_RECENTLY_VIEWED]
  );
}

// Upsert one view (re-view refreshes the timestamp), then prune to the cap.
async function recordView(client, { organizationId, customerAccountId, productId, viewedAt = null }) {
  const product = Number(productId);
  if (!Number.isInteger(product) || product < 1) throw rvError('Gecerli urun kimligi zorunlu', 'INVALID_PRODUCT_ID', 400);
  const exists = await client.query('select 1 from products where organization_id = $1 and id = $2', [organizationId, product]);
  if (!exists.rows[0]) throw rvError('Urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);
  await client.query(
    `insert into customer_recently_viewed (organization_id, customer_account_id, product_id, viewed_at)
     values ($1,$2,$3, least(coalesce($4::timestamptz, now()), now()))
     on conflict (organization_id, customer_account_id, product_id)
       do update set viewed_at = greatest(customer_recently_viewed.viewed_at, excluded.viewed_at)`,
    [organizationId, customerAccountId, product, viewedAt]
  );
  await prune(client, { organizationId, customerAccountId });
  return { recorded: true };
}

// The customer's history as product cards: TTL-filtered, passive hidden, current excluded.
async function listRecentlyViewed(client, { organizationId, customerAccountId, excludeProductId = null, limit = DEFAULT_LIST_LIMIT }) {
  const cap = Math.max(1, Math.min(Number(limit) || DEFAULT_LIST_LIMIT, MAX_RECENTLY_VIEWED));
  const exclude = excludeProductId != null && Number.isInteger(Number(excludeProductId)) ? Number(excludeProductId) : null;
  const rows = await client.query(
    `select product_id from customer_recently_viewed
      where organization_id = $1 and customer_account_id = $2
        and viewed_at > now() - make_interval(days => $3)
        and ($4::bigint is null or product_id <> $4)
      order by viewed_at desc, id desc
      limit $5`,
    [organizationId, customerAccountId, TTL_DAYS, exclude, cap]
  );
  const ids = rows.rows.map((row) => Number(row.product_id));
  const items = await productCardsByIds(client, organizationId, ids, { limit: cap });
  return { items };
}

// Merge a guest's client history (ordered [{product_id, viewed_at}]) into the account
// on login. Only products that still exist in this tenant are kept.
async function mergeGuestHistory(client, { organizationId, customerAccountId, items = [] }) {
  const valid = (Array.isArray(items) ? items : [])
    .map((item) => ({ productId: Number(item.product_id ?? item.id), viewedAt: item.viewed_at || null }))
    .filter((item) => Number.isInteger(item.productId) && item.productId > 0)
    .slice(0, MAX_RECENTLY_VIEWED);
  if (!valid.length) return { merged: 0 };
  const found = await client.query(
    'select id from products where organization_id = $1 and id = any($2::bigint[])',
    [organizationId, valid.map((item) => item.productId)]
  );
  const allowed = new Set(found.rows.map((row) => Number(row.id)));
  let merged = 0;
  for (const item of valid) {
    if (!allowed.has(item.productId)) continue;
    await client.query(
      `insert into customer_recently_viewed (organization_id, customer_account_id, product_id, viewed_at)
       values ($1,$2,$3, least(coalesce($4::timestamptz, now()), now()))
       on conflict (organization_id, customer_account_id, product_id)
         do update set viewed_at = greatest(customer_recently_viewed.viewed_at, excluded.viewed_at)`,
      [organizationId, customerAccountId, item.productId, item.viewedAt]
    );
    merged += 1;
  }
  await prune(client, { organizationId, customerAccountId });
  return { merged };
}

async function clearHistory(client, { organizationId, customerAccountId }) {
  await client.query(
    'delete from customer_recently_viewed where organization_id = $1 and customer_account_id = $2',
    [organizationId, customerAccountId]
  );
  return { cleared: true };
}

module.exports = {
  MAX_RECENTLY_VIEWED, TTL_DAYS,
  recordView, listRecentlyViewed, mergeGuestHistory, clearHistory,
};
