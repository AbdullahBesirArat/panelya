const db = require('../db');
const { auditLog } = require('./audit');
const { providerName, retrievePayment, successUrl, failureUrl } = require('./paymentProviders');
const { sendOrderStatusEmail } = require('./email');
const { syncStockForStatusChange } = require('./inventory');

function retryDelayMs(attempts) {
  const safeAttempts = Math.max(Number(attempts || 0), 1);
  return Math.min(60000 * safeAttempts, 15 * 60 * 1000);
}

async function enqueuePaymentCallbackEvent(req, payload) {
  const result = await db.query(
    `insert into payment_callback_events
     (provider, order_code, payment_token, requested_status, payload, source_ip, user_agent, next_retry_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
     returning *`,
    [
      payload.provider,
      payload.orderCode || null,
      payload.token || null,
      payload.status || null,
      JSON.stringify(payload),
      req.ip || null,
      String(req.get('user-agent') || '').slice(0, 500),
    ]
  );

  return result.rows[0];
}

async function claimPaymentCallbackEvent(client, eventId) {
  const result = await client.query(
    `update payment_callback_events
     set processing_status = 'processing',
         attempts = attempts + 1,
         updated_at = now()
     where id = $1
       and processing_status in ('pending', 'failed')
       and coalesce(next_retry_at, now()) <= now()
     returning *`,
    [eventId]
  );

  return result.rows[0] || null;
}

async function finalizeEvent(client, eventId, values) {
  const fields = [];
  const params = [];

  Object.entries(values).forEach(([key, value]) => {
    params.push(value);
    fields.push(`${key} = $${params.length}`);
  });

  params.push(eventId);
  const result = await client.query(
    `update payment_callback_events
     set ${fields.join(', ')}, updated_at = now()
     where id = $${params.length}
     returning *`,
    params
  );
  return result.rows[0];
}

async function processPaymentCallbackEvent(req, eventId) {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const event = await claimPaymentCallbackEvent(client, eventId);

    if (!event) {
      const existing = await client.query(
        'select * from payment_callback_events where id = $1 limit 1',
        [eventId]
      );
      await client.query('commit');
      return existing.rows[0] || null;
    }

    const payload = event.payload || {};
    const provider = payload.provider || providerName();
    let nextStatus = provider === 'mock' && payload.status === 'paid' ? 'paid' : 'cancelled';
    let paymentId = null;
    let paymentError = null;

    if (payload.token && provider === 'iyzico') {
      const orderPreview = await client.query(
        'select order_code from orders where payment_token = $1 limit 1',
        [payload.token]
      );
      if (!orderPreview.rows[0]) {
        throw Object.assign(new Error('Siparis bulunamadi'), { status: 404 });
      }

      const payment = await retrievePayment({
        token: payload.token,
        conversationId: orderPreview.rows[0].order_code,
      });
      nextStatus = payment.status === 'success' && payment.paymentStatus === 'SUCCESS' ? 'paid' : 'cancelled';
      paymentId = payment.paymentId || null;
      paymentError = payment.errorMessage || null;
    }

    const orderResult = payload.token
      ? await client.query('select * from orders where payment_token = $1 limit 1 for update', [payload.token])
      : await client.query('select * from orders where order_code = $1 limit 1 for update', [payload.orderCode]);

    if (!orderResult.rows[0]) {
      throw Object.assign(new Error('Siparis bulunamadi'), { status: 404 });
    }

    const currentOrder = orderResult.rows[0];
    const currentStatus = currentOrder.status;

    if (['paid', 'cancelled'].includes(currentStatus) && currentStatus !== nextStatus) {
      nextStatus = currentStatus;
      paymentError = paymentError || `Final durum korunuyor: ${currentStatus}`;
    }

    await syncStockForStatusChange(client, currentOrder.id, currentStatus, nextStatus, {
      organizationId: currentOrder.organization_id,
    });

    const updatedOrder = await client.query(
      `update orders
       set status = $1,
           payment_id = coalesce($2, payment_id),
           payment_error = $3,
           updated_at = now()
       where id = $4
       returning *`,
      [nextStatus, paymentId, paymentError, currentOrder.id]
    );

    const finalizedEvent = await finalizeEvent(client, event.id, {
      processing_status: 'processed',
      processed_order_id: currentOrder.id,
      result_status: nextStatus,
      last_error: paymentError,
      last_processed_at: new Date().toISOString(),
      next_retry_at: null,
    });

    await auditLog(req, {
      action: 'PAYMENT_CALLBACK',
      resourceType: 'order',
      resourceId: currentOrder.id,
      oldValue: { status: currentOrder.status, callbackEventId: event.id },
      newValue: { status: nextStatus, provider, paymentId, paymentError, callbackEventId: event.id },
      success: nextStatus === 'paid',
      errorMessage: paymentError,
    });

    await client.query('commit');

    const customerResult = await db.query(
      `select id, name, email
       from customers
       where id = $1
       limit 1`,
      [updatedOrder.rows[0].customer_id]
    );
    await sendOrderStatusEmail(updatedOrder.rows[0], customerResult.rows[0]).catch((error) => {
      console.warn('Order status email gonderilemedi', {
        orderCode: updatedOrder.rows[0].order_code,
        message: error.message,
      });
    });

    return {
      ...finalizedEvent,
      order: updatedOrder.rows[0],
      ok: nextStatus === 'paid',
      redirectUrl: nextStatus === 'paid'
        ? successUrl(req, updatedOrder.rows[0].order_code)
        : failureUrl(req, updatedOrder.rows[0].order_code),
    };
  } catch (error) {
    await client.query('rollback');

    await finalizeEvent(db, eventId, {
      processing_status: 'failed',
      last_error: String(error.message || error).slice(0, 1000),
      last_processed_at: new Date().toISOString(),
      next_retry_at: new Date(Date.now() + retryDelayMs(1)).toISOString(),
    }).catch(() => {});

    throw error;
  } finally {
    client.release();
  }
}

async function processPendingPaymentCallbackEvents(limit = 20) {
  const result = await db.query(
    `select id
     from payment_callback_events
     where processing_status in ('pending', 'failed')
       and coalesce(next_retry_at, now()) <= now()
     order by created_at asc
     limit $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)]
  );

  const processed = [];
  for (const row of result.rows) {
    try {
      const fakeReq = {
        ip: null,
        get() { return ''; },
        auth: null,
        admin: null,
        is() { return false; },
      };
      const outcome = await processPaymentCallbackEvent(fakeReq, row.id);
      processed.push({ id: row.id, status: outcome?.processing_status || 'unknown' });
    } catch (error) {
      processed.push({ id: row.id, status: 'failed', error: error.message });
    }
  }

  return processed;
}

module.exports = {
  enqueuePaymentCallbackEvent,
  processPaymentCallbackEvent,
  processPendingPaymentCallbackEvents,
};
