'use strict';

// A29 integration event registry.
//
// Every event this platform can emit is declared here with its aggregate, its current
// schema version and a builder that produces the payload. Three consequences, all
// intentional:
//
//   * An arbitrary event name cannot be emitted. `emitEvent` looks the type up here and
//     throws otherwise, so a typo is a failing test rather than a subscription that never
//     fires.
//   * PAYLOADS ARE MINIMISED BY CONSTRUCTION. The builder decides what leaves the platform,
//     so a webhook cannot start carrying an address or a tax id because someone passed a
//     whole row into it. Anything a receiver needs beyond this is fetched over the API with
//     their own credentials, under their own scopes.
//   * Every payload carries schemaVersion plus aggregate identity and version, so a
//     receiver can detect an out-of-order or duplicate delivery from the message itself
//     rather than from a sentence in the documentation.

function eventError(message, code, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function text(value, max = 200) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function money(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : null;
}

function id(value) {
  if (value == null) return null;
  return String(value).slice(0, 100);
}

const REGISTRY = Object.freeze({
  'product.created': {
    aggregateType: 'product', schemaVersion: 1,
    build: (data) => ({ id: id(data.id), sku: text(data.sku, 80), status: text(data.status, 40) }),
  },
  'product.updated': {
    aggregateType: 'product', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id), sku: text(data.sku, 80), status: text(data.status, 40),
      changed: Array.isArray(data.changed) ? data.changed.slice(0, 30).map((field) => text(field, 40)) : [],
    }),
  },
  'product.deleted': {
    aggregateType: 'product', schemaVersion: 1,
    build: (data) => ({ id: id(data.id), sku: text(data.sku, 80) }),
  },
  'inventory.changed': {
    aggregateType: 'inventory', schemaVersion: 1,
    build: (data) => ({
      productId: id(data.productId), variantId: id(data.variantId),
      available: Number.isFinite(Number(data.available)) ? Number(data.available) : null,
      delta: Number.isFinite(Number(data.delta)) ? Number(data.delta) : null,
      reason: text(data.reason, 40),
    }),
  },
  'order.created': {
    aggregateType: 'order', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id), orderCode: text(data.orderCode, 40), status: text(data.status, 40),
      total: money(data.total), currency: text(data.currency, 8) || 'TRY',
      itemCount: Number.isFinite(Number(data.itemCount)) ? Number(data.itemCount) : null,
      // Deliberately absent: customer name, e-mail, phone, and the whole shipping address.
      // A receiver that needs them reads /v1/orders with a customers:read scope.
      customerId: id(data.customerId),
    }),
  },
  'order.status_changed': {
    aggregateType: 'order', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id), orderCode: text(data.orderCode, 40),
      status: text(data.status, 40), previousStatus: text(data.previousStatus, 40),
    }),
  },
  'payment.paid': {
    aggregateType: 'order', schemaVersion: 1,
    build: (data) => ({
      orderId: id(data.orderId), orderCode: text(data.orderCode, 40),
      amount: money(data.amount), currency: text(data.currency, 8) || 'TRY',
      provider: text(data.provider, 40),
    }),
  },
  'payment.failed': {
    aggregateType: 'order', schemaVersion: 1,
    build: (data) => ({
      orderId: id(data.orderId), orderCode: text(data.orderCode, 40),
      provider: text(data.provider, 40), reasonCode: text(data.reasonCode, 60),
    }),
  },
  'payment.refunded': {
    aggregateType: 'order', schemaVersion: 1,
    build: (data) => ({
      orderId: id(data.orderId), orderCode: text(data.orderCode, 40),
      amount: money(data.amount), currency: text(data.currency, 8) || 'TRY',
    }),
  },
  'fulfillment.shipped': {
    aggregateType: 'shipment', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id), orderId: id(data.orderId), carrier: text(data.carrier, 60),
      trackingNumber: text(data.trackingNumber, 60),
    }),
  },
  'fulfillment.delivered': {
    aggregateType: 'shipment', schemaVersion: 1,
    build: (data) => ({ id: id(data.id), orderId: id(data.orderId), deliveredAt: text(data.deliveredAt, 40) }),
  },
  'return.requested': {
    aggregateType: 'return', schemaVersion: 1,
    build: (data) => ({ id: id(data.id), orderId: id(data.orderId), status: text(data.status, 40) }),
  },
  'return.updated': {
    aggregateType: 'return', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id), orderId: id(data.orderId),
      status: text(data.status, 40), previousStatus: text(data.previousStatus, 40),
    }),
  },
  'customer.created': {
    aggregateType: 'customer', schemaVersion: 1,
    // Identity only. No e-mail, no phone, no address: a receiver with customers:read can
    // fetch what it is entitled to, and everyone else gets a reference they cannot expand.
    build: (data) => ({ id: id(data.id) }),
  },
  'customer.updated': {
    aggregateType: 'customer', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id),
      changed: Array.isArray(data.changed) ? data.changed.slice(0, 30).map((field) => text(field, 40)) : [],
    }),
  },
  'subscription.updated': {
    aggregateType: 'subscription', schemaVersion: 1,
    build: (data) => ({
      id: id(data.id), plan: text(data.plan, 40), status: text(data.status, 40),
      previousStatus: text(data.previousStatus, 40),
    }),
  },
  // Not a business event: the "send a test" action. It goes through the same registry,
  // signing and delivery pipeline as everything else, so testing an endpoint proves the
  // real path works rather than a parallel one.
  'webhook.test': {
    aggregateType: 'webhook', schemaVersion: 1,
    build: (data) => ({ endpointId: id(data.endpointId), message: 'Panelya webhook test' }),
  },
});

const EVENT_TYPES = Object.freeze(Object.keys(REGISTRY));

function getEventDefinition(eventType) {
  const definition = REGISTRY[eventType];
  if (!definition) {
    throw eventError(`Bilinmeyen entegrasyon olayi: ${String(eventType).slice(0, 60)}`, 'EVENT_TYPE_UNKNOWN', 400);
  }
  return definition;
}

/** Validates a tenant's subscription list against the registry; unknown types are refused. */
function normalizeEventTypes(input) {
  const requested = Array.isArray(input) ? input : [];
  if (!requested.length) {
    throw eventError('En az bir olay secilmeli', 'WEBHOOK_EVENTS_REQUIRED', 400);
  }
  const seen = new Set();
  for (const entry of requested) {
    const eventType = String(entry || '').trim();
    // webhook.test is delivered to every endpoint on demand; subscribing to it explicitly
    // would imply it can arrive unprompted, which it cannot.
    if (!REGISTRY[eventType] || eventType === 'webhook.test') {
      throw eventError(`Bilinmeyen olay: ${String(entry).slice(0, 60)}`, 'WEBHOOK_EVENT_UNKNOWN', 400);
    }
    seen.add(eventType);
  }
  return EVENT_TYPES.filter((eventType) => seen.has(eventType));
}

/** The envelope a receiver sees. Identical shape for every event type, by construction. */
function buildEventBody({ eventId, eventType, occurredAt, schemaVersion, aggregateType, aggregateId, aggregateVersion, payload }) {
  return {
    id: eventId,
    type: eventType,
    schemaVersion,
    occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt),
    aggregate: {
      type: aggregateType,
      id: aggregateId,
      // The number a receiver compares to decide whether a delivery it already processed
      // supersedes this one. This is the ordering contract, in the message.
      version: Number(aggregateVersion),
    },
    data: payload,
  };
}

module.exports = {
  EVENT_TYPES,
  REGISTRY,
  buildEventBody,
  getEventDefinition,
  normalizeEventTypes,
};
