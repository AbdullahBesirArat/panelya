const crypto = require('crypto');

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function promotionError(message, code = 'COUPON_INVALID', status = 400, details = null) {
  return Object.assign(new Error(message), { code, status, details });
}

function normalizeCouponCode(value) {
  const normalized = String(value || '').trim().toLocaleUpperCase('tr-TR');
  if (!normalized) return '';
  if (normalized.length < 3 || normalized.length > 64 || !/^[\p{L}\p{N}._-]+$/u.test(normalized)) {
    throw promotionError('Kupon kodu gecersiz veya kullanilamiyor');
  }
  return normalized;
}

function guestReferenceHash(organizationId, email) {
  const normalized = String(email || '').trim().toLocaleLowerCase('tr-TR');
  return normalized
    ? crypto.createHash('sha256').update(String(organizationId)).update('\0').update(normalized).digest('hex')
    : null;
}

function campaignDiscount(campaign, subtotal) {
  if (!campaign || subtotal <= 0) return 0;
  const type = String(campaign.type || '').trim().toLowerCase();
  const value = Number(campaign.value || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (['percentage', 'percent', 'yuzde', 'oran'].includes(type)) {
    return roundMoney(Math.min(subtotal, subtotal * Math.min(value, 100) / 100));
  }
  if (['fixed', 'amount', 'sabit', 'tl'].includes(type)) {
    return roundMoney(Math.min(subtotal, value));
  }
  return 0;
}

async function selectActiveCampaign(client, organizationId, subtotal) {
  const result = await client.query(
    `select id, name, type, value, end_date
       from campaigns
      where organization_id = $1
        and active = true
        and (end_date is null or end_date >= current_date)
      order by end_date nulls last, id desc
      limit 10`,
    [organizationId]
  );
  return result.rows.find((campaign) => campaignDiscount(campaign, subtotal) > 0) || null;
}

function lineSubtotal(item) {
  return roundMoney(Number(item.unit_price || 0) * Number(item.quantity || 1));
}

function allocateDiscount(items, amount, eligibleIndexes = null, source = 'promotion') {
  const indexes = eligibleIndexes || items.map((_, index) => index);
  const eligible = indexes.filter((index) => lineSubtotal(items[index]) > 0);
  const base = roundMoney(eligible.reduce((sum, index) => sum + lineSubtotal(items[index]), 0));
  let remaining = roundMoney(Math.min(Math.max(Number(amount || 0), 0), base));
  return eligible.map((index, position) => {
    const item = items[index];
    const subtotal = lineSubtotal(item);
    const discount = position === eligible.length - 1
      ? remaining
      : roundMoney(Math.min(remaining, amount * subtotal / base));
    remaining = roundMoney(remaining - discount);
    return {
      source,
      product_id: Number(item.product_id),
      variant_id: Number(item.variant_id || 0) || null,
      quantity: Number(item.quantity || 1),
      line_subtotal: subtotal,
      discount,
    };
  });
}

async function loadCoupon(client, organizationId, code, lockCoupon) {
  const result = await client.query(
    `select coupon.*, now() as database_now
       from coupons coupon
      where coupon.organization_id = $1 and coupon.normalized_code = $2
      limit 1${lockCoupon ? ' for update' : ''}`,
    [organizationId, code]
  );
  return result.rows[0] || null;
}

async function couponScope(client, organizationId, couponId, items) {
  const productIds = [...new Set(items.map((item) => Number(item.product_id)).filter(Boolean))];
  const [productRows, rules] = await Promise.all([
    client.query(
      `select product.id, product.category_id,
              coalesce(array_agg(link.collection_id) filter (where link.collection_id is not null), '{}') as collection_ids
         from products product
         left join product_collections link
           on link.organization_id = product.organization_id and link.product_id = product.id
        where product.organization_id = $1 and product.id = any($2::bigint[])
        group by product.id`,
      [organizationId, productIds]
    ),
    client.query(
      `select 'product' as scope_type, product_id as scope_id, excluded from coupon_products
        where organization_id = $1 and coupon_id = $2
       union all
       select 'category', category_id, excluded from coupon_categories
        where organization_id = $1 and coupon_id = $2
       union all
       select 'collection', collection_id, excluded from coupon_collections
        where organization_id = $1 and coupon_id = $2`,
      [organizationId, couponId]
    ),
  ]);
  const metadata = new Map(productRows.rows.map((row) => [Number(row.id), {
    categoryId: Number(row.category_id || 0) || null,
    collectionIds: new Set((row.collection_ids || []).map(Number)),
  }]));
  const includeRules = rules.rows.filter((rule) => !rule.excluded);
  const excludeRules = rules.rows.filter((rule) => rule.excluded);
  const matches = (rule, productId, meta) => (
    (rule.scope_type === 'product' && Number(rule.scope_id) === productId)
    || (rule.scope_type === 'category' && Number(rule.scope_id) === meta?.categoryId)
    || (rule.scope_type === 'collection' && meta?.collectionIds.has(Number(rule.scope_id)))
  );
  return items.map((item) => {
    const productId = Number(item.product_id);
    const meta = metadata.get(productId);
    const included = includeRules.length === 0 || includeRules.some((rule) => matches(rule, productId, meta));
    const excluded = excludeRules.some((rule) => matches(rule, productId, meta));
    return included && !excluded;
  });
}

async function assertCouponUsage(client, coupon, {
  organizationId,
  customerId = null,
  guestEmail = '',
} = {}) {
  const guestHash = customerId ? null : guestReferenceHash(organizationId, guestEmail);
  if (coupon.total_usage_limit) {
    const total = await client.query(
      `select count(*)::integer as count
         from coupon_redemptions
        where organization_id = $1 and coupon_id = $2 and status in ('reserved','redeemed')`,
      [organizationId, coupon.id]
    );
    if (Number(total.rows[0].count) >= Number(coupon.total_usage_limit)) {
      throw promotionError('Bu kupon kullanim limitine ulasti', 'COUPON_LIMIT_REACHED');
    }
  }
  if (coupon.per_customer_limit && (customerId || guestHash)) {
    const perCustomer = await client.query(
      `select count(*)::integer as count
         from coupon_redemptions
        where organization_id = $1 and coupon_id = $2 and status in ('reserved','redeemed')
          and (($3::bigint is not null and customer_id = $3)
            or ($3::bigint is null and guest_reference_hash = $4))`,
      [organizationId, coupon.id, customerId, guestHash]
    );
    if (Number(perCustomer.rows[0].count) >= Number(coupon.per_customer_limit)) {
      throw promotionError('Bu kupon hesabiniz icin kullanim limitine ulasti', 'COUPON_CUSTOMER_LIMIT_REACHED');
    }
  }
  if (coupon.first_order_only && customerId) {
    const orders = await client.query(
      `select count(*)::integer as count from orders
        where organization_id = $1 and customer_id = $2 and status <> 'cancelled'`,
      [organizationId, customerId]
    );
    if (Number(orders.rows[0].count) > 0) {
      throw promotionError('Bu kupon yalnizca ilk sipariste kullanilabilir', 'COUPON_FIRST_ORDER_ONLY');
    }
  }
  return guestHash;
}

function validateCouponWindow(coupon) {
  if (!coupon || coupon.status !== 'active') {
    throw promotionError('Kupon kodu gecersiz veya kullanilamiyor');
  }
  const now = new Date(coupon.database_now).getTime();
  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) {
    throw promotionError('Bu kupon henuz baslamadi', 'COUPON_NOT_STARTED');
  }
  if (coupon.ends_at && new Date(coupon.ends_at).getTime() <= now) {
    throw promotionError('Bu kuponun suresi doldu', 'COUPON_EXPIRED');
  }
}

