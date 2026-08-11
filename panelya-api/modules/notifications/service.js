'use strict';

const { generateToken, hashToken, verifyToken, isValidTokenFormat } = require('../cart/token');
const { targetHash, channelContact, isValidContact, maskRecipient, sha256 } = require('./identity');
const consent = require('./consent');

const SUBSCRIPTION_TYPES = ['back_in_stock', 'price_drop', 'favorite_update'];
const SUBSCRIPTION_PURPOSE = { back_in_stock: 'stock_alert', price_drop: 'price_drop', favorite_update: 'favorite_update' };
const SUBSCRIPTION_EVENT = { back_in_stock: 'back_in_stock', price_drop: 'price_drop', favorite_update: 'favorite_update' };
// Types driven by a falling effective price (an explicit price alarm and a wishlist
// "favorite got cheaper"). Both anchor a baseline and share the drop-detection logic.
const PRICE_SENSITIVE_TYPES = ['price_drop', 'favorite_update'];
// Minimum drop (fraction) before a price-drop notifies, so rounding noise is ignored.
const PRICE_DROP_MIN_FRACTION = 0.02;

function notifyError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function assertType(type) {
  if (!SUBSCRIPTION_TYPES.includes(type)) throw notifyError('Gecersiz abonelik turu', 'INVALID_SUBSCRIPTION_TYPE', 400);
}

