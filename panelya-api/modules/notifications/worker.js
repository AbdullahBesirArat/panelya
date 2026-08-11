'use strict';

const db = require('../../db');
const { generateToken, hashToken } = require('../cart/token');
const { getProvider, RESULT, RETRYABLE } = require('./providers');
const consent = require('./consent');

const EVENT_PURPOSE = { back_in_stock: 'stock_alert', price_drop: 'price_drop', favorite_update: 'favorite_update', subscription_opt_in: 'transactional' };
const BACKOFF_BASE_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function backoffSeconds(attempts, retryAfterSeconds) {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds, MAX_BACKOFF_SECONDS);
  return Math.min(BACKOFF_BASE_SECONDS * (2 ** Math.max(0, attempts - 1)), MAX_BACKOFF_SECONDS);
}

async function loadProductName(client, organizationId, productId) {
  if (!productId) return 'Ürün';
  const result = await client.query('select name from products where organization_id = $1 and id = $2', [organizationId, Number(productId)]);
  return result.rows[0] ? result.rows[0].name : 'Ürün';
}

const SUBJECTS = {
  back_in_stock: 'Beğendiğiniz ürün tekrar stokta',
  price_drop: 'Takip ettiğiniz üründe fiyat düştü',
  favorite_update: 'Favori ürününüzde güncelleme var',
  subscription_opt_in: 'Bildirim aboneliğinizi onaylayın',
};

// Build a channel message with user data safely encoded and (for marketing) a
// freshly rotated one-click unsubscribe token whose raw value lives only in the
// delivered message. Returns the message plus any subscription hash to persist.
async function buildMessage(client, row, siteUrl) {
  const productName = await loadProductName(client, row.organization_id, (row.payload || {}).product_id);
  const safeName = escapeHtml(productName);
  const subject = SUBJECTS[row.event_type] || 'Suvera bildirimi';
  let unsubToken = null;

  if (row.event_type === 'subscription_opt_in') {
    const confirmToken = (row.payload || {}).confirm_token || '';
    const confirmUrl = `${siteUrl}/tercihler?confirm=${encodeURIComponent(confirmToken)}`;
    return {
      message: {
        recipient: row.recipient_ref, subject,
        text: `${productName} bildirim aboneliğinizi onaylamak için: ${confirmUrl}`,
        html: `<p>${safeName} bildirim aboneliğinizi onaylayın:</p><p><a href="${escapeHtml(confirmUrl)}">Onayla</a></p>`,
      },
      unsubToken: null,
    };
  }

  if (row.subscription_id) {
    unsubToken = generateToken();
    await client.query(
      'update notification_subscriptions set unsubscribe_token_hash = $3, updated_at = now() where organization_id = $1 and id = $2',
      [row.organization_id, row.subscription_id, hashToken(unsubToken)]
    );
  }
  const unsubUrl = unsubToken ? `${siteUrl}/tercihler?unsub=${encodeURIComponent(unsubToken)}` : `${siteUrl}/tercihler`;
  const body = row.event_type === 'price_drop'
    ? `${productName} artık daha uygun fiyata.`
    : `${productName} tekrar stokta.`;
  return {
    message: {
      recipient: row.recipient_ref, subject,
      text: `${body} Aboneliği iptal: ${unsubUrl}`,
      html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(unsubUrl)}">Aboneliği iptal et</a></p>`,
    },
    unsubToken,
  };
}

