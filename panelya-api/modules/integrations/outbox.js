'use strict';

// A29 transactional outbox.
//
// The single rule this module exists to enforce: an integration event is written with the
// SAME client, inside the SAME transaction, as the business change it describes. Callers
// pass the transaction client they are already using; there is no variant that opens its
// own connection, because that variant is exactly how you end up with an event for an order
// that was rolled back, or a committed order nobody was told about.
//
// Fanout happens here too, in the same transaction. A delivery row is a promise to try, not
// an attempt: the worker picks it up afterwards, so a slow or dead receiver can never delay
// or fail the business operation that produced the event.

const { buildEventBody, getEventDefinition } = require('./events');

const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Emits one event and fans it out to the tenant's subscribed, active endpoints.
 *
 * @param client MUST be the transaction client of the business mutation.
 * @param aggregateVersion monotonic per aggregate. Together with type and id it is the
 *        dedup key, so recording the same transition twice collapses to one event while two
 *        genuinely different updates both survive.
 */
async function emitEvent(client, {
  organizationId,
  eventType,
  aggregateId,
  aggregateVersion,
  data = {},
  occurredAt = null,
}) {
  const definition = getEventDefinition(eventType);
  const payload = definition.build(data || {});

  const inserted = await client.query(
    `insert into integration_events
       (organization_id, event_type, schema_version, aggregate_type, aggregate_id,
        aggregate_version, payload, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb, coalesce($8, now()))
     on conflict (organization_id, event_type, aggregate_type, aggregate_id, aggregate_version)
       do nothing
     returning *`,
    [
      organizationId, eventType, definition.schemaVersion, definition.aggregateType,
      String(aggregateId), Number(aggregateVersion), JSON.stringify(payload), occurredAt,
    ]
  );

  // The conflict path is not an error: it means this exact transition was already recorded,
  // which is precisely what a retried payment callback or a repeated state write looks like.
  if (!inserted.rows[0]) return { event: null, deduplicated: true, deliveries: 0 };
  const event = inserted.rows[0];

  const deliveries = await fanout(client, { organizationId, event });
  return { event, deduplicated: false, deliveries };
}

/**
 * Creates one delivery per subscribed active endpoint of THIS tenant.
 *
 * The tenant scope is in the query and in the composite foreign keys, and the row is
 * written under the tenant's RLS context, so an event cannot reach another tenant's
 * endpoint even if a subscription row were somehow wrong.
 */
async function fanout(client, { organizationId, event }) {
  const inserted = await client.query(
    `insert into webhook_deliveries
       (organization_id, event_id, endpoint_id, secret_version_id, status, next_attempt_at, max_attempts)
     select $1, $2, e.id, s.id, 'pending', now(), $4
       from webhook_endpoints e
       join webhook_endpoint_events se
         on se.organization_id = e.organization_id and se.endpoint_id = e.id
       left join webhook_endpoint_secrets s
         on s.organization_id = e.organization_id and s.endpoint_id = e.id and s.status = 'current'
      where e.organization_id = $1
        and e.status = 'active'
        and se.event_type = $3
     on conflict (organization_id, event_id, endpoint_id) do nothing`,
    [organizationId, event.id, event.event_type, DEFAULT_MAX_ATTEMPTS]
  );
  return inserted.rowCount;
}

/**
 * Enqueues a delivery for one endpoint without a business change behind it — the admin
 * "send a test" action. It still creates a real event and a real delivery so the test
 * traverses the same signing, SSRF and retry path a production event would.
 */
async function enqueueTestDelivery(client, { organizationId, endpointId }) {
  const definition = getEventDefinition('webhook.test');
  const inserted = await client.query(
    `insert into integration_events
       (organization_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload)
     values ($1,'webhook.test',$2,$3,$4,
             (select coalesce(max(aggregate_version), 0) + 1 from integration_events
               where organization_id = $1 and event_type = 'webhook.test' and aggregate_id = $4),
             $5::jsonb)
     returning *`,
    [
      organizationId, definition.schemaVersion, definition.aggregateType,
      String(endpointId), JSON.stringify(definition.build({ endpointId })),
    ]
  );
  const event = inserted.rows[0];
  const delivery = await client.query(
    `insert into webhook_deliveries
       (organization_id, event_id, endpoint_id, secret_version_id, status, next_attempt_at, max_attempts)
     select $1, $2, e.id, s.id, 'pending', now(), $4
       from webhook_endpoints e
       left join webhook_endpoint_secrets s
         on s.organization_id = e.organization_id and s.endpoint_id = e.id and s.status = 'current'
      where e.organization_id = $1 and e.id = $3 and e.status = 'active'
     returning *`,
    [organizationId, event.id, Number(endpointId), DEFAULT_MAX_ATTEMPTS]
  );
  if (!delivery.rows[0]) {
    throw Object.assign(new Error('Webhook endpointi aktif degil'), {
      code: 'WEBHOOK_ENDPOINT_NOT_ACTIVE', status: 409,
    });
  }
  return { event, delivery: delivery.rows[0] };
}

/**
 * Next version number for an aggregate. Callers that have a natural version (an order's
 * updated_at counter, a product revision) should pass their own; this is for aggregates
 * with none, and it runs inside the caller's transaction so it stays consistent with the
 * insert that follows.
 */
async function nextAggregateVersion(client, { organizationId, aggregateType, aggregateId }) {
  const result = await client.query(
    `select coalesce(max(aggregate_version), 0) + 1 as version
       from integration_events
      where organization_id = $1 and aggregate_type = $2 and aggregate_id = $3`,
    [organizationId, aggregateType, String(aggregateId)]
  );
  return Number(result.rows[0].version);
}

/** The exact JSON a receiver gets. Serialized once by the worker and signed as those bytes. */
function eventBody(event) {
  return buildEventBody({
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    schemaVersion: event.schema_version,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    aggregateVersion: event.aggregate_version,
    payload: event.payload,
  });
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  emitEvent,
  enqueueTestDelivery,
  eventBody,
  fanout,
  nextAggregateVersion,
};
