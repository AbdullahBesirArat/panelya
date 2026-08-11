'use strict';

// Customer-facing reads + preference-center writes over the A23 consent/subscription
// model. A signed-in customer is matched by account id AND by the target hashes their
// verified email/phone resolve to, so consents created during a guest flow surface too.
const { targetHash } = require('./identity');
const { CHANNELS, MARKETING_PURPOSES, grantConsent, revokeConsent, suppressChannel } = require('./consent');

// Channels a phone number can reach vs. an email address.
const PHONE_CHANNELS = ['sms', 'whatsapp'];

// Every target hash an account "owns": its email (email/push) and phone (sms/whatsapp).
function accountTargetHashes(organizationId, { email = '', phone = '' } = {}) {
  const hashes = new Set();
  if (email) {
    for (const channel of ['email', 'push']) {
      const hash = targetHash(organizationId, channel, email);
      if (hash) hashes.add(hash);
    }
  }
  if (phone) {
    for (const channel of PHONE_CHANNELS) {
      const hash = targetHash(organizationId, channel, phone);
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes];
}

function subscriptionView(row) {
  return {
    id: Number(row.id),
    subscription_type: row.subscription_type,
    channel: row.channel,
    product_id: row.product_id != null ? Number(row.product_id) : null,
    variant_id: row.variant_id != null ? Number(row.variant_id) : null,
    status: row.status,
    baseline_price: row.baseline_price != null ? Number(row.baseline_price) : null,
    last_notified_at: row.last_notified_at,
    created_at: row.created_at,
  };
}

// Subscriptions the customer can still manage (excludes hard unsubscribed rows).
async function listSubscriptions(client, { organizationId, customerAccountId = null, targetHashes = [] }) {
  const result = await client.query(
    `select id, subscription_type, channel, product_id, variant_id, status,
            baseline_price, last_notified_at, created_at
       from notification_subscriptions
      where organization_id = $1
        and status in ('pending','active','notified')
        and (($2::bigint is not null and customer_account_id = $2)
             or target_hash = any($3::text[]))
      order by created_at desc
      limit 200`,
    [organizationId, customerAccountId, targetHashes]
  );
  return result.rows.map(subscriptionView);
}

function consentView(row) {
  return {
    channel: row.channel,
    purpose: row.purpose,
    status: row.status,
    granted_at: row.granted_at,
    revoked_at: row.revoked_at,
    updated_at: row.updated_at,
  };
}

// The consent matrix for a customer's contact points (marketing purposes only; the
// preference center never toggles transactional messaging).
async function listConsents(client, { organizationId, targetHashes = [] }) {
  if (!targetHashes.length) return [];
  const result = await client.query(
    `select channel, purpose, status, granted_at, revoked_at, updated_at
       from communication_consents
      where organization_id = $1
        and target_hash = any($2::text[])
        and purpose = any($3::text[])
      order by channel, purpose`,
    [organizationId, targetHashes, MARKETING_PURPOSES]
  );
  return result.rows.map(consentView);
}

// The full preference center payload for a signed-in customer.
async function getPreferences(client, { organizationId, email = '', phone = '' }) {
  const targetHashes = accountTargetHashes(organizationId, { email, phone });
  const [subscriptions, consents] = await Promise.all([
    listSubscriptions(client, { organizationId, targetHashes }),
    listConsents(client, { organizationId, targetHashes }),
  ]);
  return {
    channels: CHANNELS,
    marketing_purposes: MARKETING_PURPOSES,
    subscriptions,
    consents,
  };
}

// Apply a batch of {channel, purpose, granted} toggles from the preference center.
// Transactional purpose is never accepted here (it is not a marketing preference).
async function applyPreferences(client, {
  organizationId, customerAccountId = null, email = '', phone = '', changes = [], source = 'preference_center', ip = '', userAgent = '',
}) {
  const applied = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const channel = String(change.channel || '').trim();
    const purpose = String(change.purpose || '').trim();
    if (purpose === 'transactional') continue;
    if (change.granted === true) {
      const { changed } = await grantConsent(client, {
        organizationId, customerAccountId, email, phone, channel, purpose, source, ip, userAgent,
      });
      applied.push({ channel, purpose, status: 'granted', changed });
    } else {
      const { changed } = await revokeConsent(client, {
        organizationId, email, phone, channel, purpose, source, ip, userAgent,
      });
      applied.push({ channel, purpose, status: 'revoked', changed });
    }
  }
  return applied;
}

// One-click "stop all marketing": suppress every channel the customer's contacts reach
// (revokes marketing consent + kills pending marketing outbox; transactional untouched).
async function optOutAllMarketing(client, { organizationId, email = '', phone = '', source = 'preference_center' }) {
  const channels = [];
  if (email) channels.push('email', 'push');
  if (phone) channels.push(...PHONE_CHANNELS);
  const suppressed = [];
  for (const channel of channels) {
    const contact = ['email', 'push'].includes(channel) ? email : phone;
    const hash = targetHash(organizationId, channel, contact);
    if (!hash) continue;
    await suppressChannel(client, { organizationId, channel, targetHash: hash, reason: 'marketing_opt_out', source, email: ['email', 'push'].includes(channel) ? email : '', phone: PHONE_CHANNELS.includes(channel) ? phone : '' });
    suppressed.push(channel);
  }
  return suppressed;
}

module.exports = {
  accountTargetHashes, subscriptionView, consentView,
  listSubscriptions, listConsents, getPreferences, applyPreferences, optOutAllMarketing,
};
