const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const {
  consumeReservation,
  createInventoryReservation,
} = require('../services/inventoryReservations');
const { checkoutIdempotencyKey, findCheckoutReplay } = require('../services/checkoutIdempotency');
const { expirePendingOrders } = require('../services/pendingOrders');
const { calculateCartPricing, cartTotal, priceCartItems } = require('../services/cartPricing');
const { auditLog } = require('../services/audit');
const { sanitizeCustomer } = require('../services/validation');
const { resolveOrganization } = require('../services/tenant');
const { nextOrderCode } = require('../services/orderCodes');
const { insertOrderItems } = require('../services/orderItems');
const { normalizeCheckoutOptions } = require('../services/checkoutPayload');
const { paymentInstructionsFromSettings } = require('../services/storeSettings');
const {
  promotionOrderColumns,
  reserveCouponRedemption,
} = require('../services/promotionEngine');
const { prepareCartConversion, markCartConverted } = require('../modules/cart/service');
const { orderGiftSnapshot, resolveCheckoutGift, roundFee } = require('../modules/cart/giftWrap');

const CHECKOUT_CART_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const { assertPlanCapacity } = require('../services/planLimits');
const { upsertCustomer } = require('../services/customers');
const { sendNewOrderSellerNotification } = require('../services/email');
const { logger } = require('../services/logger');
const {
  FULFILLMENT_TRANSITIONS,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  appendOrderEvent,
  assertTransition,
  assignOrder,
  createOrderNote,
  createOrderTag,
  deleteOrderNote,
  deliverPendingOrderNotifications,
  loadOrderOperations,
  packingListSnapshot,
  replaceOrderTags,
  transitionLegacyOrderStatus,
  transitionOrderOperation,
  updateOrderNote,
  validTransitionsForOrder,
} = require('../services/orderOperations');
const { lookupOrder } = require('../modules/orders/controller');
const { orderDetailView } = require('../modules/orders/presenter');
const { operationActor, shouldKeepManualReservation } = require('../modules/orders/policy');
const { beginOrderTransaction } = require('../modules/orders/transaction');
const { ORDER_STATUSES, safePaging } = require('../modules/orders/validation');
const { quoteCheckoutShipping } = require('../modules/shipping/pricing');
const { providers: shippingProviders } = require('../modules/shipping/providers');
const { buildInvoiceProfileSnapshot } = require('../modules/invoicing/profiles');
const { calculateCheckoutTax } = require('../modules/invoicing/taxEngine');

const router = express.Router();
const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ORDER_CREATE_RATE_LIMIT || 60),
  message: 'Cok fazla siparis denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function kickOrderNotificationOutbox() {
  setImmediate(() => {
    deliverPendingOrderNotifications().catch((error) => {
      logger.warn({ err: error.message }, 'Siparis bildirim outbox islenemedi');
    });
  });
}

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: Siparis listesi
 *     tags: [Orders]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [new, payment_pending, processing, shipped, delivered, cancelled, paid]
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Siparis dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Order'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     summary: Public siparis olusturur
 *     tags: [Orders]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customer, items]
 *             properties:
 *               organizationSlug:
 *                 type: string
 *                 example: panelya
 *               customer:
 *                 type: object
 *                 required: [name, email, phone]
 *                 properties:
 *                   name: { type: string, example: Northstar Labs }
 *                   email: { type: string, format: email, example: ops@northstarlabs.co }
 *                   phone: { type: string, example: '+90 212 555 0101' }
 *                   address: { type: string, example: Maslak, Istanbul }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity]
 *                   properties:
 *                     product_id: { type: integer, example: 1 }
 *                     quantity: { type: integer, example: 1 }
 *     responses:
 *       201:
 *         description: Siparis olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 */
