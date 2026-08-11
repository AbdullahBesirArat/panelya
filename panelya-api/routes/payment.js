const express = require('express');
const db = require('../db');
const {
  initializePayment,
  providerName,
  failureUrl,
} = require('../services/paymentProviders');
const {
  consumeReservation,
  createInventoryReservation,
  releaseReservation,
} = require('../services/inventoryReservations');
const { checkoutIdempotencyKey, findCheckoutReplay } = require('../services/checkoutIdempotency');
const { markCartConverted, prepareCartConversion, restoreConvertedCart } = require('../modules/cart/service');
const { orderGiftSnapshot, resolveCheckoutGift, roundFee } = require('../modules/cart/giftWrap');
const { calculateCartPricing, cartTotal, priceCartItems } = require('../services/cartPricing');
const { isProduction, rateLimit } = require('../middleware/security');
const { requireCallbackSecret, sanitizeCustomer } = require('../services/validation');
const { resolveOrganization } = require('../services/tenant');
const { nextOrderCode } = require('../services/orderCodes');
const { insertOrderItems } = require('../services/orderItems');
const { enqueuePaymentCallbackEvent, processPaymentCallbackEvent } = require('../services/paymentCallbackEvents');
const { normalizeCheckoutOptions } = require('../services/checkoutPayload');
const { paymentInstructionsFromSettings } = require('../services/storeSettings');
const {
  promotionOrderColumns,
  reserveCouponRedemption,
  transitionOrderPromotion,
} = require('../services/promotionEngine');
const { assertPlanCapacity } = require('../services/planLimits');
const { upsertCustomer } = require('../services/customers');
const { quoteCheckoutShipping } = require('../modules/shipping/pricing');
const { providers: shippingProviders } = require('../modules/shipping/providers');
const { buildInvoiceProfileSnapshot } = require('../modules/invoicing/profiles');
const { calculateCheckoutTax } = require('../modules/invoicing/taxEngine');

const router = express.Router();
const paymentInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PAYMENT_INIT_RATE_LIMIT || 40),
  message: 'Cok fazla odeme denemesi. Lutfen biraz sonra tekrar deneyin.',
});

const CHECKOUT_CART_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mockAutoPayEnabled() {
  return !isProduction() && process.env.PAYMENT_MOCK_AUTO_PAY === 'true';
}

function manualInventoryMode() {
  return String(process.env.MANUAL_PAYMENT_INVENTORY_MODE || 'reserve').trim().toLowerCase() === 'consume'
    ? 'consume'
    : 'reserve';
}

function checkoutReplayResponse(req, replay) {
  const {
    reservation_id: reservationId,
    reservation_status: reservationStatus,
    reservation_expires_at: reservationExpiresAt,
    server_time: serverTime,
    ...order
  } = replay;
  return {
    provider: order.payment_provider,
    order,
    orderCode: order.order_code,
    paymentPageUrl: order.payment_page_url,
    failureUrl: failureUrl(req, order.order_code),
    inventoryReservation: reservationId
      ? {
        id: reservationId,
        status: reservationStatus,
        expiresAt: reservationExpiresAt,
        serverTime,
      }
      : null,
    idempotentReplay: true,
  };
}

function paymentCallbackError(message, status = 400, code = 'PAYMENT_CALLBACK_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function resolveCallbackOrganizationByToken(store, token) {
  const result = await store.query(
    `select organization_id
     from orders
     where payment_token = $1
     order by id asc
     limit 2`,
    [token]
  );
  if (result.rows.length !== 1) {
    throw paymentCallbackError('Siparis bulunamadi', 404, 'PAYMENT_CALLBACK_ORDER_NOT_FOUND');
  }
  return result.rows[0].organization_id;
}

async function resolveCallbackOrganizationByOrderCode(store, orderCode) {
  const result = await store.query(
    `select organization_id
     from orders
     where order_code = $1
     order by id asc
     limit 2`,
    [orderCode]
  );
  if (result.rows.length !== 1) {
    throw paymentCallbackError('Siparis bulunamadi', 404, 'PAYMENT_CALLBACK_ORDER_NOT_FOUND');
  }
  return result.rows[0].organization_id;
}

