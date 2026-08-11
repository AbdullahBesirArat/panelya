const { normalizeCouponCode } = require('./promotionEngine');

const DISCOUNT_TYPES = new Set(['percentage', 'fixed', 'free_shipping']);
const STACKING_POLICIES = new Set(['exclusive', 'with_campaign', 'best_discount']);

function nullablePositiveInteger(value, field) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw Object.assign(new Error(`${field} pozitif tam sayi olmali`), { status: 400 });
  }
  return number;
}

function nullableMoney(value, field) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw Object.assign(new Error(`${field} gecersiz`), { status: 400 });
  }
  return Math.round(number * 100) / 100;
}

function safeIds(values) {
  return [...new Set((values || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function couponPayload(body = {}) {
  const discountType = String(body.discountType || body.discount_type || '').trim().toLowerCase();
  const stackingPolicy = String(body.stackingPolicy || body.stacking_policy || 'best_discount').trim().toLowerCase();
  const value = Number(body.value || 0);
  if (!DISCOUNT_TYPES.has(discountType)) {
    throw Object.assign(new Error('Indirim tipi gecersiz'), { status: 400 });
  }
  if (!STACKING_POLICIES.has(stackingPolicy)) {
    throw Object.assign(new Error('Kampanya birlestirme kurali gecersiz'), { status: 400 });
  }
  if (!Number.isFinite(value)
    || (discountType !== 'free_shipping' && value <= 0)
    || (discountType === 'percentage' && value > 100)) {
    throw Object.assign(new Error('Kupon indirim degeri gecersiz'), { status: 400 });
  }
  const code = normalizeCouponCode(body.code);
  if (!code) throw Object.assign(new Error('Kupon kodu zorunlu'), { status: 400 });
  const startsAt = body.startsAt || body.starts_at || null;
  const endsAt = body.endsAt || body.ends_at || null;
  if (startsAt && Number.isNaN(Date.parse(startsAt))) throw Object.assign(new Error('Baslangic tarihi gecersiz'), { status: 400 });
  if (endsAt && Number.isNaN(Date.parse(endsAt))) throw Object.assign(new Error('Bitis tarihi gecersiz'), { status: 400 });
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw Object.assign(new Error('Bitis tarihi baslangictan sonra olmali'), { status: 400 });
  }
  return {
    code,
    name: String(body.name || '').trim().slice(0, 160),
    internalDescription: String(body.internalDescription || body.internal_description || '').trim().slice(0, 2000),
    discountType,
    value: Math.round(value * 100) / 100,
    minimumSubtotal: nullableMoney(body.minimumSubtotal ?? body.minimum_subtotal ?? 0, 'Minimum sepet') || 0,
    maximumDiscount: nullableMoney(body.maximumDiscount ?? body.maximum_discount, 'Maksimum indirim'),
    startsAt: startsAt ? new Date(startsAt).toISOString() : null,
    endsAt: endsAt ? new Date(endsAt).toISOString() : null,
    totalUsageLimit: nullablePositiveInteger(body.totalUsageLimit ?? body.total_usage_limit, 'Toplam limit'),
    perCustomerLimit: nullablePositiveInteger(body.perCustomerLimit ?? body.per_customer_limit, 'Musteri limiti'),
    firstOrderOnly: body.firstOrderOnly === true || body.first_order_only === true,
    status: String(body.status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active',
    stackingPolicy,
    priority: Math.min(Math.max(Number(body.priority) || 0, -10000), 10000),
    includeProductIds: safeIds(body.includeProductIds || body.include_product_ids),
    excludeProductIds: safeIds(body.excludeProductIds || body.exclude_product_ids),
    includeCategoryIds: safeIds(body.includeCategoryIds || body.include_category_ids),
    excludeCategoryIds: safeIds(body.excludeCategoryIds || body.exclude_category_ids),
    includeCollectionIds: safeIds(body.includeCollectionIds || body.include_collection_ids),
    excludeCollectionIds: safeIds(body.excludeCollectionIds || body.exclude_collection_ids),
  };
}

async function replaceScopeTable(client, { table, entityColumn, organizationId, couponId, includeIds, excludeIds }) {
  await client.query(`delete from ${table} where organization_id = $1 and coupon_id = $2`, [organizationId, couponId]);
  const entries = [
    ...includeIds.map((id) => ({ id, excluded: false })),
    ...excludeIds.filter((id) => !includeIds.includes(id)).map((id) => ({ id, excluded: true })),
  ];
  if (!entries.length) return;
  const parentTable = entityColumn === 'product_id' ? 'products'
    : entityColumn === 'category_id' ? 'categories'
      : 'collections';
  const inserted = await client.query(
    `insert into ${table} (organization_id, coupon_id, ${entityColumn}, excluded)
     select $1, $2, entity.id, requested.excluded
       from jsonb_to_recordset($3::jsonb) requested(id bigint, excluded boolean)
       join ${parentTable} entity on entity.id = requested.id and entity.organization_id = $1
     returning ${entityColumn}`,
    [organizationId, couponId, JSON.stringify(entries)]
  );
  if (inserted.rowCount !== entries.length) {
    throw Object.assign(new Error('Kupon kapsaminda gecersiz kayit var'), { status: 400 });
  }
}

async function replaceCouponScopes(client, organizationId, couponId, payload) {
  await replaceScopeTable(client, {
    table: 'coupon_products', entityColumn: 'product_id', organizationId, couponId,
    includeIds: payload.includeProductIds, excludeIds: payload.excludeProductIds,
  });
  await replaceScopeTable(client, {
    table: 'coupon_categories', entityColumn: 'category_id', organizationId, couponId,
    includeIds: payload.includeCategoryIds, excludeIds: payload.excludeCategoryIds,
  });
  await replaceScopeTable(client, {
    table: 'coupon_collections', entityColumn: 'collection_id', organizationId, couponId,
    includeIds: payload.includeCollectionIds, excludeIds: payload.excludeCollectionIds,
  });
}

const COUPON_VIEW_SQL = `select coupon.*,
  (select count(*)::integer from coupon_redemptions redemption
    where redemption.organization_id = coupon.organization_id and redemption.coupon_id = coupon.id
      and redemption.status = 'redeemed') as redeemed_count,
  (select count(*)::integer from coupon_redemptions redemption
    where redemption.organization_id = coupon.organization_id and redemption.coupon_id = coupon.id
      and redemption.status = 'reserved') as reserved_count,
  coalesce((select json_agg(product_id order by product_id) from coupon_products
    where organization_id = coupon.organization_id and coupon_id = coupon.id and not excluded), '[]') as include_product_ids,
  coalesce((select json_agg(product_id order by product_id) from coupon_products
    where organization_id = coupon.organization_id and coupon_id = coupon.id and excluded), '[]') as exclude_product_ids,
  coalesce((select json_agg(category_id order by category_id) from coupon_categories
    where organization_id = coupon.organization_id and coupon_id = coupon.id and not excluded), '[]') as include_category_ids,
  coalesce((select json_agg(category_id order by category_id) from coupon_categories
    where organization_id = coupon.organization_id and coupon_id = coupon.id and excluded), '[]') as exclude_category_ids,
  coalesce((select json_agg(collection_id order by collection_id) from coupon_collections
    where organization_id = coupon.organization_id and coupon_id = coupon.id and not excluded), '[]') as include_collection_ids,
  coalesce((select json_agg(collection_id order by collection_id) from coupon_collections
    where organization_id = coupon.organization_id and coupon_id = coupon.id and excluded), '[]') as exclude_collection_ids
from coupons coupon`;

async function listCoupons(client, organizationId) {
  const result = await client.query(
    `${COUPON_VIEW_SQL} where coupon.organization_id = $1 order by coupon.created_at desc, coupon.id desc`,
    [organizationId]
  );
  return result.rows;
}

async function getCoupon(client, organizationId, couponId) {
  const result = await client.query(
    `${COUPON_VIEW_SQL} where coupon.organization_id = $1 and coupon.id = $2 limit 1`,
    [organizationId, couponId]
  );
  return result.rows[0] || null;
}

async function createCoupon(client, organizationId, payload, createdBy = null) {
  const result = await client.query(
    `insert into coupons
       (organization_id, code, name, internal_description, discount_type, value,
        minimum_subtotal, maximum_discount, starts_at, ends_at, total_usage_limit,
        per_customer_limit, first_order_only, status, stacking_policy, priority, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [
      organizationId, payload.code, payload.name, payload.internalDescription,
      payload.discountType, payload.value, payload.minimumSubtotal, payload.maximumDiscount,
      payload.startsAt, payload.endsAt, payload.totalUsageLimit, payload.perCustomerLimit,
      payload.firstOrderOnly, payload.status, payload.stackingPolicy, payload.priority, createdBy,
    ]
  );
  await replaceCouponScopes(client, organizationId, result.rows[0].id, payload);
  return getCoupon(client, organizationId, result.rows[0].id);
}

async function updateCoupon(client, organizationId, couponId, payload) {
  const result = await client.query(
    `update coupons set code=$1, name=$2, internal_description=$3, discount_type=$4,
       value=$5, minimum_subtotal=$6, maximum_discount=$7, starts_at=$8, ends_at=$9,
       total_usage_limit=$10, per_customer_limit=$11, first_order_only=$12, status=$13,
       stacking_policy=$14, priority=$15, updated_at=now()
     where organization_id=$16 and id=$17 returning id`,
    [
      payload.code, payload.name, payload.internalDescription, payload.discountType,
      payload.value, payload.minimumSubtotal, payload.maximumDiscount, payload.startsAt,
      payload.endsAt, payload.totalUsageLimit, payload.perCustomerLimit, payload.firstOrderOnly,
      payload.status, payload.stackingPolicy, payload.priority, organizationId, couponId,
    ]
  );
  if (!result.rows[0]) return null;
  await replaceCouponScopes(client, organizationId, couponId, payload);
  return getCoupon(client, organizationId, couponId);
}

module.exports = {
  couponPayload,
  createCoupon,
  getCoupon,
  listCoupons,
  replaceCouponScopes,
  safeIds,
  updateCoupon,
};