function couponCandidate(coupon, eligibleSubtotal, shippingFee) {
  let productDiscount = 0;
  let shippingDiscount = 0;
  if (coupon.discount_type === 'percentage') {
    productDiscount = eligibleSubtotal * Number(coupon.value) / 100;
  } else if (coupon.discount_type === 'fixed') {
    productDiscount = Number(coupon.value);
  } else if (coupon.discount_type === 'free_shipping') {
    shippingDiscount = shippingFee;
  }
  if (coupon.maximum_discount != null) {
    if (coupon.discount_type === 'free_shipping') {
      shippingDiscount = Math.min(shippingDiscount, Number(coupon.maximum_discount));
    } else {
      productDiscount = Math.min(productDiscount, Number(coupon.maximum_discount));
    }
  }
  return {
    productDiscount: roundMoney(Math.min(eligibleSubtotal, Math.max(0, productDiscount))),
    shippingDiscount: roundMoney(Math.min(shippingFee, Math.max(0, shippingDiscount))),
  };
}

async function evaluatePromotions(client, items, {
  organizationId,
  shippingFee = 0,
  couponCode = '',
  customerId = null,
  guestEmail = '',
  lockCoupon = false,
  checkUsage = true,
} = {}) {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + lineSubtotal(item), 0));
  const shippingBeforeDiscount = roundMoney(Math.max(0, Number(shippingFee || 0)));
  const campaign = await selectActiveCampaign(client, organizationId, subtotal);
  let appliedCampaignDiscount = campaignDiscount(campaign, subtotal);
  let coupon = null;
  let couponProductDiscount = 0;
  let shippingDiscount = 0;
  let couponAllocations = [];
  const normalizedCode = normalizeCouponCode(couponCode);

  if (normalizedCode) {
    coupon = await loadCoupon(client, organizationId, normalizedCode, lockCoupon);
    validateCouponWindow(coupon);
    if (subtotal < Number(coupon.minimum_subtotal || 0)) {
      throw promotionError(
        `Bu kupon icin minimum sepet tutari ${roundMoney(coupon.minimum_subtotal)} TL`,
        'COUPON_MINIMUM_NOT_MET',
        400,
        { minimumSubtotal: Number(coupon.minimum_subtotal), subtotal }
      );
    }
    if (checkUsage) {
      await assertCouponUsage(client, coupon, { organizationId, customerId, guestEmail });
    }
    const eligibility = await couponScope(client, organizationId, coupon.id, items);
    const eligibleIndexes = eligibility.map((eligible, index) => eligible ? index : -1).filter((index) => index >= 0);
    const eligibleSubtotal = roundMoney(eligibleIndexes.reduce((sum, index) => sum + lineSubtotal(items[index]), 0));
    if (eligibleSubtotal <= 0 && coupon.discount_type !== 'free_shipping') {
      throw promotionError('Sepetinizde bu kupona uygun urun yok', 'COUPON_SCOPE_MISMATCH');
    }
    const candidate = couponCandidate(coupon, eligibleSubtotal, shippingBeforeDiscount);
    const couponBenefit = roundMoney(candidate.productDiscount + candidate.shippingDiscount);
    if (couponBenefit <= 0) {
      throw promotionError('Bu kupon sepetinize indirim uygulamiyor', 'COUPON_NO_DISCOUNT');
    }

    if (coupon.stacking_policy === 'exclusive') {
      appliedCampaignDiscount = 0;
      couponProductDiscount = candidate.productDiscount;
      shippingDiscount = candidate.shippingDiscount;
    } else if (coupon.stacking_policy === 'with_campaign') {
      couponProductDiscount = roundMoney(Math.min(candidate.productDiscount, subtotal - appliedCampaignDiscount));
      shippingDiscount = candidate.shippingDiscount;
    } else if (couponBenefit > appliedCampaignDiscount) {
      appliedCampaignDiscount = 0;
      couponProductDiscount = candidate.productDiscount;
      shippingDiscount = candidate.shippingDiscount;
    } else {
      coupon = { ...coupon, applied: false, not_applied_reason: 'Mevcut kampanya daha avantajli' };
    }
    if (coupon && coupon.applied !== false) {
      coupon.applied = true;
      couponAllocations = allocateDiscount(items, couponProductDiscount, eligibleIndexes, 'coupon');
    }
  }

  const campaignAllocations = allocateDiscount(items, appliedCampaignDiscount, null, 'campaign');
  const productDiscount = roundMoney(Math.min(subtotal, appliedCampaignDiscount + couponProductDiscount));
  const discountedSubtotal = roundMoney(subtotal - productDiscount);
  const finalShippingFee = roundMoney(shippingBeforeDiscount - shippingDiscount);
  const total = roundMoney(discountedSubtotal + finalShippingFee);
  const discount = roundMoney(productDiscount + shippingDiscount);
  const couponView = coupon ? {
    id: coupon.id,
    code: coupon.code,
    normalizedCode: coupon.normalized_code,
    name: coupon.name,
    discountType: coupon.discount_type,
    value: Number(coupon.value),
    stackingPolicy: coupon.stacking_policy,
    applied: coupon.applied !== false,
    notAppliedReason: coupon.not_applied_reason || null,
    productDiscount: coupon.applied === false ? 0 : couponProductDiscount,
    shippingDiscount: coupon.applied === false ? 0 : shippingDiscount,
  } : null;
  const breakdown = [
    ...(campaign && appliedCampaignDiscount > 0 ? [{
      source: 'campaign', id: campaign.id, label: campaign.name, amount: appliedCampaignDiscount,
    }] : []),
    ...(couponView?.applied ? [{
      source: 'coupon', id: couponView.id, code: couponView.code, label: couponView.name,
      amount: roundMoney(couponProductDiscount + shippingDiscount),
    }] : []),
  ];

  return {
    subtotal,
    discount,
    productDiscount,
    campaignDiscount: appliedCampaignDiscount,
    couponDiscount: couponView?.applied ? couponProductDiscount : 0,
    shippingDiscount: couponView?.applied ? shippingDiscount : 0,
    discountedSubtotal,
    shippingFee: finalShippingFee,
    shippingFeeBeforeDiscount: shippingBeforeDiscount,
    total,
    campaign: campaign && appliedCampaignDiscount > 0 ? {
      id: campaign.id, name: campaign.name, type: campaign.type, value: campaign.value,
    } : null,
    coupon: couponView,
    breakdown,
    allocations: [...campaignAllocations, ...couponAllocations],
  };
}

