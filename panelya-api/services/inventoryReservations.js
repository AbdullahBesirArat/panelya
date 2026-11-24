const crypto = require('crypto');
const db = require('../db');
const {
  applyInventoryMovement,
  resolveInventoryItems,
  syncProductStock,
} = require('./inventory');
const { transitionOrderPromotion } = require('./promotionEngine');

function reservationError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

function reservationTtlMinutes(value = process.env.INVENTORY_RESERVATION_TTL_MINUTES) {
  const minutes = Number(value || 15);
  return Number.isInteger(minutes) && minutes >= 5 && minutes <= 10080 ? minutes : 15;
}

function guestReferenceHash(organizationId, email) {
  const normalized = String(email || '').trim().toLocaleLowerCase('tr-TR');
  return normalized
    ? crypto.createHash('sha256').update(String(organizationId)).update('\0').update(normalized).digest('hex')
    : null;
}

async function existingReservation(client, organizationId, { orderId = null, idempotencyKey = null } = {}, lock = false) {
  const clauses = ['organization_id = $1'];
  const params = [organizationId];
  if (orderId) clauses.push(`order_id = $${params.push(orderId)}`);
  else if (idempotencyKey) clauses.push(`idempotency_key = $${params.push(idempotencyKey)}`);
  else return null;
  const result = await client.query(
    `select * from inventory_reservations
      where ${clauses.join(' and ')}
      limit 1${lock ? ' for update' : ''}`,
    params
  );
  return result.rows[0] || null;
}

async function reservationItems(client, organizationId, reservationId) {
  const result = await client.query(
    `select item.variant_id, item.quantity, item.unit_price_snapshot,
            variant.product_id, variant.color, variant.size, variant.available,
            variant.on_hand, variant.reserved
       from inventory_reservation_items item
       join product_variants variant
         on variant.organization_id = item.organization_id
        and variant.id = item.variant_id
      where item.organization_id = $1 and item.reservation_id = $2
      order by item.variant_id`,
    [organizationId, reservationId]
  );
  return result.rows;
}

async function createInventoryReservation(client, {
  organizationId,
  orderId,
  customerId = null,
  guestEmail = '',
  items,
  idempotencyKey = null,
  ttlMinutes = reservationTtlMinutes(),
}) {
  const existing = await existingReservation(client, organizationId, { orderId, idempotencyKey });
  if (existing) return { created: false, reservation: existing, items: await reservationItems(client, organizationId, existing.id) };

  // This query locks every requested stock unit in ascending variant order.
  // Concurrent checkouts therefore serialize without deadlock or oversell.
  const canonical = await resolveInventoryItems(client, items, { organizationId, lock: true });
  for (const item of canonical) {
    if (Number(item.variant.available) < item.quantity) {
      const option = [item.variant.color, item.variant.size].filter(Boolean).join(' / ');
      throw reservationError(`${item.variant.name}${option ? ` (${option})` : ''} için stok değişti. Mevcut miktar: ${item.variant.available}`);
    }
  }

  const inserted = await client.query(
    `insert into inventory_reservations
       (organization_id, order_id, customer_id, guest_reference_hash,
        status, expires_at, idempotency_key)
     values ($1,$2,$3,$4,'active',now() + ($5::int * interval '1 minute'),$6)
     on conflict (organization_id, order_id) do nothing
     returning *, now() as server_time`,
    [
      organizationId,
      orderId,
      customerId,
      guestReferenceHash(organizationId, guestEmail),
      reservationTtlMinutes(ttlMinutes),
      String(idempotencyKey || '').trim() || null,
    ]
  );
  if (!inserted.rows[0]) {
    const winner = await existingReservation(client, organizationId, { orderId }, true);
    return { created: false, reservation: winner, items: await reservationItems(client, organizationId, winner.id) };
  }
  const reservation = inserted.rows[0];
  const productIds = [];
  for (const item of canonical) {
    await client.query(
      `insert into inventory_reservation_items
         (organization_id, reservation_id, variant_id, quantity, unit_price_snapshot)
       values ($1,$2,$3,$4,$5)`,
      [organizationId, reservation.id, item.variant_id, item.quantity, item.unit_price ?? null]
    );
    await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'reservation',
      reservedDelta: item.quantity,
      referenceType: 'inventory_reservation',
      referenceId: reservation.id,
      idempotencyKey: `reserve:${reservation.id}:revision:0:variant:${item.variant_id}`,
      reason: 'Checkout inventory reservation',
      syncProduct: false,
    });
    productIds.push(item.product_id);
  }
  await syncProductStock(client, productIds, { organizationId });
  return { created: true, reservation, items: canonical };
}

