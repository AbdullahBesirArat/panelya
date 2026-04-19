const express = require('express');
const db = require('../db');
const {
  initializePayment,
  retrievePayment,
  providerName,
  successUrl,
  failureUrl,
} = require('../services/paymentProviders');
const { reserveStock, syncStockForStatusChange } = require('../services/inventory');
const { cartTotal, priceCartItems } = require('../services/cartPricing');
const { auditLog } = require('../services/audit');
const { isProduction, rateLimit } = require('../middleware/security');
const { requireCallbackSecret, sanitizeCustomer } = require('../services/validation');
const { resolveOrganization } = require('../services/tenant');
const { nextOrderCode } = require('../services/orderCodes');
const { insertOrderItems } = require('../services/orderItems');

const router = express.Router();
const paymentInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PAYMENT_INIT_RATE_LIMIT || 40),
  message: 'Cok fazla odeme denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function mockAutoPayEnabled() {
  return !isProduction() && process.env.PAYMENT_MOCK_AUTO_PAY === 'true';
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
 *                 example: maveran
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
    const provider = providerName();

    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });

    const customerResult = await client.query(
      `insert into customers (organization_id, name, email, phone, address)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        organization.id,
        customer.name,
        customer.email,
        customer.phone,
        customer.address,
      ]
    );

    const calculatedTotal = cartTotal(items);
    const orderCode = await nextOrderCode(client);
    let orderResult = await client.query(
      `insert into orders (organization_id, order_code, customer_id, total, status, payment_provider)
       values ($1, $2, $3, $4, 'payment_pending', $5)
       returning *`,
      [organization.id, orderCode, customerResult.rows[0].id, calculatedTotal, provider]
    );

    await insertOrderItems(client, orderResult.rows[0].id, items);

    await reserveStock(client, items);

    const payment = await initializePayment({
      req,
      order: orderResult.rows[0],
      customer: { ...customer, id: customerResult.rows[0].id },
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
  let client;
  let transactionStarted = false;
  try {
    const { orderCode, token, status = 'paid' } = req.body;
    if (!orderCode && !token) return res.status(400).json({ error: 'orderCode veya token zorunlu' });

    const provider = providerName();
    const callbackSecretRequired = provider !== 'iyzico'
      && (isProduction() || process.env.PAYMENT_CALLBACK_SECRET_REQUIRED === 'true');

    if (callbackSecretRequired && !requireCallbackSecret(req)) {
      return res.status(403).json({ error: 'Odeme callback dogrulanamadi' });
    }
    if (provider === 'iyzico' && !token) {
      return res.status(400).json({ error: 'Iyzico callback icin token zorunlu' });
    }

    let nextStatus = provider === 'mock' && status === 'paid' ? 'paid' : 'cancelled';
    let paymentId = null;
    let paymentError = null;

    if (token && provider === 'iyzico') {
      const orderPreview = await db.query(
        'select order_code from orders where payment_token = $1 limit 1',
        [token]
      );
      if (!orderPreview.rows[0]) {
        return res.status(404).json({ error: 'Siparis bulunamadi' });
      }

      const payment = await retrievePayment({
        token,
        conversationId: orderPreview.rows[0].order_code,
      });
      nextStatus = payment.status === 'success' && payment.paymentStatus === 'SUCCESS' ? 'paid' : 'cancelled';
      paymentId = payment.paymentId || null;
      paymentError = payment.errorMessage || null;
    }

    client = await db.pool.connect();
    await client.query('begin');
    transactionStarted = true;

    const orderResult = token
      ? await client.query('select * from orders where payment_token = $1 limit 1 for update', [token])
      : await client.query('select * from orders where order_code = $1 limit 1 for update', [orderCode]);

    if (!orderResult.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Siparis bulunamadi' });
    }

    const currentStatus = orderResult.rows[0].status;
    if (['paid', 'cancelled'].includes(currentStatus) && currentStatus !== nextStatus) {
      nextStatus = currentStatus;
      paymentError = paymentError || `Final durum korunuyor: ${currentStatus}`;
    }

    await syncStockForStatusChange(
      client,
      orderResult.rows[0].id,
      currentStatus,
      nextStatus
    );

    const result = await client.query(
      `update orders
       set status = $1,
           payment_id = coalesce($2, payment_id),
           payment_error = $3,
           updated_at = now()
       where id = $4
       returning *`,
      [nextStatus, paymentId, paymentError, orderResult.rows[0].id]
    );

    await auditLog(req, {
      action: 'PAYMENT_CALLBACK',
      resourceType: 'order',
      resourceId: orderResult.rows[0].id,
      oldValue: { status: orderResult.rows[0].status },
      newValue: { status: nextStatus, provider, paymentId, paymentError },
      success: nextStatus === 'paid',
      errorMessage: paymentError,
    });
    await client.query('commit');
    transactionStarted = false;

    if (req.is('application/x-www-form-urlencoded')) {
      return res.redirect(nextStatus === 'paid'
        ? successUrl(req, result.rows[0].order_code)
        : failureUrl(req, result.rows[0].order_code));
    }

    res.json({ ok: nextStatus === 'paid', order: result.rows[0] });
  } catch (err) {
    if (transactionStarted && client) {
      await client.query('rollback');
    }
    next(err);
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
