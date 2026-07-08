const express = require('express');
const db = require('../db');
const {
  initializePayment,
  providerName,
  failureUrl,
} = require('../services/paymentProviders');
const { reserveStock } = require('../services/inventory');
const { calculateCartPricing, cartTotal, priceCartItems } = require('../services/cartPricing');
const { isProduction, rateLimit } = require('../middleware/security');
const { requireCallbackSecret, sanitizeCustomer } = require('../services/validation');
const { resolveOrganization } = require('../services/tenant');
const { nextOrderCode } = require('../services/orderCodes');
const { insertOrderItems } = require('../services/orderItems');
const { enqueuePaymentCallbackEvent, processPaymentCallbackEvent } = require('../services/paymentCallbackEvents');
const { normalizeCheckoutOptions } = require('../services/checkoutPayload');
const { paymentInstructionsFromSettings } = require('../services/storeSettings');
const { assertPlanCapacity } = require('../services/planLimits');
const { upsertCustomer } = require('../services/customers');

const router = express.Router();
const paymentInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PAYMENT_INIT_RATE_LIMIT || 40),
  message: 'Cok fazla odeme denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function mockAutoPayEnabled() {
  return !isProduction() && process.env.PAYMENT_MOCK_AUTO_PAY === 'true';
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
  const client = await db.pool.connect();

  try {
    const customer = sanitizeCustomer(req.body.customer || {});

    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await assertPlanCapacity(client, organization.id, 'orders_month');
    const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });

    // Once urunleri sunucuda fiyatlandir, ara toplami hesapla; ardindan magaza
    // ayarlariyla (shippingFee / freeShippingThreshold / paymentEnabled) checkout
    // seceneklerini belirle. Kargo istemciden asla alinmaz.
    const subtotal = cartTotal(items);
    const checkoutOptions = normalizeCheckoutOptions(req.body, organization.store_settings || {}, subtotal);
    const offlinePayment = checkoutOptions.paymentMethod === 'iban';
    const provider = offlinePayment
      ? 'manual'
      : providerName();

    const customerResult = await upsertCustomer(client, organization.id, customer);

    const pricing = await calculateCartPricing(client, items, {
      organizationId: organization.id,
      shippingFee: checkoutOptions.shippingFee,
    });
    const orderCode = await nextOrderCode(client);
    let orderResult = await client.query(
      `insert into orders
       (organization_id, order_code, customer_id, total, status, payment_provider, payment_method, note, gift_wrap, shipping_fee)
       values ($1, $2, $3, $4, 'payment_pending', $5, $6, $7, $8, $9)
       returning *`,
      [
        organization.id,
        orderCode,
        customerResult.id,
        pricing.total,
        provider,
        checkoutOptions.paymentMethod,
        checkoutOptions.note,
        checkoutOptions.giftWrap,
        checkoutOptions.shippingFee,
      ]
    );

    await insertOrderItems(client, orderResult.rows[0].id, items);

    await reserveStock(client, items, { organizationId: organization.id });

    const payment = offlinePayment
      ? { token: null, paymentPageUrl: null, failureUrl: null }
      : await initializePayment({
        req,
        order: orderResult.rows[0],
        customer: { ...customer, id: customerResult.id },
        items,
      });

    const initialStatus = provider === 'mock' && mockAutoPayEnabled()
      ? 'paid'
      : 'payment_pending';

    orderResult = await client.query(
      `update orders
       set status = $1,
           payment_provider = $2,
           payment_token = $3,
           updated_at = now()
       where id = $4
       returning *`,
      [initialStatus, provider, payment.token || null, orderResult.rows[0].id]
    );

    await client.query('commit');

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
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
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
    const callbackContext = await preparePaymentCallbackContext(req, { provider, token, orderCode });

    const event = await enqueuePaymentCallbackEvent(req, {
      provider,
      orderCode,
      token,
      status,
    }, db, callbackContext);
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