async function consumeReservation(client, { organizationId, orderId = null, reservationId = null } = {}) {
  const reservation = reservationId
    ? (await client.query(
      'select * from inventory_reservations where organization_id = $1 and id = $2 for update',
      [organizationId, reservationId]
    )).rows[0]
    : await existingReservation(client, organizationId, { orderId }, true);
  if (!reservation) throw reservationError('Stok rezervasyonu bulunamadi', 404);
  if (reservation.status === 'consumed') return { changed: false, reservation };
  if (reservation.status !== 'active') throw reservationError('Stok rezervasyonu artık aktif değil');
  const items = await reservationItems(client, organizationId, reservation.id);
  const productIds = [];
  for (const item of items) {
    await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'sale',
      onHandDelta: -Number(item.quantity),
      reservedDelta: -Number(item.quantity),
      referenceType: 'inventory_reservation',
      referenceId: reservation.id,
      idempotencyKey: `consume:${reservation.id}:revision:${reservation.revision}:variant:${item.variant_id}`,
      reason: 'Payment/order consumed reservation',
      syncProduct: false,
    });
    productIds.push(item.product_id);
  }
  const updated = await client.query(
    `update inventory_reservations
        set status = 'consumed', consumed_at = now(), updated_at = now()
      where organization_id = $1 and id = $2 and status = 'active'
      returning *`,
    [organizationId, reservation.id]
  );
  await syncProductStock(client, productIds, { organizationId });
  return { changed: true, reservation: updated.rows[0] };
}

async function releaseReservation(client, {
  organizationId,
  orderId = null,
  reservationId = null,
  expired = false,
} = {}) {
  const reservation = reservationId
    ? (await client.query(
      'select * from inventory_reservations where organization_id = $1 and id = $2 for update',
      [organizationId, reservationId]
    )).rows[0]
    : await existingReservation(client, organizationId, { orderId }, true);
  if (!reservation) return { changed: false, reservation: null };
  if (reservation.status !== 'active') return { changed: false, reservation };
  const items = await reservationItems(client, organizationId, reservation.id);
  const productIds = [];
  for (const item of items) {
    await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'reservation_release',
      reservedDelta: -Number(item.quantity),
      referenceType: 'inventory_reservation',
      referenceId: reservation.id,
      idempotencyKey: `release:${reservation.id}:revision:${reservation.revision}:variant:${item.variant_id}`,
      reason: expired ? 'Reservation expired' : 'Reservation released',
      syncProduct: false,
    });
    productIds.push(item.product_id);
  }
  const status = expired ? 'expired' : 'released';
  const updated = await client.query(
    `update inventory_reservations
        set status = $3, released_at = now(), updated_at = now()
      where organization_id = $1 and id = $2 and status = 'active'
      returning *`,
    [organizationId, reservation.id, status]
  );
  await syncProductStock(client, productIds, { organizationId });
  return { changed: true, reservation: updated.rows[0] };
}

