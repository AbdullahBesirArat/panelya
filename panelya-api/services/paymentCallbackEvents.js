const db = require('../db');
const { auditLog } = require('./audit');
const { providerName, retrievePayment, successUrl, failureUrl } = require('./paymentProviders');
const { sendOrderStatusEmail } = require('./email');
const { syncStockForStatusChange } = require('./inventory');

const TERMINAL_STATUSES = ['paid', 'cancelled'];

function retryDelayMs(attempts) {
  const safeAttempts = Math.max(Number(attempts || 0), 1);
  return Math.min(60000 * safeAttempts, 15 * 60 * 1000);
}

// 'processing' durumunda takili kalmis (crash) event'lerin tekrar alinabilir
// sayilacagi esik. Bunun altindaki 'processing' event'ler TAZE kabul edilir ve
// baska worker tarafindan alinamaz (eszamanli cift islemeyi onler).
function staleClaimMinutes() {
  return Math.min(Math.max(Number(process.env.PAYMENT_CALLBACK_STALE_MINUTES || 10), 1), 240);
}

function firstPresent(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function callbackIdentityError() {
  const error = new Error('Odeme callback kimligi dogrulanamadi');
  error.status = 400;
  error.code = 'PAYMENT_CALLBACK_IDENTITY_REQUIRED';
  return error;
}

function verifiedOrganizationId(options = {}) {
  return firstPresent(options.verifiedOrganizationId);
}

function contextFromEventKey(eventKey) {
  const match = String(eventKey || '').match(/^[^|]+\|order:([^:]+):/);
  return match ? match[1] : '';
}

// Saglayicinin guvenilir islem referansindan idempotency anahtari uretir.
// Guvenilir event/callback id ilk siradadir; sonra payment token/reference,
// sonra da yalnizca server-side dogrulanmis organization context ile birlikte
// orderCode+status fallback kullanilir.
// Bos provider, bos referans veya eksik order/status ortak bir key uretmez.
function buildEventKey(payload = {}, options = {}) {
  const provider = String(payload.provider || '').trim().toLowerCase();
  if (!provider) return null;

  const providerEventId = firstPresent(
    payload.providerEventId,
    payload.provider_event_id,
    payload.eventId,
    payload.event_id,
    payload.callbackId,
    payload.callback_id
  );
  if (providerEventId) return `${provider}|event:${providerEventId}`;

  const paymentReference = firstPresent(
    payload.token,
    payload.paymentToken,
    payload.payment_token,
    payload.paymentReference,
    payload.payment_reference,
    payload.reference
  );
  if (paymentReference) return `${provider}|payment:${paymentReference}`;

  const organizationId = verifiedOrganizationId(options);
  const orderCode = firstPresent(payload.orderCode, payload.order_code);
  const status = firstPresent(payload.status, payload.requested_status).toLowerCase();
  if (!organizationId || !orderCode || !status) return null;

  const reference = `order:${organizationId}:${orderCode}:${status}`;
  return `${provider}|${reference}`;
}

async function resolveUniqueOrderScopeByToken(client, token) {
  const result = await client.query(
    `select id, organization_id, order_code
     from orders
     where payment_token = $1
     order by id asc
     limit 2`,
    [token]
  );

  if (result.rows.length !== 1) {
    throw Object.assign(new Error('Siparis bulunamadi'), { status: 404 });
  }

  return result.rows[0];
}

async function lockOrderForCallback(client, payload, options = {}) {
  const token = firstPresent(payload.token, payload.paymentToken, payload.payment_token);
  if (token) {
    const scope = await resolveUniqueOrderScopeByToken(client, token);
    const result = await client.query(
      'select * from orders where payment_token = $1 and organization_id = $2 limit 1 for update',
      [token, scope.organization_id]
    );
    return result.rows[0] || null;
  }

  const organizationId = verifiedOrganizationId(options);
  const orderCode = firstPresent(payload.orderCode, payload.order_code);
  if (!organizationId || !orderCode) {
    throw Object.assign(new Error('Siparis icin organizasyon baglami zorunlu'), { status: 400 });
  }

  const result = await client.query(
    'select * from orders where order_code = $1 and organization_id = $2 limit 1 for update',
    [orderCode, organizationId]
  );
  return result.rows[0] || null;
}

async function resolveReplayOrganizationId(client, row) {
  const payload = row?.payload || {};
  const token = firstPresent(payload.token, payload.paymentToken, payload.payment_token);
  if (token) {
    const scope = await resolveUniqueOrderScopeByToken(client, token);
    return scope.organization_id;
  }

  return contextFromEventKey(row?.event_key);
}

// Out-of-order koruma: terminal (paid/cancelled) bir durum, daha sonra gelen
// farkli/daha eski bir event ile GERI ALINMAZ.
function resolveTerminalGuardedStatus(currentStatus, proposedStatus) {
  if (TERMINAL_STATUSES.includes(currentStatus) && currentStatus !== proposedStatus) {
    return { status: currentStatus, guarded: true };
  }
  return { status: proposedStatus, guarded: false };
}

// Ayni callback iki kez gelirse yeni satir olusturmaz; event_key uzerindeki
// partial unique index sayesinde mevcut satiri dondurur (idempotent enqueue).
async function enqueuePaymentCallbackEvent(req, payload, store = db, options = {}) {
  const eventKey = buildEventKey(payload, options);
  if (!eventKey) throw callbackIdentityError();

  const params = [
    payload.provider,
    payload.orderCode || null,
    payload.token || null,
    payload.status || null,
    JSON.stringify(payload),
    req.ip || null,
    String(req.get('user-agent') || '').slice(0, 500),
    eventKey,
  ];

  const inserted = await store.query(
    `insert into payment_callback_events
     (provider, order_code, payment_token, requested_status, payload, source_ip, user_agent, event_key, next_retry_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, now())
     on conflict (event_key) where event_key is not null
     do nothing
     returning *`,
    params
  );

  if (inserted.rows[0]) return inserted.rows[0];

  // Cakisma: ayni event daha once kaydedilmis; mevcut satiri dondur.
  const existing = await store.query(
    'select * from payment_callback_events where event_key = $1 order by id desc limit 1',
    [eventKey]
  );
  return existing.rows[0] || null;
}

// Tek atomik UPDATE ile event'i claim eder. Ayni anda iki worker cagirirsa row
// lock nedeniyle yalnizca biri satiri eslestirip dondurur. Claim edilebilir:
//   - pending/failed ve retry zamani gelmis, VEYA
//   - stale 'processing' (esik suresini asmis).
// 'processed' ve TAZE 'processing' event'ler asla claim edilmez.
async function claimPaymentCallbackEvent(client, eventId, staleMinutes = staleClaimMinutes()) {
  const result = await client.query(
    `update payment_callback_events
     set processing_status = 'processing',
         attempts = attempts + 1,
         updated_at = now()
     where id = $1
       and (
         (processing_status in ('pending', 'failed') and coalesce(next_retry_at, now()) <= now())
         or (processing_status = 'processing' and updated_at < now() - ($2 || ' minutes')::interval)
       )
     returning *`,
    [eventId, String(staleMinutes)]
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

async function processPaymentCallbackEvent(req, eventId, deps = {}) {
  const {
    pool = db.pool,
    query = (text, params) => db.query(text, params),
    syncStock = syncStockForStatusChange,
    retrieve = retrievePayment,
    sendEmail = sendOrderStatusEmail,
    audit = auditLog,
    resolveProvider = providerName,
    buildSuccessUrl = successUrl,
    buildFailureUrl = failureUrl,
    staleMinutes = staleClaimMinutes(),
    verifiedOrganizationId: explicitVerifiedOrganizationId = null,
  } = deps;

  const client = await pool.connect();
  let claimedEvent = null;
  try {
    await client.query('begin');
    const event = await claimPaymentCallbackEvent(client, eventId, staleMinutes);
    claimedEvent = event;

    if (!event) {
      // Claim edilemedi: zaten islenmis / taze processing / retry beklemede.
      const existing = await client.query(
        'select * from payment_callback_events where id = $1 limit 1',
        [eventId]
      );
      const row = existing.rows[0] || null;
      let replay = row;

      // Idempotent replay: islenmis event icin depolanan sonucu guvenle dondur.
      if (row && row.processing_status === 'processed' && row.processed_order_id) {
        const organizationId = await resolveReplayOrganizationId(client, row).catch(() => '');
        if (organizationId) {
          const orderRes = await client.query(
            'select * from orders where id = $1 and organization_id = $2 limit 1',
            [row.processed_order_id, organizationId]
          );
          const order = orderRes.rows[0];
          const paid = row.result_status === 'paid';
          replay = order
            ? {
              ...row,
              order,
              ok: paid,
              redirectUrl: paid ? buildSuccessUrl(req, order.order_code) : buildFailureUrl(req, order.order_code),
              idempotentReplay: true,
            }
            : { ...row, ok: paid, idempotentReplay: true };
        } else {
          replay = { ...row, ok: row.result_status === 'paid', idempotentReplay: true };
        }
      }
      await client.query('commit');
      return replay;
    }

    const payload = event.payload || {};
    const eventVerifiedOrganizationId = explicitVerifiedOrganizationId || contextFromEventKey(event.event_key);
    const callbackContext = { verifiedOrganizationId: eventVerifiedOrganizationId };
    if (!buildEventKey(payload, callbackContext)) throw callbackIdentityError();

    const provider = payload.provider || resolveProvider();
    let proposedStatus = provider === 'mock' && payload.status === 'paid' ? 'paid' : 'cancelled';
    let paymentId = null;
    let paymentError = null;

    if (payload.token && provider === 'iyzico') {
      const orderPreview = await resolveUniqueOrderScopeByToken(client, payload.token);

      const payment = await retrieve({
        token: payload.token,
        conversationId: orderPreview.order_code,
      });
      proposedStatus = payment.status === 'success' && payment.paymentStatus === 'SUCCESS' ? 'paid' : 'cancelled';
      paymentId = payment.paymentId || null;
      paymentError = payment.errorMessage || null;
    }

    const currentOrder = await lockOrderForCallback(client, payload, callbackContext);
    if (!currentOrder) {
      throw Object.assign(new Error('Siparis bulunamadi'), { status: 404 });
    }

    const currentStatus = currentOrder.status;

    // Out-of-order/terminal koruma: paid/cancelled geri alinmaz.
    const guard = resolveTerminalGuardedStatus(currentStatus, proposedStatus);
    const nextStatus = guard.status;
    if (guard.guarded) {
      paymentError = paymentError || `Final durum korunuyor: ${currentStatus}`;
    }

    // Stok hareketi yalnizca gercek bir durum gecisinde (aynen onceki davranis:
    // syncStockForStatusChange previousStatus===nextStatus'ta erken doner) ve
    // event tek kez islendigi icin (idempotency) iki kez calismaz.
    await syncStock(client, currentOrder.id, currentStatus, nextStatus, {
      organizationId: currentOrder.organization_id,
    });

    const updatedOrder = await client.query(
      `update orders
       set status = $1,
           payment_id = coalesce($2, payment_id),
           payment_error = $3,
           updated_at = now()
       where id = $4
         and organization_id = $5
       returning *`,
      [nextStatus, paymentId, paymentError, currentOrder.id, currentOrder.organization_id]
    );

    const finalizedEvent = await finalizeEvent(client, event.id, {
      processing_status: 'processed',
      processed_order_id: currentOrder.id,
      result_status: nextStatus,
      last_error: paymentError,
      last_processed_at: new Date().toISOString(),
      next_retry_at: null,
    });

    await audit(req, {
      action: 'PAYMENT_CALLBACK',
      resourceType: 'order',
      resourceId: currentOrder.id,
      oldValue: { status: currentOrder.status, callbackEventId: event.id },
      newValue: { status: nextStatus, provider, paymentId, paymentError, callbackEventId: event.id },
      success: nextStatus === 'paid',
      errorMessage: paymentError,
    });

    await client.query('commit');

    const customerResult = await query(
      `select id, name, email
       from customers
       where id = $1
       limit 1`,
      [updatedOrder.rows[0].customer_id]
    );
    await sendEmail(updatedOrder.rows[0], customerResult.rows[0]).catch((error) => {
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
        ? buildSuccessUrl(req, updatedOrder.rows[0].order_code)
        : buildFailureUrl(req, updatedOrder.rows[0].order_code),
    };
  } catch (error) {
    await client.query('rollback');

    // Rollback sonrasi event'i (ayri baglantida) retry edilebilir 'failed' olarak
    // neden bilgisiyle isaretle. Ham payload/token/imza loglanmaz.
    await finalizeEvent({ query }, eventId, {
      processing_status: 'failed',
      last_error: String(error.message || error).slice(0, 1000),
      last_processed_at: new Date().toISOString(),
      next_retry_at: new Date(Date.now() + retryDelayMs(claimedEvent?.attempts)).toISOString(),
    }).catch(() => {});

    throw error;
  } finally {
    client.release();
  }
}

async function processPendingPaymentCallbackEvents(limit = 20, deps = {}) {
  const { query = (text, params) => db.query(text, params), staleMinutes = staleClaimMinutes() } = deps;

  const result = await query(
    `select id
     from payment_callback_events
     where (processing_status in ('pending', 'failed') and coalesce(next_retry_at, now()) <= now())
        or (processing_status = 'processing' and updated_at < now() - ($2 || ' minutes')::interval)
     order by created_at asc
     limit $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100), String(staleMinutes)]
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
      const outcome = await processPaymentCallbackEvent(fakeReq, row.id, deps);
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
  claimPaymentCallbackEvent,
  buildEventKey,
  lockOrderForCallback,
  resolveTerminalGuardedStatus,
  staleClaimMinutes,
};
