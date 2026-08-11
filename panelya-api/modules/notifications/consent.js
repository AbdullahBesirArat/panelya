'use strict';

const { targetHash, optionalHash } = require('./identity');

const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];
const PURPOSES = ['transactional', 'marketing', 'stock_alert', 'price_drop', 'favorite_update', 'abandoned_cart'];
const MARKETING_PURPOSES = PURPOSES.filter((purpose) => purpose !== 'transactional');
// Which outbox event a marketing purpose produces (used to cancel pending sends on opt-out).
const PURPOSE_TO_EVENT = { stock_alert: 'back_in_stock', price_drop: 'price_drop', favorite_update: 'favorite_update' };

function consentError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function assertChannelPurpose(channel, purpose) {
  if (!CHANNELS.includes(channel)) throw consentError('Gecersiz kanal', 'INVALID_CHANNEL', 400);
  if (!PURPOSES.includes(purpose)) throw consentError('Gecersiz amac', 'INVALID_PURPOSE', 400);
}

// Transactional messages (order/payment/shipping/security) never need marketing consent.
function requiresConsent(purpose) {
  return purpose !== 'transactional';
}

function resolveTargetHash(organizationId, channel, { email = '', phone = '' } = {}) {
  const contact = channel === 'email' ? email : phone;
  const hash = targetHash(organizationId, channel, contact);
  if (!hash) throw consentError('Gecersiz iletisim adresi', 'INVALID_CONTACT', 400);
  return hash;
}

async function isSuppressed(client, { organizationId, channel, targetHash: hash }) {
  const result = await client.query(
    `select 1 from communication_suppressions
      where organization_id = $1 and channel = $2 and target_hash = $3
        and (expires_at is null or expires_at > now()) limit 1`,
    [organizationId, channel, hash]
  );
  return Boolean(result.rows[0]);
}

async function hasConsent(client, { organizationId, channel, targetHash: hash, purpose }) {
  const result = await client.query(
    `select 1 from communication_consents
      where organization_id = $1 and target_hash = $2 and channel = $3 and purpose = $4
        and status = 'granted' and (expires_at is null or expires_at > now()) limit 1`,
    [organizationId, hash, channel, purpose]
  );
  return Boolean(result.rows[0]);
}

// The single gate the worker calls immediately before sending: transactional always
// passes; marketing needs granted consent AND no active suppression.
async function canSend(client, { organizationId, channel, targetHash: hash, purpose }) {
  if (!requiresConsent(purpose)) return true;
  if (await isSuppressed(client, { organizationId, channel, targetHash: hash })) return false;
  return hasConsent(client, { organizationId, channel, targetHash: hash, purpose });
}