async function restockConsumedReservation(client, { organizationId, orderId } = {}) {
  const reservation = await existingReservation(client, organizationId, { orderId }, true);
  if (!reservation || reservation.status !== 'consumed' || reservation.restocked_at) {
    return { changed: false, reservation };
  }
  const items = await reservationItems(client, organizationId, reservation.id);
  const productIds = [];
  for (const item of items) {
    await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'cancellation',
      onHandDelta: Number(item.quantity),
      referenceType: 'inventory_reservation',
      referenceId: reservation.id,
      idempotencyKey: `restock:${reservation.id}:revision:${reservation.revision}:variant:${item.variant_id}`,
      reason: 'Order cancelled before fulfillment',
      syncProduct: false,
    });
    productIds.push(item.product_id);
  }
  const updated = await client.query(
    `update inventory_reservations
        set restocked_at = now(), updated_at = now()
      where organization_id = $1 and id = $2 and restocked_at is null
      returning *`,
    [organizationId, reservation.id]
  );
  await syncProductStock(client, productIds, { organizationId });
  return { changed: true, reservation: updated.rows[0] };
}

async function reactivateReservation(client, { organizationId, orderId } = {}) {
  const reservation = await existingReservation(client, organizationId, { orderId }, true);
  if (!reservation) throw reservationError('Stok rezervasyonu bulunamadi', 404);
  if (reservation.status === 'active') return reservation;
  const items = await reservationItems(client, organizationId, reservation.id);
  const nextRevision = Number(reservation.revision || 0) + 1;
  const productIds = [];
  for (const item of items) {
    await applyInventoryMovement(client, {
      organizationId,
      variantId: item.variant_id,
      movementType: 'reservation',
      reservedDelta: Number(item.quantity),
      referenceType: 'inventory_reservation',
      referenceId: reservation.id,
      idempotencyKey: `reserve:${reservation.id}:revision:${nextRevision}:variant:${item.variant_id}`,
      reason: 'Cancelled order reactivated',
      syncProduct: false,
    });
    productIds.push(item.product_id);
  }
  const updated = await client.query(
    `update inventory_reservations
        set status = 'active', revision = $3,
            expires_at = now() + ($4::int * interval '1 minute'),
            released_at = null, restocked_at = null, updated_at = now()
      where organization_id = $1 and id = $2
      returning *`,
    [organizationId, reservation.id, nextRevision, reservationTtlMinutes()]
  );
  await syncProductStock(client, productIds, { organizationId });
  return updated.rows[0];
}

async function transitionOrderInventory(client, orderId, previousStatus, nextStatus, { organizationId } = {}) {
  if (previousStatus === nextStatus) return { changed: false };
  if (previousStatus === 'cancelled' && nextStatus !== 'cancelled') {
    await reactivateReservation(client, { organizationId, orderId });
    if (nextStatus !== 'payment_pending') return consumeReservation(client, { organizationId, orderId });
    return { changed: true };
  }
  if (nextStatus === 'paid' || (nextStatus === 'processing' && previousStatus === 'payment_pending')) {
    return consumeReservation(client, { organizationId, orderId });
  }
  if (nextStatus === 'cancelled') {
    const reservation = await existingReservation(client, organizationId, { orderId });
    if (reservation?.status === 'active') return releaseReservation(client, { organizationId, orderId });
    if (reservation?.status === 'consumed' && !['shipped', 'delivered'].includes(previousStatus)) {
      return restockConsumedReservation(client, { organizationId, orderId });
    }
  }
  return { changed: false };
}

function ibanGraceMinutes(value = process.env.INVENTORY_EXPIRY_IBAN_GRACE_MINUTES) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 1440;
  return Math.min(Math.max(Math.floor(minutes), 1), 10080);
}

function cardGraceMinutes(value = process.env.INVENTORY_EXPIRY_CARD_GRACE_MINUTES) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 60;
  return Math.min(Math.max(Math.floor(minutes), 1), 1440);
}

const expiryMethodOrder = ['iban', 'card'];