async function loadSellableProduct(client, organizationId, productId, variantId) {
  const product = await client.query(
    'select id, price, sale_price, status from products where organization_id = $1 and id = $2',
    [organizationId, Number(productId)]
  );
  if (!product.rows[0] || product.rows[0].status === 'draft') throw notifyError('Urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);
  if (variantId) {
    const variant = await client.query(
      'select id, available from product_variants where organization_id = $1 and id = $2 and product_id = $3',
      [organizationId, Number(variantId), Number(productId)]
    );
    if (!variant.rows[0]) throw notifyError('Varyant bulunamadi', 'VARIANT_NOT_FOUND', 404);
  }
  return product.rows[0];
}

function effectivePrice(product) {
  return Number(product.sale_price ?? product.price);
}

// Enqueue one outbox row inside the caller's transaction (event + outbox atomic with
// the domain change). Idempotent on (organization_id, idempotency_key).
async function enqueue(client, {
  organizationId, customerAccountId = null, subscriptionId = null, eventType, channel,
  recipient, payload = {}, idempotencyKey,
}) {
  const recipientHash = targetHash(organizationId, channel, recipient);
  if (!recipientHash) return null;
  const inserted = await client.query(
    `insert into notification_outbox
       (organization_id, customer_account_id, subscription_id, event_type, channel, recipient_ref, recipient_hash, payload, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     on conflict (organization_id, idempotency_key) do nothing
     returning *`,
    [organizationId, customerAccountId, subscriptionId, eventType, channel, recipient, recipientHash, JSON.stringify(payload), idempotencyKey]
  );
  return inserted.rows[0] || null;
}

// Create (or reactivate) a notification subscription. Marketing consent is required;
// account subscribers activate immediately, guest email subscribers get double opt-in.
async function createSubscription(client, {
  organizationId, customerAccountId = null, productId, variantId = null, subscriptionType, channel = 'email',
  email = '', phone = '', consentGiven = false, source = 'storefront', policyVersion = '', targetPrice = null,
}) {
  assertType(subscriptionType);
  if (!consent.CHANNELS.includes(channel)) throw notifyError('Gecersiz kanal', 'INVALID_CHANNEL', 400);
  const product = await loadSellableProduct(client, organizationId, productId, variantId);
  const contact = channelContact(channel, { email, phone });
  if (!isValidContact(channel, contact)) throw notifyError('Gecerli bir iletisim adresi girin', 'INVALID_CONTACT', 400);
  if (!consentGiven) throw notifyError('Bildirim icin acik riza zorunlu', 'CONSENT_REQUIRED', 422);

  const hash = targetHash(organizationId, channel, contact);
  const purpose = SUBSCRIPTION_PURPOSE[subscriptionType];
  const isAccount = Boolean(customerAccountId);
  const status = isAccount ? 'active' : 'pending';
  const rawUnsub = generateToken();
  const rawConfirm = isAccount ? null : generateToken();
  // Price-sensitive types anchor a baseline at subscription time so only a genuine
  // drop below it notifies (never a price rise, never the price they signed up at).
  const baseline = PRICE_SENSITIVE_TYPES.includes(subscriptionType) ? effectivePrice(product) : null;

  const upserted = await client.query(
    `insert into notification_subscriptions
       (organization_id, customer_account_id, product_id, variant_id, subscription_type, channel,
        contact_email, contact_phone, target_hash, status, baseline_price,
        confirmation_token_hash, confirmed_at, unsubscribe_token_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (organization_id, target_hash, subscription_type, product_id, coalesce(variant_id, 0), channel)
       do update set status = case when notification_subscriptions.status = 'unsubscribed' then excluded.status else notification_subscriptions.status end,
                     contact_email = excluded.contact_email, contact_phone = excluded.contact_phone,
                     baseline_price = coalesce(notification_subscriptions.baseline_price, excluded.baseline_price),
                     customer_account_id = coalesce(excluded.customer_account_id, notification_subscriptions.customer_account_id),
                     updated_at = now()
     returning *, (xmax = 0) as inserted`,
    [organizationId, customerAccountId, product.id, variantId, subscriptionType, channel,
      email, phone, hash, status, baseline,
      rawConfirm ? hashToken(rawConfirm) : null, isAccount ? new Date() : null, hashToken(rawUnsub)]
  );
  const subscription = upserted.rows[0];

  if (isAccount) {
    // Signed-in customer: grant the purpose consent immediately.
    await consent.grantConsent(client, {
      organizationId, customerAccountId, email, phone, channel, purpose, source, policyVersion,
    });
  } else if (subscription.inserted || subscription.status === 'pending') {
    // Guest email: send a double opt-in confirmation (transactional, so no consent gate).
    await enqueue(client, {
      organizationId, subscriptionId: subscription.id, eventType: 'subscription_opt_in', channel,
      recipient: contact,
      payload: { subscription_type: subscriptionType, product_id: Number(product.id), confirm_token: rawConfirm, masked: maskRecipient(channel, contact) },
      idempotencyKey: `opt_in:${subscription.id}:${sha256(rawConfirm).slice(0, 24)}`,
    });
  }
  return { subscription, rawUnsubscribeToken: rawUnsub, rawConfirmToken: rawConfirm, targetHash: hash };
}

// Guest confirms via the double opt-in link: activate + grant the purpose consent.
async function confirmSubscription(client, { organizationId, token }) {
  if (!isValidTokenFormat(token)) throw notifyError('Onay baglantisi gecersiz', 'CONFIRM_TOKEN_INVALID', 400);
  const found = await client.query(
    'select * from notification_subscriptions where organization_id = $1 and confirmation_token_hash = $2 for update',
    [organizationId, hashToken(token)]
  );
  const subscription = found.rows[0];
  if (!subscription) throw notifyError('Onay baglantisi gecersiz veya kullanilmis', 'CONFIRM_TOKEN_INVALID', 404);
  if (subscription.status === 'active') return subscription;
  const updated = await client.query(
    `update notification_subscriptions set status = 'active', confirmed_at = now(), confirmation_token_hash = null, updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, subscription.id]
  );
  await consent.grantConsent(client, {
    organizationId, email: subscription.contact_email, phone: subscription.contact_phone,
    channel: subscription.channel, purpose: SUBSCRIPTION_PURPOSE[subscription.subscription_type], source: 'double_opt_in',
  });
  return updated.rows[0];
}

async function cancelSubscription(client, { organizationId, subscriptionId, customerAccountId = null }) {
  const clause = customerAccountId ? 'and customer_account_id = $3' : '';
  const params = [organizationId, Number(subscriptionId)];
  if (customerAccountId) params.push(customerAccountId);
  const updated = await client.query(
    `update notification_subscriptions set status = 'unsubscribed', updated_at = now()
      where organization_id = $1 and id = $2 ${clause} and status <> 'unsubscribed' returning *`,
    params
  );
  if (!updated.rows[0]) throw notifyError('Abonelik bulunamadi', 'SUBSCRIPTION_NOT_FOUND', 404);
  await consent.cancelPendingOutbox(client, {
    organizationId, targetHash: updated.rows[0].target_hash, channel: updated.rows[0].channel,
    eventType: SUBSCRIPTION_EVENT[updated.rows[0].subscription_type], reason: 'unsubscribed',
  });
  return updated.rows[0];
}

// Consume an unsubscribe link: mark the subscription unsubscribed AND suppress the
// channel for that recipient (blocks future marketing; never transactional).
async function consumeUnsubscribeToken(client, { organizationId, token }) {
  if (!isValidTokenFormat(token)) throw notifyError('Baglanti gecersiz', 'UNSUB_TOKEN_INVALID', 400);
  const found = await client.query(
    'select * from notification_subscriptions where organization_id = $1 and unsubscribe_token_hash = $2 for update',
    [organizationId, hashToken(token)]
  );
  const subscription = found.rows[0];
  if (!subscription || !verifyToken(token, subscription.unsubscribe_token_hash)) {
    throw notifyError('Baglanti gecersiz veya kullanilmis', 'UNSUB_TOKEN_INVALID', 404);
  }
  await client.query(
    "update notification_subscriptions set status = 'unsubscribed', updated_at = now() where organization_id = $1 and id = $2",
    [organizationId, subscription.id]
  );
  await consent.suppressChannel(client, {
    organizationId, channel: subscription.channel, targetHash: subscription.target_hash,
    reason: 'unsubscribe', source: 'unsubscribe_link',
    email: subscription.contact_email, phone: subscription.contact_phone,
  });
  return subscription;
}

// Trigger: a variant crossed 0 -> positive availability. Consent is verified per
// subscription BEFORE enqueue (no marketing outbox without consent) and the one-shot
// flip to 'notified' happens only when we actually notify — so a non-consented
// subscriber is never silently consumed, and the worker still re-checks at send time.
async function triggerBackInStock(client, { organizationId, variantId, productId }) {
  const subs = await client.query(
    `select * from notification_subscriptions
      where organization_id = $1 and subscription_type = 'back_in_stock' and status = 'active'
        and product_id = $2 and (variant_id = $3 or variant_id is null)
      for update`,
    [organizationId, Number(productId), Number(variantId)]
  );
  let enqueued = 0;
  for (const sub of subs.rows) {
    const allowed = await consent.canSend(client, {
      organizationId, channel: sub.channel, targetHash: sub.target_hash, purpose: SUBSCRIPTION_PURPOSE.back_in_stock,
    });
    if (!allowed) continue;
    const contact = sub.channel === 'email' ? sub.contact_email : sub.contact_phone;
    const row = await enqueue(client, {
      organizationId, customerAccountId: sub.customer_account_id, subscriptionId: sub.id,
      eventType: 'back_in_stock', channel: sub.channel, recipient: contact,
      payload: { product_id: Number(sub.product_id), variant_id: sub.variant_id ? Number(sub.variant_id) : null, subscription_id: Number(sub.id), masked: maskRecipient(sub.channel, contact) },
      idempotencyKey: `back_in_stock:${sub.id}`,
    });
    if (row) {
      enqueued += 1;
      await client.query(
        "update notification_subscriptions set status = 'notified', last_notified_at = now(), updated_at = now() where organization_id = $1 and id = $2",
        [organizationId, sub.id]
      );
    }
  }
  return enqueued;
}

// Shared trigger for the price-sensitive subscription types: a product's effective
// price dropped meaningfully below a subscription's baseline. Re-notifies only on a
// NEW lower price (idempotency key embeds the price), never on a rise, never twice for
// the same price. `newPrice` is the server-authoritative effective price.
async function notifyPriceSensitive(client, { organizationId, productId, newPrice, subscriptionType, eventType }) {
  const price = Number(newPrice);
  if (!Number.isFinite(price)) return 0;
  const subs = await client.query(
    `select * from notification_subscriptions
      where organization_id = $1 and subscription_type = $2 and status = 'active' and product_id = $3 for update`,
    [organizationId, subscriptionType, Number(productId)]
  );
  let enqueued = 0;
  for (const sub of subs.rows) {
    const baseline = Number(sub.baseline_price ?? Number.POSITIVE_INFINITY);
    const alreadyNotified = sub.last_notified_price != null ? Number(sub.last_notified_price) : null;
    const meaningful = price <= baseline * (1 - PRICE_DROP_MIN_FRACTION);
    const isNewLow = alreadyNotified == null || price < alreadyNotified;
    if (!meaningful || !isNewLow) continue;
    // No marketing outbox without valid consent (re-checked again at send time).
    const allowed = await consent.canSend(client, {
      organizationId, channel: sub.channel, targetHash: sub.target_hash, purpose: SUBSCRIPTION_PURPOSE[subscriptionType],
    });
    if (!allowed) continue;
    const contact = sub.channel === 'email' ? sub.contact_email : sub.contact_phone;
    const row = await enqueue(client, {
      organizationId, customerAccountId: sub.customer_account_id, subscriptionId: sub.id,
      eventType, channel: sub.channel, recipient: contact,
      payload: { product_id: Number(sub.product_id), old_price: baseline, new_price: price, subscription_id: Number(sub.id), masked: maskRecipient(sub.channel, contact) },
      idempotencyKey: `${eventType}:${sub.id}:${price.toFixed(2)}`,
    });
    if (row) {
      enqueued += 1;
      await client.query(
        'update notification_subscriptions set last_notified_price = $3, last_notified_at = now(), cooldown_until = now() + interval \'1 hour\', updated_at = now() where organization_id = $1 and id = $2',
        [organizationId, sub.id, price]
      );
    }
  }
  return enqueued;
}

// Explicit "notify me when the price drops" alarm subscribers.
function triggerPriceDrop(client, { organizationId, productId, newPrice }) {
  return notifyPriceSensitive(client, { organizationId, productId, newPrice, subscriptionType: 'price_drop', eventType: 'price_drop' });
}

// Wishlist / favorites subscribers: a product they favorited got cheaper.
function triggerFavoriteUpdate(client, { organizationId, productId, newPrice }) {
  return notifyPriceSensitive(client, { organizationId, productId, newPrice, subscriptionType: 'favorite_update', eventType: 'favorite_update' });
}

// Fan a server-authoritative effective-price change out to both price-sensitive types.
// Returns the total number of outbox rows enqueued.
async function triggerEffectivePriceChange(client, { organizationId, productId, newPrice }) {
  const drop = await triggerPriceDrop(client, { organizationId, productId, newPrice });
  const favorite = await triggerFavoriteUpdate(client, { organizationId, productId, newPrice });
  return drop + favorite;
}

// Given inventory-movement results (from services/inventory), fire back-in-stock for
// every variant whose available crossed 0 -> positive. Server-authoritative: it reads
// the transition the movement actually produced, never client-supplied stock.
async function notifyRestockTransitions(client, { organizationId, results }) {
  let enqueued = 0;
  for (const entry of results || []) {
    if (!entry || !entry.productId || !entry.variant) continue;
    if (Number(entry.availableBefore) <= 0 && Number(entry.availableAfter) > 0) {
      enqueued += await triggerBackInStock(client, {
        organizationId, productId: entry.productId, variantId: entry.variant.id,
      });
    }
  }
  return enqueued;
}

module.exports = {
  SUBSCRIPTION_TYPES, SUBSCRIPTION_PURPOSE, SUBSCRIPTION_EVENT, PRICE_SENSITIVE_TYPES, PRICE_DROP_MIN_FRACTION,
  effectivePrice, notifyError, enqueue, createSubscription, confirmSubscription, cancelSubscription,
  consumeUnsubscribeToken, triggerBackInStock, triggerPriceDrop, triggerFavoriteUpdate,
  triggerEffectivePriceChange, notifyPriceSensitive, notifyRestockTransitions,
};