async function logConsentEvent(client, { organizationId, consentId, targetHash: hash, channel, purpose, action, policyVersion, consentTextHash, source, ipHash, uaHash }) {
  await client.query(
    `insert into communication_consent_events
       (organization_id, consent_id, target_hash, channel, purpose, action, policy_version, consent_text_hash, source, ip_hash, user_agent_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [organizationId, consentId, hash, channel, purpose, action, policyVersion || '', consentTextHash || null, source || '', ipHash || null, uaHash || null]
  );
}

async function grantConsent(client, {
  organizationId, customerAccountId = null, email = '', phone = '', channel, purpose,
  source = '', policyVersion = '', consentText = '', ip = '', userAgent = '',
}) {
  assertChannelPurpose(channel, purpose);
  const hash = resolveTargetHash(organizationId, channel, { email, phone });
  const consentTextHash = optionalHash(organizationId, consentText);
  const existing = await client.query(
    'select id, status from communication_consents where organization_id = $1 and target_hash = $2 and channel = $3 and purpose = $4 for update',
    [organizationId, hash, channel, purpose]
  );
  const wasGranted = existing.rows[0] && existing.rows[0].status === 'granted';
  const upserted = await client.query(
    `insert into communication_consents
       (organization_id, customer_account_id, contact_email, contact_phone, target_hash, channel, purpose,
        status, source, policy_version, consent_text_hash, granted_at, revoked_at, ip_hash, user_agent_hash)
     values ($1,$2,$3,$4,$5,$6,$7,'granted',$8,$9,$10,now(),null,$11,$12)
     on conflict (organization_id, target_hash, channel, purpose) do update
        set status = 'granted', granted_at = now(), revoked_at = null,
            customer_account_id = coalesce(excluded.customer_account_id, communication_consents.customer_account_id),
            contact_email = case when excluded.contact_email <> '' then excluded.contact_email else communication_consents.contact_email end,
            contact_phone = case when excluded.contact_phone <> '' then excluded.contact_phone else communication_consents.contact_phone end,
            source = excluded.source, policy_version = excluded.policy_version,
            consent_text_hash = coalesce(excluded.consent_text_hash, communication_consents.consent_text_hash),
            ip_hash = coalesce(excluded.ip_hash, communication_consents.ip_hash),
            user_agent_hash = coalesce(excluded.user_agent_hash, communication_consents.user_agent_hash),
            updated_at = now()
     returning *`,
    [organizationId, customerAccountId, email, phone, hash, channel, purpose, source, policyVersion,
      consentTextHash, optionalHash(organizationId, ip), optionalHash(organizationId, userAgent)]
  );
  const row = upserted.rows[0];
  // Idempotent: a re-grant of an already-granted consent records no new legal event.
  if (!wasGranted) {
    await logConsentEvent(client, {
      organizationId, consentId: row.id, targetHash: hash, channel, purpose, action: 'granted',
      policyVersion, consentTextHash, source, ipHash: optionalHash(organizationId, ip), uaHash: optionalHash(organizationId, userAgent),
    });
    // Granting re-enables delivery: lift any prior suppression for this channel/target.
    await client.query(
      'delete from communication_suppressions where organization_id = $1 and channel = $2 and target_hash = $3',
      [organizationId, channel, hash]
    );
  }
  return { consent: row, targetHash: hash, changed: !wasGranted };
}

async function cancelPendingOutbox(client, { organizationId, targetHash: hash, channel, eventType = null, reason }) {
  const params = [organizationId, hash, channel, reason];
  const eventClause = eventType ? ` and event_type = $${params.push(eventType)}` : '';
  await client.query(
    `update notification_outbox
        set status = 'dead', error_code = $4, failed_at = now(), updated_at = now()
      where organization_id = $1 and recipient_hash = $2 and channel = $3
        and status in ('pending','failed')${eventClause}`,
    params
  );
}

async function revokeConsent(client, {
  organizationId, email = '', phone = '', channel, purpose, source = '', ip = '', userAgent = '',
}) {
  assertChannelPurpose(channel, purpose);
  const hash = resolveTargetHash(organizationId, channel, { email, phone });
  const existing = await client.query(
    'select id, status from communication_consents where organization_id = $1 and target_hash = $2 and channel = $3 and purpose = $4 for update',
    [organizationId, hash, channel, purpose]
  );
  const wasGranted = existing.rows[0] && existing.rows[0].status === 'granted';
  const upserted = await client.query(
    `insert into communication_consents
       (organization_id, contact_email, contact_phone, target_hash, channel, purpose, status, source, revoked_at)
     values ($1,$2,$3,$4,$5,$6,'revoked',$7,now())
     on conflict (organization_id, target_hash, channel, purpose) do update
        set status = 'revoked', revoked_at = now(), source = excluded.source, updated_at = now()
     returning *`,
    [organizationId, email, phone, hash, channel, purpose, source]
  );
  const row = upserted.rows[0];
  if (wasGranted) {
    await logConsentEvent(client, {
      organizationId, consentId: row.id, targetHash: hash, channel, purpose, action: 'revoked',
      source, ipHash: optionalHash(organizationId, ip), uaHash: optionalHash(organizationId, userAgent),
    });
  }
  // Opt-out suppresses that purpose's pending sends without touching other purposes.
  await cancelPendingOutbox(client, { organizationId, targetHash: hash, channel, eventType: PURPOSE_TO_EVENT[purpose] || null, reason: 'consent_revoked' });
  return { consent: row, targetHash: hash, changed: wasGranted };
}

// Hard channel-level opt-out (unsubscribe-all / bounce): suppress the channel, revoke
// every marketing consent for the target, and kill all pending marketing outbox. A
// suppression never blocks transactional mail.
async function suppressChannel(client, { organizationId, channel, targetHash: hash, reason = 'unsubscribe', source = 'storefront', email = '', phone = '' }) {
  await client.query(
    `insert into communication_suppressions (organization_id, channel, target_hash, reason, source)
     values ($1,$2,$3,$4,$5)
     on conflict (organization_id, channel, target_hash) do update
        set reason = excluded.reason, source = excluded.source, created_at = now()`,
    [organizationId, channel, hash, reason, source]
  );
  await client.query(
    `update communication_consents
        set status = 'revoked', revoked_at = now(), updated_at = now()
      where organization_id = $1 and target_hash = $2 and channel = $3
        and purpose = any($4::text[]) and status = 'granted'`,
    [organizationId, hash, channel, MARKETING_PURPOSES]
  );
  await client.query(
    `update notification_outbox
        set status = 'dead', error_code = 'suppressed', failed_at = now(), updated_at = now()
      where organization_id = $1 and recipient_hash = $2 and channel = $3 and status in ('pending','failed')`,
    [organizationId, hash, channel]
  );
  if (email || phone) {
    await logConsentEvent(client, {
      organizationId, consentId: null, targetHash: hash, channel, purpose: 'marketing', action: 'revoked', source,
    });
  }
  return { targetHash: hash };
}

module.exports = {
  CHANNELS, PURPOSES, MARKETING_PURPOSES, PURPOSE_TO_EVENT,
  consentError, requiresConsent, resolveTargetHash,
  isSuppressed, hasConsent, canSend,
  grantConsent, revokeConsent, suppressChannel, cancelPendingOutbox,
};
