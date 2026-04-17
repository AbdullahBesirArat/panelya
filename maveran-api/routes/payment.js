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
const { isProduction } = require('../middleware/security');
const { requireCallbackSecret, sanitizeCustomer } = require('../services/validation');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();

function mockAutoPayEnabled() {
  return !isProduction() && process.env.PAYMENT_MOCK_AUTO_PAY === 'true';
}

async function nextOrderCode(client) {
  const result = await client.query(
    "select coalesce(max(nullif(regexp_replace(order_code, '\\D', '', 'g'), '')::int), 1000) + 1 as next from orders"
  );
  return `#${result.rows[0].next}`;
}

router.post('/initialize', async (req, res, next) => {
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

    for (const item of items) {
      await client.query(
        `insert into order_items (order_id, product_id, product_name, quantity, unit_price)
         values ($1, $2, $3, $4, $5)`,
        [
          orderResult.rows[0].id,
          item.product_id,
          item.name,
          item.quantity,
          item.unit_price,
        ]
      );
    }

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

router.post('/callback', async (req, res, next) => {
  const client = await db.pool.connect();

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

    await client.query('begin');

    let orderResult = token
      ? await client.query('select * from orders where payment_token = $1 limit 1 for update', [token])
      : await client.query('select * from orders where order_code = $1 limit 1 for update', [orderCode]);

    if (!orderResult.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Siparis bulunamadi' });
    }

    let nextStatus = provider === 'mock' && status === 'paid' ? 'paid' : 'cancelled';
    let paymentId = null;
    let paymentError = null;

    if (token && provider === 'iyzico') {
      const payment = await retrievePayment({
        token,
        conversationId: orderResult.rows[0].order_code,
      });
      nextStatus = payment.status === 'success' && payment.paymentStatus === 'SUCCESS' ? 'paid' : 'cancelled';
      paymentId = payment.paymentId || null;
      paymentError = payment.errorMessage || null;
    }

    await syncStockForStatusChange(
      client,
      orderResult.rows[0].id,
      orderResult.rows[0].status,
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

    if (req.is('application/x-www-form-urlencoded')) {
      return res.redirect(nextStatus === 'paid'
        ? successUrl(req, result.rows[0].order_code)
        : failureUrl(req, result.rows[0].order_code));
    }

    res.json({ ok: nextStatus === 'paid', order: result.rows[0] });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
