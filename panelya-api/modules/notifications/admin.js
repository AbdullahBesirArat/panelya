'use strict';

// Admin/operations reads and controls for A23. Every recipient is masked before it
// leaves the database — the admin surface never exposes a raw email/phone. There is
// deliberately no "send to everyone" primitive here (spec: do not make bulk spam easy);
// admins can only retry existing outbox rows and suppress recipients.
const { maskRecipient } = require('./identity');
const { CHANNELS, suppressChannel, resolveTargetHash } = require('./consent');
const { configuredProviderName } = require('./providers');

function clampPage(value, fallback, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function paginate(req) {
  const pageSize = clampPage(req.pageSize, 25, 100);
  const page = clampPage(req.page, 1, 100000);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Aggregate dashboard counts for the notifications/consent overview screen.
async function overview(client, { organizationId }) {
  const [consents, subscriptions, outbox, deliveries, suppressions] = await Promise.all([
    client.query(
      `select channel, purpose, status, count(*)::int as count
         from communication_consents where organization_id = $1
        group by channel, purpose, status`,
      [organizationId]
    ),
    client.query(
      `select subscription_type, channel, status, count(*)::int as count
         from notification_subscriptions where organization_id = $1
        group by subscription_type, channel, status`,
      [organizationId]
    ),
    client.query(
      `select status, count(*)::int as count
         from notification_outbox where organization_id = $1 group by status`,
      [organizationId]
    ),
    client.query(
      `select status, count(*)::int as count
         from notification_deliveries where organization_id = $1
          and attempted_at > now() - interval '30 days'
        group by status`,
      [organizationId]
    ),
    client.query(
      `select channel, count(*)::int as count
         from communication_suppressions where organization_id = $1
          and (expires_at is null or expires_at > now())
        group by channel`,
      [organizationId]
    ),
  ]);
  return {
    consents: consents.rows,
    subscriptions: subscriptions.rows,
    outbox: outbox.rows,
    deliveries: deliveries.rows,
    suppressions: suppressions.rows,
  };
}

async function listOutbox(client, { organizationId, status = '', eventType = '', channel = '', page, pageSize }) {
  const pager = paginate({ page, pageSize });
  const params = [organizationId];
  const conditions = ['organization_id = $1'];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (eventType) { params.push(eventType); conditions.push(`event_type = $${params.length}`); }
  if (channel) { params.push(channel); conditions.push(`channel = $${params.length}`); }
  params.push(pager.pageSize, pager.offset);
  const result = await client.query(
    `select id, event_type, channel, provider, recipient_ref, status, attempts, max_attempts,
            next_attempt_at, sent_at, failed_at, error_code, created_at, updated_at
       from notification_outbox
      where ${conditions.join(' and ')}
      order by created_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return {
    items: result.rows.map((row) => ({
      id: Number(row.id),
      event_type: row.event_type,
      channel: row.channel,
      provider: row.provider,
      recipient_masked: maskRecipient(row.channel, row.recipient_ref),
      status: row.status,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      next_attempt_at: row.next_attempt_at,
      sent_at: row.sent_at,
      failed_at: row.failed_at,
      error_code: row.error_code,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    page: pager.page,
    pageSize: pager.pageSize,
  };
}

// Delivery attempts history, recipient masked via a join back to the outbox channel.
async function listDeliveries(client, { organizationId, status = '', page, pageSize }) {
  const pager = paginate({ page, pageSize });
  const params = [organizationId];
  const conditions = ['d.organization_id = $1'];
  if (status) { params.push(status); conditions.push(`d.status = $${params.length}`); }
  params.push(pager.pageSize, pager.offset);
  const result = await client.query(
    `select d.id, d.outbox_id, d.provider, d.provider_message_id, d.status,
            d.attempted_at, d.delivered_at, d.failed_at,
            o.channel, o.recipient_ref, o.event_type
       from notification_deliveries d
       join notification_outbox o on o.organization_id = d.organization_id and o.id = d.outbox_id
      where ${conditions.join(' and ')}
      order by d.attempted_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return {
    items: result.rows.map((row) => ({
      id: Number(row.id),
      outbox_id: Number(row.outbox_id),
      provider: row.provider,
      provider_message_id: row.provider_message_id,
      status: row.status,
      channel: row.channel,
      event_type: row.event_type,
      recipient_masked: maskRecipient(row.channel, row.recipient_ref),
      attempted_at: row.attempted_at,
      delivered_at: row.delivered_at,
      failed_at: row.failed_at,
    })),
    page: pager.page,
    pageSize: pager.pageSize,
  };
}

async function listFailed(client, { organizationId, page, pageSize }) {
  const pager = paginate({ page, pageSize });
  const result = await client.query(
    `select id, event_type, channel, provider, recipient_ref, status, attempts, max_attempts,
            error_code, failed_at, updated_at
       from notification_outbox
      where organization_id = $1 and status in ('failed','dead')
      order by updated_at desc
      limit $2 offset $3`,
    [organizationId, pager.pageSize, pager.offset]
  );
  return {
    items: result.rows.map((row) => ({
      id: Number(row.id),
      event_type: row.event_type,
      channel: row.channel,
      provider: row.provider,
      recipient_masked: maskRecipient(row.channel, row.recipient_ref),
      status: row.status,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      error_code: row.error_code,
      failed_at: row.failed_at,
      updated_at: row.updated_at,
    })),
    page: pager.page,
    pageSize: pager.pageSize,
  };
}

async function listSubscriptions(client, { organizationId, subscriptionType = '', status = '', page, pageSize }) {
  const pager = paginate({ page, pageSize });
  const params = [organizationId];
  const conditions = ['organization_id = $1'];
  if (subscriptionType) { params.push(subscriptionType); conditions.push(`subscription_type = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  params.push(pager.pageSize, pager.offset);
  const result = await client.query(
    `select id, subscription_type, channel, product_id, variant_id, status,
            contact_email, contact_phone, baseline_price, last_notified_at, created_at
       from notification_subscriptions
      where ${conditions.join(' and ')}
      order by created_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return {
    items: result.rows.map((row) => ({
      id: Number(row.id),
      subscription_type: row.subscription_type,
      channel: row.channel,
      product_id: row.product_id != null ? Number(row.product_id) : null,
      variant_id: row.variant_id != null ? Number(row.variant_id) : null,
      status: row.status,
      recipient_masked: maskRecipient(row.channel, row.channel === 'email' ? row.contact_email : row.contact_phone),
      baseline_price: row.baseline_price != null ? Number(row.baseline_price) : null,
      last_notified_at: row.last_notified_at,
      created_at: row.created_at,
    })),
    page: pager.page,
    pageSize: pager.pageSize,
  };
}

async function listSuppressions(client, { organizationId, page, pageSize }) {
  const pager = paginate({ page, pageSize });
  const result = await client.query(
    `select id, channel, reason, source, created_at, expires_at
       from communication_suppressions
      where organization_id = $1 and (expires_at is null or expires_at > now())
      order by created_at desc
      limit $2 offset $3`,
    [organizationId, pager.pageSize, pager.offset]
  );
  return {
    items: result.rows.map((row) => ({
      id: Number(row.id),
      channel: row.channel,
      reason: row.reason,
      source: row.source,
      created_at: row.created_at,
      expires_at: row.expires_at,
    })),
    page: pager.page,
    pageSize: pager.pageSize,
  };
}

// Requeue a failed/dead outbox row. Attempts are preserved for audit, but the ceiling
// is raised so the worker will actually pick it up again; consent/suppression is still
// re-checked at send time, so a retry can never bypass an opt-out.
async function retryOutbox(client, { organizationId, outboxId }) {
  const result = await client.query(
    `update notification_outbox
        set status = 'pending', next_attempt_at = now(), error_code = null,
            max_attempts = greatest(max_attempts, attempts + 3),
            locked_at = null, locked_by = null, updated_at = now()
      where organization_id = $1 and id = $2 and status in ('failed','dead')
      returning id, status, attempts, max_attempts`,
    [organizationId, Number(outboxId)]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error('Yeniden denenecek bildirim bulunamadi'), { code: 'OUTBOX_NOT_RETRYABLE', status: 404 });
  }
  return { id: Number(result.rows[0].id), status: result.rows[0].status };
}

// Manually suppress a recipient channel. Admin supplies the contact (from an order,
// a bounce report); we hash it and never persist the raw value in the suppression.
async function manualSuppress(client, { organizationId, channel, email = '', phone = '', reason = 'manual' }) {
  if (!CHANNELS.includes(channel)) {
    throw Object.assign(new Error('Gecersiz kanal'), { code: 'INVALID_CHANNEL', status: 400 });
  }
  const hash = resolveTargetHash(organizationId, channel, { email, phone });
  await suppressChannel(client, { organizationId, channel, targetHash: hash, reason, source: 'admin', email, phone });
  return { channel, suppressed: true };
}

// Which provider each channel is wired to (config only — no secrets). 'unconfigured'
// means production would hard-fail rather than silently mock.
function providerStatus() {
  return CHANNELS.map((channel) => {
    const name = configuredProviderName(channel);
    return {
      channel,
      provider: name || null,
      mode: name === 'test' ? 'test' : (name ? 'configured' : 'unconfigured'),
    };
  });
}

// Provider health: delivery outcomes over a window, plus an error rate per provider.
async function metrics(client, { organizationId, windowDays = 7 }) {
  const days = Math.max(1, Math.min(Number(windowDays) || 7, 90));
  const result = await client.query(
    `select provider, status, count(*)::int as count
       from notification_deliveries
      where organization_id = $1 and attempted_at > now() - make_interval(days => $2)
      group by provider, status`,
    [organizationId, days]
  );
  const byProvider = new Map();
  for (const row of result.rows) {
    const entry = byProvider.get(row.provider) || { provider: row.provider, total: 0, sent: 0, failed: 0 };
    entry.total += row.count;
    if (row.status === 'sent') entry.sent += row.count;
    else entry.failed += row.count;
    byProvider.set(row.provider, entry);
  }
  return {
    window_days: days,
    providers: [...byProvider.values()].map((entry) => ({
      ...entry,
      error_rate: entry.total ? Number((entry.failed / entry.total).toFixed(4)) : 0,
    })),
  };
}

module.exports = {
  overview, listOutbox, listDeliveries, listFailed, listSubscriptions, listSuppressions,
  retryOutbox, manualSuppress, providerStatus, metrics,
};
