const db = require('../db');
const { auditLog } = require('./audit');
const { providerName, retrievePayment, successUrl, failureUrl } = require('./paymentProviders');
const { sendOrderStatusEmail } = require('./email');
const { transitionOrderInventory } = require('./inventoryReservations');
const { transitionOrderPromotion } = require('./promotionEngine');
const { amountInKurus, decimalAmount, paymentIdentityMismatch, recordCardEvidence } = require('./paymentEvidence');

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
    if (scope.organization_id !== verifiedOrganizationId(options)) return null;
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
  const organizationId = verifiedOrganizationId(options);
  if (!organizationId) throw callbackIdentityError();

  const params = [
    organizationId,
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
     (organization_id, provider, order_code, payment_token, requested_status, payload, source_ip, user_agent, event_key, next_retry_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
     on conflict (event_key) where event_key is not null
     do nothing
     returning *`,
    params
  );

  if (inserted.rows[0]) return inserted.rows[0];

  // Cakisma: ayni event daha once kaydedilmis; mevcut satiri dondur.
  const existing = await store.query(
    'select * from payment_callback_events where event_key = $1 and organization_id = $2 order by id desc limit 1',
    [eventKey, organizationId]
  );
  return existing.rows[0] || null;
}

// Tek atomik UPDATE ile event'i claim eder. Ayni anda iki worker cagirirsa row
// lock nedeniyle yalnizca biri satiri eslestirip dondurur. Claim edilebilir:
//   - pending/failed ve retry zamani gelmis, VEYA
//   - stale 'processing' (esik suresini asmis).
// 'processed' ve TAZE 'processing' event'ler asla claim edilmez.
async function claimPaymentCallbackEvent(client, eventId, organizationId, staleMinutes = staleClaimMinutes()) {
  const result = await client.query(
    `update payment_callback_events
     set processing_status = 'processing',
         attempts = attempts + 1,
         updated_at = now()
     where id = $1
       and organization_id = $2
       and (
         (processing_status in ('pending', 'failed') and coalesce(next_retry_at, now()) <= now())
         or (processing_status = 'processing' and updated_at < now() - ($3 || ' minutes')::interval)
       )
     returning *`,
    [eventId, organizationId, String(staleMinutes)]
  );

  return result.rows[0] || null;
}

async function finalizeEvent(client, eventId, values, organizationId) {
  const fields = [];
  const params = [];

  Object.entries(values).forEach(([key, value]) => {
    params.push(value);
    fields.push(`${key} = $${params.length}`);
  });

  params.push(eventId);
  params.push(organizationId);
  const result = await client.query(
    `update payment_callback_events
     set ${fields.join(', ')}, updated_at = now()
     where id = $${params.length - 1}
       and organization_id = $${params.length}
       ${values.processing_status === 'failed' ? "and processing_status <> 'processed'" : ''}
     returning *`,
    params
  );
  return result.rows[0];
}

async function processPaymentCallbackEvent(req, eventId, deps = {}) {
  const {
    pool = db.getSystemPool(),
    query = (text, params) => db.systemQuery(text, params),
    syncStock = transitionOrderInventory,
    retrieve = retrievePayment,
    sendEmail = sendOrderStatusEmail,
    audit = auditLog,
    resolveProvider = providerName,
    buildSuccessUrl = successUrl,
    buildFailureUrl = failureUrl,
    staleMinutes = staleClaimMinutes(),
    verifiedOrganizationId: explicitVerifiedOrganizationId = null,
  } = deps;
  const syncPromotion = deps.syncPromotion
    || (deps.syncStock ? async () => ({ changed: false }) : transitionOrderPromotion);

  const organizationId = verifiedOrganizationId({ verifiedOrganizationId: explicitVerifiedOrganizationId });
  if (!organizationId) throw callbackIdentityError();
  let client = await pool.connect();
  let claimedEvent = null;
  try {
    await client.query('begin');
    await db.setTenantContext(client, organizationId);
    const event = await claimPaymentCallbackEvent(client, eventId, organizationId, staleMinutes);
    claimedEvent = event;

    if (!event) {
      // Claim edilemedi: zaten islenmis / taze processing / retry beklemede.
      const existing = await client.query(
        'select * from payment_callback_events where id = $1 and organization_id = $2 limit 1',
        [eventId, organizationId]
      );
      const row = existing.rows[0] || null;
      let replay = row;

      // Idempotent replay: islenmis event icin depolanan sonucu guvenle dondur.
      if (row && row.processing_status === 'processed' && row.processed_order_id) {
        const replayOrganizationId = await resolveReplayOrganizationId(client, row).catch(() => '');
        if (replayOrganizationId === organizationId) {
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
        const caseId = /^reconciliation_case:(\d+)$/.exec(row.last_error || '')?.[1];
        if (caseId) replay.reconciliationCaseId = caseId;
      }
      await client.query('commit');
      return replay;
    }

    const payload = event.payload || {};
    const eventVerifiedOrganizationId = organizationId || contextFromEventKey(event.event_key);
    const callbackContext = { verifiedOrganizationId: eventVerifiedOrganizationId };
    if (!buildEventKey(payload, callbackContext)) throw callbackIdentityError();

    const provider = payload.provider || resolveProvider();
    let proposedStatus = provider === 'mock' && payload.status === 'paid' ? 'paid' : 'cancelled';
    let paymentId = null;
    let paymentError = null;
    let verifiedPayment = null;

    if (payload.token && provider === 'iyzico') {
      const orderPreview = await resolveUniqueOrderScopeByToken(client, payload.token);
      if (orderPreview.organization_id !== organizationId) {
        throw Object.assign(new Error('Siparis bulunamadi'), { status: 404 });
      }

      const payment = await retrieve({
        token: payload.token,
        conversationId: orderPreview.order_code,
      });
      proposedStatus = payment.status === 'success' && payment.paymentStatus === 'SUCCESS' ? 'paid' : 'cancelled';
      if (proposedStatus === 'paid') verifiedPayment = payment;
      paymentId = payment.paymentId || null;
      paymentError = payment.errorMessage ? 'PAYMENT_PROVIDER_REJECTED' : null;
    }

    const currentOrder = await lockOrderForCallback(client, payload, callbackContext);
    if (!currentOrder) {
      throw Object.assign(new Error('Siparis bulunamadi'), { status: 404 });
    }

    const currentStatus = currentOrder.status;
    if (verifiedPayment) {
      paymentId = firstPresent(verifiedPayment.paymentId);
      if (!paymentId) throw new Error('Dogrulanmis odeme icin saglayici odeme kimligi eksik');
      const amount = amountInKurus(verifiedPayment.paidPrice);
      const currency = verifiedPayment.currency;
      const validAmount = amount !== null && amount > 0n;
      const validCurrency = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
      const matches = validAmount && amount === amountInKurus(currentOrder.total)
        && validCurrency && currency === currentOrder.currency;
      const late = currentStatus === 'cancelled';
      const evidence = matches
        ? await recordCardEvidence(client, {
          order: currentOrder, event, provider, paymentId, amount: decimalAmount(amount), currency,
        })
        : null;
      if (!matches || late) {
        const reconciliationCase = await recordLatePayment(client, req, audit, currentOrder, event, {
          provider, paymentId, token: payload.token,
          amount: validAmount ? decimalAmount(amount) : null,
          currency: validCurrency ? currency : null,
          caseType: matches ? 'paid_on_cancelled_order' : 'provider_amount_mismatch',
          evidenceId: evidence?.id ?? null,
        });
        const reconciliationCaseId = reconciliationCase.id;
        let order = currentOrder;
        if (matches && !reconciliationCase.existing) {
          // Retain the legacy late-payment metadata without running stock or promotion transitions.
          order = await updateCallbackOrder(client, currentOrder, currentStatus, paymentId,
            `Final durum korunuyor: ${currentStatus}`);
        }
        const processed = await finalizeEvent(client, event.id, {
          processing_status: 'processed',
          processed_order_id: currentOrder.id,
          result_status: matches ? currentStatus : 'provider_amount_mismatch',
          last_error: `reconciliation_case:${reconciliationCaseId}`,
          last_processed_at: new Date().toISOString(),
          next_retry_at: null,
        }, organizationId);
        await client.query('commit');
        return {
          ...processed, reconciliationCaseId, order, ok: false,
          redirectUrl: buildFailureUrl(req, currentOrder.order_code),
          ...(reconciliationCase.existing && { idempotentReplay: true }),
        };
      }
      if (evidence.replay && currentStatus === 'paid') {
        const processed = await finalizeEvent(client, event.id, {
          processing_status: 'processed',
          processed_order_id: currentOrder.id,
          result_status: 'paid',
          last_error: null,
          last_processed_at: new Date().toISOString(),
          next_retry_at: null,
        }, organizationId);
        await client.query('commit');
        return {
          ...processed, order: currentOrder, ok: true,
          redirectUrl: buildSuccessUrl(req, currentOrder.order_code),
          idempotentReplay: true,
        };
      }
    }

    // Out-of-order/terminal koruma: paid/cancelled geri alinmaz.
    const guard = resolveTerminalGuardedStatus(currentStatus, proposedStatus);
    const nextStatus = guard.status;
    if (guard.guarded) {
      paymentError = paymentError || `Final durum korunuyor: ${currentStatus}`;
    }

    // Reservation transition is itself idempotent. Duplicate callbacks cannot
    // consume or release inventory more than once.
    await syncStock(client, currentOrder.id, currentStatus, nextStatus, {
      organizationId: currentOrder.organization_id,
    });
    await syncPromotion(client, currentOrder.id, currentStatus, nextStatus, {
      organizationId: currentOrder.organization_id,
    });

    const updatedOrder = await updateCallbackOrder(client, currentOrder, nextStatus, paymentId, paymentError);

    const finalizedEvent = await finalizeEvent(client, event.id, {
      processing_status: 'processed',
      processed_order_id: currentOrder.id,
      result_status: nextStatus,
      last_error: paymentError,
      last_processed_at: new Date().toISOString(),
      next_retry_at: null,
    }, organizationId);

    await audit({ auth: req.auth, admin: req.admin, get() { return ''; } }, {
      action: 'PAYMENT_CALLBACK',
      resourceType: 'order',
      resourceId: currentOrder.id,
      oldValue: { status: currentOrder.status, callbackEventId: event.id },
      newValue: { status: nextStatus, provider, callbackEventId: event.id },
      success: nextStatus === 'paid',
    });

    await client.query('commit');
    client.release();
    client = null;

    const customerResult = await query(
      `select id, name, email
       from customers
       where id = $1 and organization_id = $2
       limit 1`,
      [updatedOrder.customer_id, organizationId]
    );
    await sendEmail(updatedOrder, customerResult.rows[0]).catch(() => {
      console.warn('Order status email gonderilemedi');
    });

    return {
      ...finalizedEvent,
      order: updatedOrder,
      ok: nextStatus === 'paid',
      redirectUrl: nextStatus === 'paid'
        ? buildSuccessUrl(req, updatedOrder.order_code)
        : buildFailureUrl(req, updatedOrder.order_code),
    };
  } catch (error) {
    if (!client) throw error;
    let rollbackError;
    try { await client.query('rollback'); }
    catch (err) { rollbackError = err; }
    client.release(rollbackError);
    client = null;

    // Rollback sonrasi event'i (ayri baglantida) retry edilebilir 'failed' olarak
    // neden bilgisiyle isaretle. Ham payload/token/imza loglanmaz.
    await finalizeEvent({ query }, eventId, {
      processing_status: 'failed',
      last_error: error.code === 'PAYMENT_ID_ORDER_MISMATCH'
        ? error.code
        : 'PAYMENT_CALLBACK_PROCESSING_FAILED',
      last_processed_at: new Date().toISOString(),
      next_retry_at: new Date(Date.now() + retryDelayMs(claimedEvent?.attempts)).toISOString(),
    }, organizationId).catch(() => {});

    throw error;
  } finally {
    if (client) client.release();
  }
}

async function updateCallbackOrder(client, order, status, paymentId, paymentError) {
  const { rows: [updated] } = await client.query(
    `update orders
     set status = $1,
         payment_id = coalesce($2, payment_id),
         payment_error = $3,
         updated_at = now()
     where id = $4 and organization_id = $5
     returning *`,
    [status, paymentId, paymentError, order.id, order.organization_id]
  );
  return updated;
}

async function recordLatePayment(client, req, audit, order, event, {
  provider, paymentId, token, amount, currency, caseType, evidenceId,
}) {
  const identity = [order.organization_id, provider, paymentId, caseType];
  const { rows: [created] } = await client.query(
    `insert into payment_reconciliation_cases
       (organization_id, provider, provider_payment_id, case_type, order_id, callback_event_id,
        payment_token, provider_paid_amount, currency, order_total, order_status_at_detection, evidence_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (organization_id, provider, provider_payment_id, case_type) do nothing
     returning id`,
    [...identity, order.id, event.id, token, amount, currency, order.total, order.status, evidenceId]
  );
  if (!created) {
    const { rows: [existing] } = await client.query(
      `select id, organization_id, order_id from payment_reconciliation_cases
        where organization_id = $1 and provider = $2 and provider_payment_id = $3 and case_type = $4`,
      identity
    );
    if (existing?.organization_id !== order.organization_id || existing?.order_id !== order.id) {
      throw paymentIdentityMismatch();
    }
    return { id: existing.id, existing: true };
  }
  await audit({ auth: req.auth, get() { return ''; } }, {
    action: 'PAYMENT_RECONCILIATION_REQUIRED',
    actorType: 'app',
    organizationId: order.organization_id,
    resourceType: 'payment_reconciliation_case',
    resourceId: created.id,
    newValue: { orderId: order.id, callbackEventId: event.id, caseType, evidenceId },
    store: client,
    throwOnError: true,
  });
  return { id: created.id, existing: false };
}

async function processPendingPaymentCallbackEvents(limit = 20, deps = {}) {
  const { query = (text, params) => db.systemQuery(text, params), staleMinutes = staleClaimMinutes() } = deps;

  const result = await query(
    `select id, organization_id
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
      const outcome = await processPaymentCallbackEvent(fakeReq, row.id, {
        ...deps,
        verifiedOrganizationId: row.organization_id,
      });
      processed.push({ id: row.id, status: outcome?.processing_status || 'unknown' });
    } catch (error) {
      const reason = error.code === 'PAYMENT_ID_ORDER_MISMATCH' ? error.code : 'PAYMENT_CALLBACK_PROCESSING_FAILED';
      processed.push({ id: row.id, status: 'failed', error: reason });
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