router.get('/', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const {
      status,
      orderStatus,
      paymentStatus,
      fulfillmentStatus,
      assignedTo,
      tagId,
      q = '',
      limit = 100,
      offset = 0,
    } = req.query;
    const paging = safePaging(limit, offset);
    const params = [organization.id, `%${String(q).slice(0, 120)}%`];
    const filters = ['o.organization_id = $1', '(o.order_code ilike $2 or c.name ilike $2 or c.email ilike $2)'];

    if (status) {
      if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Durum gecersiz' });
      params.push(status);
      filters.push(`o.status = $${params.length}`);
    }
    if (orderStatus) {
      if (!Object.hasOwn(ORDER_TRANSITIONS, orderStatus)) return res.status(400).json({ error: 'Siparis durumu gecersiz' });
      params.push(orderStatus);
      filters.push(`o.order_status = $${params.length}`);
    }
    if (paymentStatus) {
      if (!Object.hasOwn(PAYMENT_TRANSITIONS, paymentStatus)) return res.status(400).json({ error: 'Odeme durumu gecersiz' });
      params.push(paymentStatus);
      filters.push(`o.payment_status = $${params.length}`);
    }
    if (fulfillmentStatus) {
      if (!Object.hasOwn(FULFILLMENT_TRANSITIONS, fulfillmentStatus)) return res.status(400).json({ error: 'Fulfillment durumu gecersiz' });
      params.push(fulfillmentStatus);
      filters.push(`o.fulfillment_status = $${params.length}`);
    }
    if (assignedTo) {
      if (!/^[0-9a-f-]{36}$/i.test(String(assignedTo))) return res.status(400).json({ error: 'Atanan kullanici gecersiz' });
      params.push(assignedTo);
      filters.push(`exists (
        select 1 from order_assignments oa
         where oa.organization_id = o.organization_id and oa.order_id = o.id
           and oa.assigned_user_id = $${params.length}::uuid and oa.active
      )`);
    }
    if (tagId) {
      if (!/^\d+$/.test(String(tagId))) return res.status(400).json({ error: 'Etiket gecersiz' });
      params.push(tagId);
      filters.push(`exists (
        select 1 from order_tag_links otl
         where otl.organization_id = o.organization_id and otl.order_id = o.id
           and otl.tag_id = $${params.length}::bigint
      )`);
    }

    params.push(paging.limit, paging.offset);

    const result = await db.query(
      `select o.*, c.name as customer, c.email, c.phone, c.address,
        coalesce((
          select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) order by t.name)
            from order_tag_links l join order_tags t on t.id = l.tag_id and t.organization_id = l.organization_id
           where l.organization_id = o.organization_id and l.order_id = o.id
        ), '[]'::json) as tags,
        (
          select json_build_object('id', a.id, 'userId', a.assigned_user_id, 'name', u.name, 'email', u.email)
            from order_assignments a join app_users u on u.id = a.assigned_user_id
           where a.organization_id = o.organization_id and a.order_id = o.id and a.active
           limit 1
        ) as assignment,
        coalesce(
          string_agg(
            oi.product_name ||
            case when oi.selected_color <> '' or oi.selected_size <> ''
              then ' (' || concat_ws(' / ', nullif(oi.selected_color, ''), nullif(oi.selected_size, '')) || ')'
              else ''
            end ||
            ' x' || oi.quantity,
            ', ' order by oi.id
          ),
          'Siparis kalemi yok'
        ) as items
       from orders o
       left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
       left join order_items oi on oi.order_id = o.id
       where ${filters.join(' and ')}
       group by o.id, c.id
       order by o.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/expire-pending', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const olderThanMinutes = Math.min(
      Math.max(Number(req.body.olderThanMinutes || process.env.PAYMENT_PENDING_TIMEOUT_MINUTES || 30), 5),
      1440
    );
    const limit = Math.min(Math.max(Number(req.body.limit || process.env.PAYMENT_PENDING_EXPIRE_LIMIT || 100), 1), 500);
    const expired = await expirePendingOrders({ olderThanMinutes, limit });
    await auditLog(req, {
      action: 'EXPIRE_PENDING',
      resourceType: 'order',
      newValue: { olderThanMinutes, expiredCount: expired.length },
    });
    res.json({ ok: true, expiredCount: expired.length, expired });
  } catch (err) {
    next(err);
  }
});

router.get('/operations/metadata', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const [tags, members] = await Promise.all([
      db.query('select * from order_tags where organization_id = $1 order by name', [organization.id]),
      db.query(
        `select u.id, u.name, u.email, m.role
           from memberships m join app_users u on u.id = m.user_id
          where m.organization_id = $1 and m.status = 'active'
          order by u.name, u.email`,
        [organization.id]
      ),
    ]);
    res.json({ tags: tags.rows, members: members.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/operations/tags', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const tag = await createOrderTag(transaction.client, {
      organizationId: transaction.organization.id,
      tag: req.body,
      actor: operationActor(req, 'order_tag_api'),
    });
    await auditLog(req, {
      action: 'CREATE_TAG', resourceType: 'order_tag', resourceId: tag.id,
      newValue: { name: tag.name, color: tag.color }, organizationId: transaction.organization.id,
      store: transaction.client,
    });
    await transaction.client.query('commit');
    res.status(201).json(tag);
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

router.post('/bulk-status/preview', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const domain = String(req.body.domain || 'order');
    const toStatus = String(req.body.status || '');
    if (!['order', 'payment', 'fulfillment'].includes(domain)) return res.status(400).json({ error: 'Durum alani gecersiz' });
    const ids = [...new Set((req.body.orderIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: 'En az bir siparis secin' });
    const result = await db.query(
      `select id, order_code, order_status, payment_status, fulfillment_status, version
         from orders where organization_id = $1 and id = any($2::bigint[])`,
      [organization.id, ids]
    );
    const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
    const preview = ids.map((id) => {
      const row = byId.get(id);
      if (!row) return { id, valid: false, code: 'ORDER_NOT_FOUND', error: 'Siparis bulunamadi' };
      const fromStatus = row[`${domain}_status`];
      try {
        assertTransition(domain, fromStatus, toStatus);
        return { id, orderCode: row.order_code, version: row.version, fromStatus, toStatus, valid: true };
      } catch (error) {
        return { id, orderCode: row.order_code, version: row.version, fromStatus, toStatus, valid: false, code: error.code, error: error.message };
      }
    });
    res.json({ domain, status: toStatus, total: preview.length, validCount: preview.filter((row) => row.valid).length, results: preview });
  } catch (error) {
    next(error);
  }
});

router.post('/bulk-status', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const domain = String(req.body.domain || 'order');
    const toStatus = String(req.body.status || '');
    if (!['order', 'payment', 'fulfillment'].includes(domain)) return res.status(400).json({ error: 'Durum alani gecersiz' });
    const entries = Array.isArray(req.body.orders) ? req.body.orders.slice(0, 200) : [];
    if (!entries.length) return res.status(400).json({ error: 'En az bir siparis secin' });
    const results = [];
    for (const entry of entries) {
      const client = await db.pool.connect();
      try {
        await client.query('begin');
        await db.setTenantContext(client, organization.id);
        const transition = await transitionOrderOperation(client, {
          organizationId: organization.id,
          orderId: entry.id,
          changes: { [domain]: toStatus },
          expectedVersion: entry.version,
          actor: operationActor(req, 'order_bulk_api'),
        });
        await auditLog(req, {
          action: 'BULK_TRANSITION', resourceType: 'order', resourceId: entry.id,
          oldValue: { [`${domain}_status`]: transition.previous[`${domain}_status`], version: transition.previous.version },
          newValue: { [`${domain}_status`]: transition.order[`${domain}_status`], version: transition.order.version },
          organizationId: organization.id, store: client,
        });
        await client.query('commit');
        results.push({ id: String(entry.id), ok: true, order: transition.order });
      } catch (error) {
        await client.query('rollback').catch(() => {});
        results.push({ id: String(entry.id), ok: false, code: error.code || 'ORDER_UPDATE_FAILED', error: error.message, details: error.details });
      } finally {
        client.release();
      }
    }
    if (results.some((row) => row.ok)) kickOrderNotificationOutbox();
    res.json({ total: results.length, successCount: results.filter((row) => row.ok).length, failureCount: results.filter((row) => !row.ok).length, results });
  } catch (error) {
    next(error);
  }
});

router.post('/notifications/process', requireAuth, requireRole(['super_admin']), async (req, res, next) => {
  try {
    const results = await deliverPendingOrderNotifications({ limit: req.body.limit });
    res.json({ processedCount: results.length, results });
  } catch (error) {
    next(error);
  }
});

router.get('/lookup', lookupOrder);
router.get('/track', lookupOrder);

router.post('/', createOrderLimiter, async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const customer = sanitizeCustomer(req.body.customer || {});

    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const idempotencyKey = checkoutIdempotencyKey(req);
    const replay = await findCheckoutReplay(client, organization.id, idempotencyKey);
    if (replay) {
      await client.query('commit');
      return res.status(200).json({ ...replay, idempotentReplay: true });
    }
    await assertPlanCapacity(client, organization.id, 'orders_month');
    // A21: validate + lock the server cart (if the checkout references one) before
    // writing the order, so conversion is atomic and a second order from the same
    // cart is rejected. No cart reference keeps direct/legacy checkout working.
    const checkoutCartId = typeof req.body.cart_id === 'string' && CHECKOUT_CART_UUID.test(req.body.cart_id)
      ? req.body.cart_id.toLowerCase() : null;
    const checkoutCart = await prepareCartConversion(client, {
      organizationId: organization.id, cartId: checkoutCartId,
      guestToken: req.get('x-guest-cart-token') || '', expectedVersion: req.body.cart_version,
    });
    const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });
    const subtotal = cartTotal(items);
    const checkoutOptions = normalizeCheckoutOptions(req.body, organization.store_settings || {}, subtotal);
    const shippingQuote = await quoteCheckoutShipping(client, {
      organizationId: organization.id,
      items,
      subtotal,
      city: req.body.customer?.city || req.body.shipping_address?.city || '',
      country: req.body.customer?.country || req.body.shipping_address?.country || 'TR',
      settings: organization.store_settings || {},
      providers: shippingProviders,
    });
    checkoutOptions.shippingFee = shippingQuote.amount;
    const customerResult = await upsertCustomer(client, organization.id, customer);
    const pricing = await calculateCartPricing(client, items, {
      organizationId: organization.id,
      shippingFee: checkoutOptions.shippingFee,
      couponCode: req.body.couponCode || req.body.coupon_code || '',
      customerId: customerResult.id,
      guestEmail: customer.email,
      lockCoupon: true,
    });
    const invoiceProfile = await buildInvoiceProfileSnapshot(client, {
      organizationId: organization.id,
      customerId: customerResult.id,
      customer,
      body: req.body.invoice || req.body.billing || {},
    });
    // A24.5: gift wrap comes from the locked server cart, never from the checkout
    // payload. No cart (legacy/direct checkout) means no gift wrap.
    const gift = checkoutCart ? await resolveCheckoutGift(client, organization.id, checkoutCart) : null;
    const giftFee = gift && gift.option ? roundFee(gift.fee) : 0;
    const giftSnapshot = orderGiftSnapshot(gift);
    const tax = await calculateCheckoutTax(client, {
      organizationId: organization.id, items, pricing, giftWrapFee: giftFee,
    });
    pricing.total = tax.totals.gross;
    const promotion = promotionOrderColumns(pricing);
    const keepReservation = shouldKeepManualReservation(checkoutOptions.paymentMethod);
    const initialStatus = keepReservation ? 'payment_pending' : 'new';

    const orderCode = await nextOrderCode(client);
    const orderResult = await client.query(
      `insert into orders
       (organization_id, order_code, customer_id, total, status, payment_method,
        note, gift_wrap, shipping_fee, checkout_idempotency_key, subtotal,
        discount_total, campaign_discount, coupon_discount, shipping_discount,
        coupon_code, promotion_snapshot, net_total, tax_total, currency,
        invoice_profile_id, invoice_snapshot, tax_snapshot, invoice_retention_until,
        gift_wrap_fee, gift_note, gift_wrap_snapshot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
        $18,$19,$20,$21,$22::jsonb,$23::jsonb,$24,$25,$26,$27::jsonb)
       on conflict (organization_id, checkout_idempotency_key)
         where checkout_idempotency_key is not null
       do nothing
       returning *`,
      [
        organization.id,
        orderCode,
        customerResult.id,
        pricing.total,
        initialStatus,
        checkoutOptions.paymentMethod,
        checkoutOptions.note,
        giftSnapshot.selected,
        pricing.shippingFee,
        idempotencyKey,
        promotion.subtotal,
        promotion.discountTotal,
        promotion.campaignDiscount,
        promotion.couponDiscount,
        promotion.shippingDiscount,
        promotion.couponCode,
        JSON.stringify(promotion.snapshot),
        tax.totals.net,
        tax.totals.tax,
        tax.totals.currency,
        invoiceProfile.profileId,
        JSON.stringify(invoiceProfile.snapshot),
        JSON.stringify(tax),
        invoiceProfile.retentionUntil,
        giftFee,
        giftSnapshot.note,
        JSON.stringify(giftSnapshot),
      ]
    );

    if (!orderResult.rows[0]) {
      const concurrentReplay = await findCheckoutReplay(client, organization.id, idempotencyKey);
      await client.query('commit');
      return res.status(200).json({ ...concurrentReplay, idempotentReplay: true });
    }

    await insertOrderItems(client, orderResult.rows[0].id, tax.items);

    if (checkoutCart) {
      await markCartConverted(client, {
        organizationId: organization.id, cartId: checkoutCart.id, orderId: orderResult.rows[0].id,
      });
    }

    const reservationResult = await createInventoryReservation(client, {
      organizationId: organization.id,
      orderId: orderResult.rows[0].id,
      customerId: customerResult.id,
      guestEmail: customer.email,
      items,
      idempotencyKey: idempotencyKey ? `checkout:${idempotencyKey}` : `order:${orderResult.rows[0].id}`,
      ttlMinutes: Number(process.env.MANUAL_RESERVATION_TTL_MINUTES || 120),
    });
    await reserveCouponRedemption(client, {
      organizationId: organization.id,
      orderId: orderResult.rows[0].id,
      customerId: customerResult.id,
      guestEmail: customer.email,
      pricing,
      status: keepReservation ? 'reserved' : 'redeemed',
      idempotencyKey: idempotencyKey ? `checkout:${idempotencyKey}` : `order:${orderResult.rows[0].id}`,
    });
    if (!keepReservation) {
      await consumeReservation(client, {
        organizationId: organization.id,
        reservationId: reservationResult.reservation.id,
      });
    }

    await client.query('commit');

    const createdOrder = orderResult.rows[0];
    setImmediate(async () => {
      try {
        const sellerResult = await db.query(
          `select u.email as user_email, o.name as organization_name, o.slug as organization_slug
             from organizations o
             left join memberships m on m.organization_id = o.id and m.role = 'owner' and m.status = 'active'
             left join app_users u on u.id = m.user_id
            where o.id = $1
            order by m.created_at asc
            limit 1`,
          [organization.id]
        );
        const sellerRow = sellerResult.rows[0];
        const sellerEmail = sellerRow?.user_email || '';
        if (!sellerEmail) return;
        await sendNewOrderSellerNotification({
          order: { ...createdOrder, customer_name: customerResult?.name || customer?.name || '' },
          organization: {
            id: organization.id,
            name: sellerRow.organization_name || organization.name,
            slug: sellerRow.organization_slug || organization.slug,
          },
          sellerEmail,
          items,
        });
      } catch (error) {
        logger.warn({ orderId: createdOrder?.id, err: error.message }, 'Seller siparis bildirimi gonderilemedi');
      }
    });

    res.status(201).json({
      ...createdOrder,
      inventory_reservation: {
        id: reservationResult.reservation.id,
        status: keepReservation ? 'active' : 'consumed',
        expires_at: reservationResult.reservation.expires_at,
        server_time: reservationResult.reservation.server_time,
      },
      pricing,
      payment_instructions: checkoutOptions.paymentMethod === 'iban'
        ? paymentInstructionsFromSettings(organization.store_settings || {})
        : null,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select
         o.*,
         c.name as customer_name,
         c.email,
         c.phone,
         c.address,
         coalesce(
           json_agg(
             json_build_object(
               'id', oi.id,
               'product_id', oi.product_id,
               'variant_id', oi.variant_id,
               'name', oi.product_name,
               'color', oi.selected_color,
               'size', oi.selected_size,
               'sku', oi.sku,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price,
               'line_total', oi.quantity * oi.unit_price
             )
             order by oi.id
           ) filter (where oi.id is not null),
           '[]'::json
         ) as items
       from orders o
       left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
       left join order_items oi on oi.order_id = o.id
       where o.id = $1 and o.organization_id = $2
       group by o.id, c.id
       limit 1`,
      [req.params.id, organization.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Siparis bulunamadi' });
    const detail = orderDetailView(result.rows[0]);
    const operations = await loadOrderOperations(db, organization.id, detail.id);
    res.json({
      ...detail,
      ...operations,
      valid_transitions: validTransitionsForOrder(detail),
      packing_list: packingListSnapshot(detail, false),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/transitions', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  let transaction;
  try {
    const domain = String(req.body.domain || 'order');
    const status = String(req.body.status || '');
    if (!['order', 'payment', 'fulfillment'].includes(domain)) {
      return res.status(400).json({ error: 'Durum alani gecersiz', code: 'ORDER_STATE_INVALID' });
    }
    transaction = await beginOrderTransaction(req);
    const transition = await transitionOrderOperation(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      changes: { [domain]: status },
      expectedVersion: req.body.version,
      actor: { ...operationActor(req, 'order_transition_api'), publicMessage: req.body.publicMessage || '' },
    });
    await auditLog(req, {
      action: 'TRANSITION', resourceType: 'order', resourceId: req.params.id,
      oldValue: { domain, status: transition.previous[`${domain}_status`], version: transition.previous.version },
      newValue: { domain, status: transition.order[`${domain}_status`], version: transition.order.version },
      organizationId: transaction.organization.id, store: transaction.client,
    });
    await transaction.client.query('commit');
    kickOrderNotificationOutbox();
    res.json({ ...transition.order, valid_transitions: validTransitionsForOrder(transition.order) });
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

router.get('/:id/packing-list', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select o.*,
        coalesce(json_agg(json_build_object(
          'id', oi.id, 'product_id', oi.product_id, 'variant_id', oi.variant_id,
          'name', oi.product_name, 'color', oi.selected_color, 'size', oi.selected_size,
          'sku', oi.sku, 'quantity', oi.quantity, 'unit_price', oi.unit_price,
          'line_total', oi.quantity * oi.unit_price
        ) order by oi.id) filter (where oi.id is not null), '[]'::json) as items
       from orders o left join order_items oi on oi.order_id = o.id and oi.organization_id = o.organization_id
       where o.id = $1 and o.organization_id = $2 group by o.id`,
      [req.params.id, organization.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Siparis bulunamadi' });
    const includePrices = req.query.includePrices === 'true' && ['super_admin', 'owner', 'admin'].includes(req.auth?.role);
    res.json(packingListSnapshot(result.rows[0], includePrices));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/notes', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const note = await createOrderNote(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      visibility: req.body.visibility,
      content: req.body.content,
      actor: operationActor(req, 'order_note_api'),
    });
    await auditLog(req, {
      action: 'ADD_NOTE', resourceType: 'order', resourceId: req.params.id,
      newValue: { noteId: note.id, visibility: note.visibility },
      organizationId: transaction.organization.id, store: transaction.client,
    });
    await transaction.client.query('commit');
    res.status(201).json(note);
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

router.patch('/:id/notes/:noteId', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const note = await updateOrderNote(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      noteId: req.params.noteId,
      content: req.body.content,
      actor: operationActor(req, 'order_note_api'),
    });
    await auditLog(req, {
      action: 'EDIT_NOTE', resourceType: 'order', resourceId: req.params.id,
      newValue: { noteId: note.id, visibility: note.visibility },
      organizationId: transaction.organization.id, store: transaction.client,
    });
    await transaction.client.query('commit');
    res.json(note);
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

router.delete('/:id/notes/:noteId', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const note = await deleteOrderNote(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      noteId: req.params.noteId,
      actor: operationActor(req, 'order_note_api'),
    });
    await auditLog(req, {
      action: 'DELETE_NOTE', resourceType: 'order', resourceId: req.params.id,
      newValue: { noteId: note.id, deletedAt: note.deleted_at },
      organizationId: transaction.organization.id, store: transaction.client,
    });
    await transaction.client.query('commit');
    res.json({ ok: true, id: note.id });
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

router.put('/:id/tags', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const tags = await replaceOrderTags(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      tagIds: req.body.tagIds,
      actor: operationActor(req, 'order_tag_api'),
    });
    await auditLog(req, {
      action: 'REPLACE_TAGS', resourceType: 'order', resourceId: req.params.id,
      newValue: { tagIds: tags.map((tag) => tag.id) },
      organizationId: transaction.organization.id, store: transaction.client,
    });
    await transaction.client.query('commit');
    res.json(tags);
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

router.put('/:id/assignment', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const assignment = await assignOrder(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      assignedUserId: req.body.assignedUserId || null,
      actor: operationActor(req, 'order_assignment_api'),
    });
    await auditLog(req, {
      action: 'ASSIGN', resourceType: 'order', resourceId: req.params.id,
      newValue: { assignedUserId: assignment?.assigned_user_id || null },
      organizationId: transaction.organization.id, store: transaction.client,
    });
    await transaction.client.query('commit');
    res.json({ assignment });
  } catch (error) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(error);
  } finally {
    transaction?.client.release();
  }
});

/**
 * @swagger
 * /api/orders/{id}/status:
 *   put:
 *     summary: Siparis durumunu gunceller
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [new, payment_pending, processing, shipped, delivered, cancelled, paid]
 *                 example: shipped
 *     responses:
 *       200:
 *         description: Durum guncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.put('/:id/status', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  let transaction;
  try {
    const { status } = req.body;
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Durum gecersiz' });
    transaction = await beginOrderTransaction(req);
    const transition = await transitionLegacyOrderStatus(transaction.client, {
      organizationId: transaction.organization.id,
      orderId: req.params.id,
      status,
      expectedVersion: req.body.version,
      actor: operationActor(req, 'legacy_order_status_api'),
    });
    await auditLog(req, {
      action: 'UPDATE_STATUS',
      resourceType: 'order',
      resourceId: req.params.id,
      oldValue: { status: transition.previous.status, version: transition.previous.version },
      newValue: { status: transition.order.status, version: transition.order.version },
      organizationId: transaction.organization.id,
      store: transaction.client,
    });
    await transaction.client.query('commit');
    kickOrderNotificationOutbox();
    res.json({ ...transition.order, valid_transitions: validTransitionsForOrder(transition.order) });
  } catch (err) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(err);
  } finally {
    transaction?.client.release();
  }
});

router.put('/:id/shipping', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  let transaction;
  try {
    transaction = await beginOrderTransaction(req);
    const { client, organization } = transaction;
    const actor = operationActor(req, 'order_shipping_api');
    const {
      shipping_company = req.body.shippingCompany || '',
      tracking_number = req.body.trackingNumber || '',
      tracking_url = req.body.trackingUrl || '',
      shipped_at = req.body.shippedAt || null,
    } = req.body;

    const oldResult = await client.query(
      `select *
       from orders
       where id = $1 and organization_id = $2
       for update`,
      [req.params.id, organization.id]
    );

    if (!oldResult.rows[0]) {
      throw Object.assign(new Error('Siparis bulunamadi'), { status: 404, code: 'ORDER_NOT_FOUND' });
    }
    if (req.body.version != null && Number(req.body.version) !== Number(oldResult.rows[0].version)) {
      throw Object.assign(new Error('Siparis baska bir kullanici tarafindan guncellendi'), {
        status: 409,
        code: 'ORDER_VERSION_CONFLICT',
        details: { expectedVersion: Number(req.body.version), currentVersion: Number(oldResult.rows[0].version) },
      });
    }

    let result = await client.query(
      `update orders
       set shipping_company = $1,
           tracking_number = $2,
           tracking_url = $3,
           shipped_at = nullif($4, '')::timestamptz,
           updated_at = now()
       where id = $5 and organization_id = $6
       returning *`,
      [
        String(shipping_company).slice(0, 120),
        String(tracking_number).slice(0, 120),
        String(tracking_url).slice(0, 500),
        shipped_at,
        req.params.id,
        organization.id,
      ]
    );
    if (tracking_number && oldResult.rows[0].order_status === 'ready_to_ship') {
      const transition = await transitionOrderOperation(client, {
        organizationId: organization.id,
        orderId: req.params.id,
        changes: { order: 'shipped', fulfillment: 'shipped' },
        expectedVersion: oldResult.rows[0].version,
        actor,
      });
      result = { rows: [transition.order] };
    }
    await appendOrderEvent(client, {
      organizationId: organization.id,
      orderId: req.params.id,
      eventType: 'shipping_updated',
      actor,
      metadata: {
        hasCarrier: Boolean(shipping_company),
        hasTrackingNumber: Boolean(tracking_number),
        hasTrackingUrl: Boolean(tracking_url),
      },
    });

    await auditLog(req, {
      action: 'UPDATE_SHIPPING',
      resourceType: 'order',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
      newValue: {
        shipping_company: result.rows[0].shipping_company,
        tracking_number: result.rows[0].tracking_number,
        tracking_url: result.rows[0].tracking_url,
        shipped_at: result.rows[0].shipped_at,
        fulfillment_status: result.rows[0].fulfillment_status,
      },
      organizationId: organization.id,
      store: client,
    });
    await client.query('commit');
    kickOrderNotificationOutbox();
    res.json(result.rows[0]);
  } catch (err) {
    if (transaction?.client) await transaction.client.query('rollback').catch(() => {});
    next(err);
  } finally {
    transaction?.client.release();
  }
});

module.exports = router;