function inventoryExpiryMethods(value = process.env.INVENTORY_EXPIRY_METHODS) {
  if (value === undefined) return [];
  if (typeof value === 'string' && value.length <= 128) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'none') return [];
    const tokens = normalized.split(',').map((token) => token.trim());
    if (tokens.every((token) => expiryMethodOrder.includes(token))) {
      return expiryMethodOrder.filter((method) => tokens.includes(method));
    }
  }
  console.warn('Invalid INVENTORY_EXPIRY_METHODS configuration. Expiry is disabled for all methods.');
  return [];
}

// Shared by the read-only count, claim, and cancellation recheck.
const dueReservations = `
  from inventory_reservations r
  join orders o on o.organization_id = r.organization_id and o.id = r.order_id
  cross join lateral (
    select case
      when o.status <> 'payment_pending' or o.order_status <> 'pending_payment'
        or o.fulfillment_status <> 'unfulfilled' then 'order_not_pending'
      when o.payment_status not in ('pending', 'manual_pending')
        or nullif(btrim(o.payment_id), '') is not null then 'payment_state'
      when not coalesce(o.payment_method = any($4::text[]), false) then 'method_disabled'
      when exists (
        select 1 from payment_callback_events e
         where e.organization_id = o.organization_id
           and e.processing_status <> 'processed'
           and (e.order_code = o.order_code or e.processed_order_id = o.id
             or e.payment_token = nullif(btrim(o.payment_token), ''))
      ) then 'callback_pending'
      when o.payment_method = 'card'
        and nullif(btrim(o.payment_token), '') is not null
        and r.expires_at + ($3::int * interval '1 minute') > now() then 'card_grace'
      when o.payment_method = 'iban'
        and r.expires_at + ($1::int * interval '1 minute') > now() then 'iban_grace'
    end as reason
  ) eligibility
  where r.status = 'active' and r.expires_at <= now()
    and ($2::uuid is null or r.organization_id = $2)`;

async function countReservationExpiry(client, {
  organizationId = null, graceMinutes = ibanGraceMinutes(), cardGrace = cardGraceMinutes(),
  methods = inventoryExpiryMethods(),
} = {}) {
  const { rows } = await client.query(
    `select o.payment_method as method, eligibility.reason, count(*)::int as count
       ${dueReservations}
      group by o.payment_method, eligibility.reason`,
    [graceMinutes, organizationId, cardGrace, methods]
  );
  const report = { methods, due: 0, skipped: {}, byMethod: {} };
  for (const { method, reason, count } of rows) {
    const key = expiryMethodOrder.includes(method) ? method : 'unknown';
    const totals = report.byMethod[key] ??= { due: 0, skipped: {}, expired: 0 };
    if (reason === null) {
      report.due += count;
      totals.due += count;
    } else {
      report.skipped[reason] = (report.skipped[reason] || 0) + count;
      totals.skipped[reason] = (totals.skipped[reason] || 0) + count;
    }
  }
  return report;
}