async function preparePaymentCallbackContext(req, { provider, token, orderCode }, store = db) {
  const callbackSecretRequired = provider !== 'iyzico'
    && (isProduction() || process.env.PAYMENT_CALLBACK_SECRET_REQUIRED === 'true' || !token);

  if (callbackSecretRequired && !requireCallbackSecret(req)) {
    throw paymentCallbackError('Odeme callback dogrulanamadi', 403, 'PAYMENT_CALLBACK_FORBIDDEN');
  }
  if (provider === 'iyzico' && !token) {
    throw paymentCallbackError('Iyzico callback icin token zorunlu', 400, 'PAYMENT_CALLBACK_TOKEN_REQUIRED');
  }

  if (token) {
    return { verifiedOrganizationId: await resolveCallbackOrganizationByToken(store, token) };
  }
  return { verifiedOrganizationId: await resolveCallbackOrganizationByOrderCode(store, orderCode) };
}

/**
 * @swagger
 * /api/payment/initialize:
 *   post:
 *     summary: Odeme akisini baslatir ve payment pending siparis olusturur
 *     tags: [Payment]
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
 *         description: Odeme baslatildi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaymentInitializeResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post('/initialize', paymentInitLimiter, async (req, res, next) => {
  let client = null;
  let transactionOpen = false;

  try {
    const customer = sanitizeCustomer(req.body.customer || {});
    if (
      process.env.NODE_ENV === 'test'
      && process.env.E2E_TEST_MODE === 'true'
      && customer.email === 'e2e-payment-fail@example.test'
    ) {
      const error = new Error('Test ödeme sağlayıcısı kontrollü olarak reddetti');
      error.status = 502;
      throw error;
    }

    client = await db.pool.connect();
    await client.query('begin');
    transactionOpen = true;
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const idempotencyKey = checkoutIdempotencyKey(req);
    const replay = await findCheckoutReplay(client, organization.id, idempotencyKey);
    if (replay) {
      await client.query('commit');
      transactionOpen = false;
      client.release();
      client = null;
      return res.status(200).json(checkoutReplayResponse(req, replay));
    }
    await assertPlanCapacity(client, organization.id, 'orders_month');
    // A21: validate + lock the referenced server cart before writing the order so
    // conversion is atomic with order creation (a second order from the same cart is
    // rejected, a stale/foreign cart throws). No cart reference keeps direct checkout
    // working. The cart is marked converted after the order row is inserted below.
    const checkoutCartId = typeof req.body.cart_id === 'string' && CHECKOUT_CART_UUID.test(req.body.cart_id)
      ? req.body.cart_id.toLowerCase() : null;
    const checkoutCart = await prepareCartConversion(client, {
      organizationId: organization.id, cartId: checkoutCartId,
      guestToken: req.get('x-guest-cart-token') || '', expectedVersion: req.body.cart_version,
    });
    const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });

    // Once urunleri sunucuda fiyatlandir, ara toplami hesapla; ardindan magaza
    // ayarlariyla (shippingFee / freeShippingThreshold / paymentEnabled) checkout
    // seceneklerini belirle. Kargo istemciden asla alinmaz.
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
    const offlinePayment = checkoutOptions.paymentMethod === 'iban';
    let provider = offlinePayment
      ? 'manual'
      : providerName();
    const inventoryMode = offlinePayment ? manualInventoryMode() : 'reserve';

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
    // A24.5: gift wrap is resolved from the locked server cart, never from the payload.
    const gift = checkoutCart ? await resolveCheckoutGift(client, organization.id, checkoutCart) : null;
    const giftFee = gift && gift.option ? roundFee(gift.fee) : 0;
    const giftSnapshot = orderGiftSnapshot(gift);
    const tax = await calculateCheckoutTax(client, {
      organizationId: organization.id, items, pricing, giftWrapFee: giftFee,
    });
    pricing.total = tax.totals.gross;
    const promotion = promotionOrderColumns(pricing);
    if (!offlinePayment && pricing.total <= 0) provider = 'promotion';
    const orderCode = await nextOrderCode(client);
    let orderResult = await client.query(
      `insert into orders
       (organization_id, order_code, customer_id, total, status, payment_provider,
        payment_method, note, gift_wrap, shipping_fee, checkout_idempotency_key,
        subtotal, discount_total, campaign_discount, coupon_discount,
        shipping_discount, coupon_code, promotion_snapshot, net_total, tax_total, currency,
        invoice_profile_id, invoice_snapshot, tax_snapshot, invoice_retention_until,
        gift_wrap_fee, gift_note, gift_wrap_snapshot)
       values ($1,$2,$3,$4,'payment_pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
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
        provider,
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
      transactionOpen = false;
      client.release();
      client = null;
      return res.status(200).json(checkoutReplayResponse(req, concurrentReplay));
    }

    await insertOrderItems(client, orderResult.rows[0].id, tax.items);

    if (checkoutCart) {
      // Atomic with the order: the cart is locked (prepareCartConversion above) for
      // this transaction, so this update always wins and the order + conversion
      // commit or roll back together.
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
      ttlMinutes: offlinePayment
        ? Number(process.env.MANUAL_RESERVATION_TTL_MINUTES || 120)
        : Number(process.env.INVENTORY_RESERVATION_TTL_MINUTES || 15),
    });
    await reserveCouponRedemption(client, {
      organizationId: organization.id,
      orderId: orderResult.rows[0].id,
      customerId: customerResult.id,
      guestEmail: customer.email,
      pricing,
      status: inventoryMode === 'consume' ? 'redeemed' : 'reserved',
      idempotencyKey: idempotencyKey ? `checkout:${idempotencyKey}` : `order:${orderResult.rows[0].id}`,
    });

    if (inventoryMode === 'consume') {
      await consumeReservation(client, {
        organizationId: organization.id,
        reservationId: reservationResult.reservation.id,
      });
      orderResult = await client.query(
        `update orders set status = 'new', updated_at = now()
          where id = $1 and organization_id = $2 returning *`,
        [orderResult.rows[0].id, organization.id]
      );
    }

    await client.query('commit');
    transactionOpen = false;
    client.release();
    client = null;

    if (offlinePayment) {
      return res.status(201).json({
        provider,
        order: orderResult.rows[0],
        orderCode,
        pricing,
        paymentInstructions: paymentInstructionsFromSettings(organization.store_settings || {}),
        paymentPageUrl: null,
        failureUrl: failureUrl(req, orderCode),
        inventoryReservation: {
          id: reservationResult.reservation.id,
          status: inventoryMode === 'consume' ? 'consumed' : 'active',
          expiresAt: reservationResult.reservation.expires_at,
          serverTime: reservationResult.reservation.server_time,
        },
      });
    }

    let payment;
    try {
      payment = provider === 'promotion'
        ? { token: null, paymentPageUrl: null, failureUrl: null }
        : await initializePayment({
          req,
          order: orderResult.rows[0],
          customer: { ...customer, id: customerResult.id },
          items,
          pricing,
        });
    } catch (providerError) {
      client = await db.pool.connect();
      await client.query('begin');
      transactionOpen = true;
      await db.setTenantContext(client, organization.id);
      await releaseReservation(client, {
        organizationId: organization.id,
        reservationId: reservationResult.reservation.id,
      });
      await transitionOrderPromotion(client, orderResult.rows[0].id, 'payment_pending', 'cancelled', {
        organizationId: organization.id,
      });
      await client.query(
        `update orders
            set status = 'cancelled', payment_error = $1,
                checkout_idempotency_key = null, updated_at = now()
          where id = $2 and organization_id = $3`,
        [String(providerError.message || 'Odeme baslatilamadi').slice(0, 500), orderResult.rows[0].id, organization.id]
      );
      if (checkoutCart) {
        // The order is cancelled, so hand the cart back to the shopper (active +
        // recoverable) instead of leaving it stranded in 'converted'.
        await restoreConvertedCart(client, {
          organizationId: organization.id, cartId: checkoutCart.id, orderId: orderResult.rows[0].id,
        });
      }
      await client.query('commit');
      transactionOpen = false;
      client.release();
      client = null;
      if (!providerError.status) providerError.status = 502;
      throw providerError;
    }

    client = await db.pool.connect();
    await client.query('begin');
    transactionOpen = true;
    await db.setTenantContext(client, organization.id);

    const initialStatus = provider === 'promotion' || (provider === 'mock' && mockAutoPayEnabled())
      ? 'paid'
      : 'payment_pending';
    if (initialStatus === 'paid') {
      await consumeReservation(client, {
        organizationId: organization.id,
        reservationId: reservationResult.reservation.id,
      });
      await transitionOrderPromotion(client, orderResult.rows[0].id, 'payment_pending', 'paid', {
        organizationId: organization.id,
      });
    }

    orderResult = await client.query(
      `update orders
       set status = $1,
           payment_provider = $2,
           payment_token = $3,
           payment_page_url = $4,
           updated_at = now()
       where id = $5 and organization_id = $6
       returning *`,
      [
        initialStatus,
        provider,
        payment.token || null,
        payment.paymentPageUrl || null,
        orderResult.rows[0].id,
        organization.id,
      ]
    );
    await client.query('commit');
    transactionOpen = false;
    client.release();
    client = null;

    res.status(201).json({
      provider,
      order: orderResult.rows[0],
      orderCode,
      pricing,
      paymentInstructions: offlinePayment
        ? paymentInstructionsFromSettings(organization.store_settings || {})
        : null,
      paymentPageUrl: payment.paymentPageUrl,
      failureUrl: payment.failureUrl || failureUrl(req, orderCode),
      inventoryReservation: {
        id: reservationResult.reservation.id,
        status: initialStatus === 'paid' ? 'consumed' : 'active',
        expiresAt: reservationResult.reservation.expires_at,
        serverTime: reservationResult.reservation.server_time,
      },
    });
  } catch (err) {
    if (client && transactionOpen) await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

/**
 * @swagger
 * /api/payment/callback:
 *   post:
 *     summary: Odeme saglayici callback'ini isler
 *     tags: [Payment]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: x-payment-callback-secret
 *         required: false
 *         schema: { type: string }
 *         description: Mock/manual provider icin zorunlu callback secret
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               orderCode:
 *                 type: string
 *                 example: '#2401'
 *               token:
 *                 type: string
 *                 nullable: true
 *               status:
 *                 type: string
 *                 enum: [paid, cancelled]
 *                 example: paid
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Callback islendi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post('/callback', async (req, res, next) => {
  try {
    const { orderCode, token, status = 'paid' } = req.body;
    if (!orderCode && !token) return res.status(400).json({ error: 'orderCode veya token zorunlu' });

    const provider = providerName();
    const systemStore = { query: (text, params) => db.systemQuery(text, params) };
    const callbackContext = await preparePaymentCallbackContext(req, { provider, token, orderCode }, systemStore);

    const event = await enqueuePaymentCallbackEvent(req, {
      provider,
      orderCode,
      token,
      status,
    }, systemStore, callbackContext);
    const result = await processPaymentCallbackEvent(req, event.id, callbackContext);

    if (req.is('application/x-www-form-urlencoded')) {
      return res.redirect(result.redirectUrl);
    }

    res.json({ ok: result.ok, order: result.order, callbackEventId: result.id });
  } catch (err) {
    next(err);
  }
});

router.preparePaymentCallbackContext = preparePaymentCallbackContext;
router.resolveCallbackOrganizationByToken = resolveCallbackOrganizationByToken;
router.resolveCallbackOrganizationByOrderCode = resolveCallbackOrganizationByOrderCode;

module.exports = router;