async function recordDelivery(client, row, provider, result) {
  const now = new Date();
  await client.query(
    `insert into notification_deliveries
       (organization_id, outbox_id, provider, provider_message_id, status, response_metadata, attempted_at, delivered_at, failed_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [row.organization_id, row.id, provider, result.providerMessageId || null, result.status,
      JSON.stringify(result.metadata || {}), now,
      result.status === RESULT.SENT ? now : null,
      result.status === RESULT.SENT ? null : now]
  );
}

async function finalizeOutbox(client, row, result) {
  if (result.status === RESULT.SENT) {
    await client.query(
      "update notification_outbox set status = 'sent', sent_at = now(), updated_at = now(), locked_at = null, locked_by = null where organization_id = $1 and id = $2",
      [row.organization_id, row.id]
    );
    return 'sent';
  }
  const permanent = result.status === RESULT.PERMANENT || result.status === RESULT.INVALID;
  const exhausted = row.attempts >= row.max_attempts;
  if (permanent || exhausted) {
    await client.query(
      "update notification_outbox set status = 'dead', failed_at = now(), error_code = $3, updated_at = now(), locked_at = null, locked_by = null where organization_id = $1 and id = $2",
      [row.organization_id, row.id, result.status]
    );
    return 'dead';
  }
  const seconds = backoffSeconds(row.attempts, result.retryAfterSeconds);
  await client.query(
    "update notification_outbox set status = 'failed', error_code = $3, next_attempt_at = now() + make_interval(secs => $4), updated_at = now(), locked_at = null, locked_by = null where organization_id = $1 and id = $2",
    [row.organization_id, row.id, result.status, seconds]
  );
  return 'retry';
}

async function processNotificationOutbox({ maxRows = 25, workerId = `notify-${process.pid}`, siteUrl = process.env.PUBLIC_SITE_URL || '' } = {}) {
  const counts = { sent: 0, retry: 0, dead: 0, suppressed: 0 };
  for (let processed = 0; processed < maxRows; processed += 1) {
    // Atomic claim: two workers never take the same row (FOR UPDATE SKIP LOCKED).
    const claimed = await db.systemQuery(
      `update notification_outbox
          set status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = $1, updated_at = now()
        where id = (
          select id from notification_outbox
           where status in ('pending','failed') and next_attempt_at <= now()
           order by next_attempt_at, id for update skip locked limit 1
        )
        returning *`,
      [workerId]
    );
    const row = claimed.rows[0];
    if (!row) break;

    try {
      const outcome = await db.withTenantContext(row.organization_id, async (client) => {
        const purpose = EVENT_PURPOSE[row.event_type] || 'marketing';
        // Re-verify consent + suppression immediately before sending (may have been
        // revoked after the event was enqueued).
        const allowed = await consent.canSend(client, {
          organizationId: row.organization_id, channel: row.channel, targetHash: row.recipient_hash, purpose,
        });
        if (!allowed) {
          await client.query(
            "update notification_outbox set status = 'dead', error_code = 'suppressed', failed_at = now(), locked_at = null, locked_by = null, updated_at = now() where organization_id = $1 and id = $2",
            [row.organization_id, row.id]
          );
          return 'suppressed';
        }
        let provider;
        try {
          provider = getProvider(row.channel);
        } catch (error) {
          // Missing/unsupported provider is retryable so nothing is silently dropped.
          return finalizeOutbox(client, row, { status: RESULT.TEMPORARY, metadata: { error: error.code || 'provider_error' } });
        }
        const built = await buildMessage(client, row, siteUrl);
        const result = await provider.send(built.message);
        await recordDelivery(client, row, provider.name, result);
        return finalizeOutbox(client, row, result);
      });
      counts[outcome] = (counts[outcome] || 0) + 1;
    } catch (error) {
      // Unexpected failure: schedule a retry without losing the row.
      await db.systemQuery(
        "update notification_outbox set status = 'failed', error_code = 'worker_error', next_attempt_at = now() + make_interval(secs => $3), locked_at = null, locked_by = null, updated_at = now() where organization_id = $1 and id = $2",
        [row.organization_id, row.id, backoffSeconds(row.attempts)]
      );
      counts.retry += 1;
    }
  }
  return counts;
}

let notificationWorkerRunning = false;

// Single-flight scheduled run: never overlaps itself, swallows errors so the
// interval keeps ticking, and stays quiet on an empty outbox.
async function scheduleNotificationWorker() {
  if (notificationWorkerRunning) return;
  notificationWorkerRunning = true;
  try {
    await processNotificationOutbox({
      maxRows: Math.max(1, Math.min(Number(process.env.NOTIFICATION_OUTBOX_BATCH_SIZE) || 25, 200)),
    });
  } catch (error) {
    console.warn(`Bildirim outbox islenemedi: ${error.message}`);
  } finally {
    notificationWorkerRunning = false;
  }
}

function startNotificationOutboxWorker() {
  if (process.env.NODE_ENV === 'test' || process.env.NOTIFICATION_OUTBOX_WORKER_ENABLED === 'false') return null;
  const intervalMs = Math.max(2_000, Math.min(Number(process.env.NOTIFICATION_OUTBOX_INTERVAL_MS) || 15_000, 300_000));
  const startup = setTimeout(scheduleNotificationWorker, 1_500);
  startup.unref();
  const interval = setInterval(scheduleNotificationWorker, intervalMs);
  interval.unref();
  return interval;
}

module.exports = {
  processNotificationOutbox, escapeHtml, backoffSeconds,
  scheduleNotificationWorker, startNotificationOutboxWorker,
};