// Global CLI runs opt out of the heartbeat. Tenant-scoped runs always leave it alone.
async function expireInventoryReservationsWithReport({
  pool = db.getSystemPool(), limit = 100, organizationId = null, graceMinutes = ibanGraceMinutes(),
  cardGrace = cardGraceMinutes(), methods = inventoryExpiryMethods(), updateHeartbeat = true, beforeCommit,
} = {}) {
  const scope = organizationId || null;
  const hasMethods = methods.length > 0;
  const stampHeartbeat = updateHeartbeat && !scope && hasMethods;
  let client;
  let releaseError;
  // pg can emit a socket error as well as reject the in-flight query.
  const onClientError = (error) => { releaseError = error; };
  // The connection must go back to the pool on every path, even if detaching the listener throws;
  // a connection that is never released makes pool teardown wait forever.
  const releaseClient = () => {
    if (!client) return;
    const checkedOut = client;
    client = null;
    try { checkedOut.removeListener('error', onClientError); }
    finally { checkedOut.release(releaseError); }
  };
  const expired = [];
  const policy = { organizationId: scope, graceMinutes, cardGrace, methods };
  if (!hasMethods && !beforeCommit) {
    return { ...await countReservationExpiry(pool, policy), expired };
  }
  try {
    if (stampHeartbeat) await pool.query(
      `insert into inventory_worker_health (job_name, last_started_at, updated_at)
       values ('inventory_reservation_expiry', now(), now())
       on conflict (job_name) do update set last_started_at = now(), updated_at = now()`
    );
    client = await pool.connect();
    client.on('error', onClientError);
    await client.query('begin');
    const report = await countReservationExpiry(client, policy);
    // Payment/admin transitions can already hold the order while acquiring the reservation.
    // Skip contention on either row, so expiry never waits for an order while holding its reservation.
    const selected = await client.query(
      `select r.id, r.organization_id, r.order_id, o.payment_method as method
         ${dueReservations}
          and eligibility.reason is null
        order by r.expires_at, r.id
        limit $5
        for update of r, o skip locked`,
      [graceMinutes, scope, cardGrace, methods, Math.floor(Math.min(Math.max(Number(limit) || 100, 1), 500))]
    );
    for (const reservation of selected.rows) {
      const cancelled = await client.query(
        `update orders
            set status = 'cancelled',
                payment_error = coalesce(payment_error, 'Stok rezervasyonu zaman aşımına uğradı'),
                updated_at = now()
          where organization_id = $2 and id = $5 and status = 'payment_pending'
            and exists (
              select 1 ${dueReservations}
                and o.id = $5 and r.id = $6 and eligibility.reason is null
            )`,
        [graceMinutes, reservation.organization_id, cardGrace, methods, reservation.order_id, reservation.id]
      );
      const totals = report.byMethod[reservation.method] ??= { due: 0, skipped: {}, expired: 0 };
      if (cancelled.rowCount !== 1) {
        for (const skipped of [report.skipped, totals.skipped]) {
          skipped.cancel_update_missed = (skipped.cancel_update_missed || 0) + 1;
        }
        continue;
      }
      const result = await releaseReservation(client, {
        organizationId: reservation.organization_id,
        reservationId: reservation.id,
        expired: true,
      });
      if (!result.changed) throw new Error('Cancelled order reservation could not be released');
      await transitionOrderPromotion(client, reservation.order_id, 'payment_pending', 'cancelled', {
        organizationId: reservation.organization_id,
      });
      expired.push(reservation.id);
      totals.expired += 1;
    }
    if (stampHeartbeat) await client.query(
      `update inventory_worker_health
          set last_succeeded_at = clock_timestamp(), last_error = null,
              processed_count = $2, updated_at = clock_timestamp()
        where job_name = $1`,
      ['inventory_reservation_expiry', expired.length]
    );
    const result = { ...report, expired };
    if (beforeCommit) await beforeCommit(client, result);
    await client.query('commit');
    return result;
  } catch (error) {
    if (client) {
      try { await client.query('rollback'); }
      catch (rollbackError) { releaseError = rollbackError; }
      finally { releaseClient(); }
    }
    if (stampHeartbeat) await pool.query(
      `insert into inventory_worker_health
         (job_name, last_failed_at, last_error, updated_at)
       values ('inventory_reservation_expiry', now(), $1, now())
       on conflict (job_name) do update
         set last_failed_at = now(), last_error = excluded.last_error, updated_at = now()`,
      [String(error.message || error).slice(0, 500)]
    ).catch(() => {});
    throw error;
  } finally {
    releaseClient();
  }
}

async function expireInventoryReservations(options) {
  return (await expireInventoryReservationsWithReport(options)).expired;
}

module.exports = {
  cardGraceMinutes,
  consumeReservation,
  countReservationExpiry,
  createInventoryReservation,
  expireInventoryReservations,
  expireInventoryReservationsWithReport,
  guestReferenceHash,
  ibanGraceMinutes,
  inventoryExpiryMethods,
  reactivateReservation,
  releaseReservation,
  reservationItems,
  reservationTtlMinutes,
  restockConsumedReservation,
  transitionOrderInventory,
};