async function reserveCouponRedemption(client, {
  organizationId,
  orderId,
  customerId = null,
  guestEmail = '',
  pricing,
  status = 'reserved',
  idempotencyKey = null,
} = {}) {
  if (!pricing?.coupon?.applied) return null;
  const result = await client.query(
    `insert into coupon_redemptions
       (organization_id, coupon_id, customer_id, guest_reference_hash, order_id,
        discount_amount, allocation_snapshot, status, idempotency_key, redeemed_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,case when $8 = 'redeemed' then now() end)
     on conflict (organization_id, coupon_id, order_id) do nothing
     returning *`,
    [
      organizationId,
      pricing.coupon.id,
      customerId,
      customerId ? null : guestReferenceHash(organizationId, guestEmail),
      orderId,
      roundMoney(pricing.coupon.productDiscount + pricing.coupon.shippingDiscount),
      JSON.stringify(pricing.allocations || []),
      status,
      String(idempotencyKey || '').trim() || null,
    ]
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await client.query(
    `select * from coupon_redemptions
      where organization_id = $1 and coupon_id = $2 and order_id = $3 limit 1`,
    [organizationId, pricing.coupon.id, orderId]
  );
  return existing.rows[0] || null;
}

async function transitionOrderPromotion(client, orderId, previousStatus, nextStatus, { organizationId } = {}) {
  if (previousStatus === nextStatus) return { changed: false };
  const result = await client.query(
    `select * from coupon_redemptions
      where organization_id = $1 and order_id = $2 limit 1 for update`,
    [organizationId, orderId]
  );
  const redemption = result.rows[0];
  if (!redemption) return { changed: false };
  if (previousStatus === 'cancelled' && nextStatus !== 'cancelled' && redemption.status === 'released') {
    const couponResult = await client.query(
      'select *, now() as database_now from coupons where organization_id = $1 and id = $2 for update',
      [organizationId, redemption.coupon_id]
    );
    const coupon = couponResult.rows[0];
    validateCouponWindow(coupon);
    const usage = await client.query(
      `select
         count(*) filter (where status in ('reserved','redeemed'))::integer as total_count,
         count(*) filter (where status in ('reserved','redeemed') and
           (($3::bigint is not null and customer_id = $3)
             or ($3::bigint is null and guest_reference_hash = $4)))::integer as customer_count
       from coupon_redemptions
       where organization_id = $1 and coupon_id = $2 and id <> $5`,
      [organizationId, redemption.coupon_id, redemption.customer_id, redemption.guest_reference_hash, redemption.id]
    );
    if (coupon.total_usage_limit && Number(usage.rows[0].total_count) >= Number(coupon.total_usage_limit)) {
      throw promotionError('Siparis kuponunun kullanim limiti doldu', 'COUPON_LIMIT_REACHED');
    }
    if (coupon.per_customer_limit && Number(usage.rows[0].customer_count) >= Number(coupon.per_customer_limit)) {
      throw promotionError('Siparis kuponunun musteri limiti doldu', 'COUPON_CUSTOMER_LIMIT_REACHED');
    }
    const targetStatus = nextStatus === 'payment_pending' ? 'reserved' : 'redeemed';
    const updated = await client.query(
      `update coupon_redemptions
          set status = $3, redeemed_at = case when $3 = 'redeemed' then now() else null end,
              released_at = null, released_reason = null, updated_at = now()
        where organization_id = $1 and id = $2 and status = 'released' returning *`,
      [organizationId, redemption.id, targetStatus]
    );
    return { changed: true, redemption: updated.rows[0] };
  }
  if (nextStatus === 'cancelled' && redemption.status !== 'released') {
    const updated = await client.query(
      `update coupon_redemptions
          set status = 'released', released_at = now(), released_reason = 'order_cancelled', updated_at = now()
        where organization_id = $1 and id = $2 and status <> 'released' returning *`,
      [organizationId, redemption.id]
    );
    return { changed: true, redemption: updated.rows[0] };
  }
  if (['paid', 'processing', 'new'].includes(nextStatus) && redemption.status === 'reserved') {
    const updated = await client.query(
      `update coupon_redemptions
          set status = 'redeemed', redeemed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = 'reserved' returning *`,
      [organizationId, redemption.id]
    );
    return { changed: true, redemption: updated.rows[0] };
  }
  return { changed: false, redemption };
}

function promotionOrderColumns(pricing) {
  return {
    subtotal: pricing.subtotal,
    discountTotal: pricing.discount,
    campaignDiscount: pricing.campaignDiscount,
    couponDiscount: pricing.couponDiscount,
    shippingDiscount: pricing.shippingDiscount,
    couponCode: pricing.coupon?.applied ? pricing.coupon.normalizedCode : null,
    snapshot: {
      version: 1,
      currency: 'TRY',
      subtotal: pricing.subtotal,
      shippingFeeBeforeDiscount: pricing.shippingFeeBeforeDiscount,
      shippingFee: pricing.shippingFee,
      total: pricing.total,
      breakdown: pricing.breakdown,
      allocations: pricing.allocations,
    },
  };
}

module.exports = {
  allocateDiscount,
  campaignDiscount,
  evaluatePromotions,
  guestReferenceHash,
  normalizeCouponCode,
  promotionError,
  promotionOrderColumns,
  reserveCouponRedemption,
  roundMoney,
  selectActiveCampaign,
  transitionOrderPromotion,
};
