const { applyInventoryMovement, syncProductStock } = require('../../services/inventory');
const { createInventoryReservation } = require('../../services/inventoryReservations');
const { nextOrderCode } = require('../../services/orderCodes');
const { setOrderActorContext, transitionOrderOperation } = require('../../services/orderOperations');
const { calculateRefundQuote } = require('./refundCalculator');
const { createRefundProvider } = require('./refundProviders');

function workflowError(message, status = 409, code = 'RETURN_WORKFLOW_INVALID', details) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}

function returnWindowDays(settings = {}) {
  const value = Number(settings?.shoppingNotes?.returns?.days ?? settings.returnDays ?? 14);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), 365) : 14;
}

function assertRequestEligibility({ order, requestType, deliveredAt, days = 14, now = new Date() }) {
  const fulfillment = order.fulfillment_status;
  if (requestType === 'cancellation') {
    if (!['unfulfilled', 'processing', 'ready_to_ship'].includes(fulfillment)) {
      throw workflowError('Kargoya verilen siparis icin iptal talebi acilamaz', 409, 'CANCELLATION_TOO_LATE');
    }
    return null;
  }
  if (fulfillment !== 'delivered') {
    throw workflowError('Iade veya degisim yalniz teslim edilen siparis icin acilabilir', 409, 'RETURN_NOT_DELIVERED');
  }
  const delivered = new Date(deliveredAt || order.updated_at);
  if (Number.isNaN(delivered.getTime())) throw workflowError('Teslim tarihi belirlenemedi', 409, 'RETURN_DATE_UNKNOWN');
  const deadline = new Date(delivered.getTime() + Number(days) * 86400000);
  if (now.getTime() > deadline.getTime()) {
    throw workflowError('Iade suresi dolmus', 409, 'RETURN_WINDOW_EXPIRED', { deadline: deadline.toISOString() });
  }
  return deadline;
}

async function appendReturnEvent(client, {
  organizationId, requestId, eventType, fromStatus = null, toStatus = null,
  actorType, actorId = null, publicMessage = null, metadata = {},
}) {
  const result = await client.query(
    `insert into return_events
       (organization_id, return_request_id, event_type, from_status, to_status,
        actor_type, actor_id, public_message, internal_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     returning *`,
    [organizationId, requestId, eventType, fromStatus, toStatus, actorType,
      actorId == null ? null : String(actorId), publicMessage, JSON.stringify(metadata || {})]
  );
  return result.rows[0];
}

async function loadReturnDetail(client, organizationId, requestId, { customerAccountId = null, lock = false } = {}) {
  const params = [organizationId, requestId];
  const accountScope = customerAccountId == null ? '' : `and rr.customer_account_id = $${params.push(customerAccountId)}`;
  const result = await client.query(
    `select rr.*, o.order_code, o.total as order_total, o.payment_status, o.fulfillment_status
       from return_requests rr
       join orders o on o.id = rr.order_id and o.organization_id = rr.organization_id
      where rr.organization_id = $1 and rr.id = $2 ${accountScope}
      ${lock ? 'for update of rr' : ''}`,
    params
  );
  const request = result.rows[0];
  if (!request) throw workflowError('Iade talebi bulunamadi', 404, 'RETURN_NOT_FOUND');
  const items = await client.query(
      `select ri.*, oi.product_name, oi.selected_color, oi.selected_size, oi.sku,
              oi.unit_price, oi.product_id, oi.variant_id
         from return_items ri
         join order_items oi on oi.id = ri.order_item_id and oi.organization_id = ri.organization_id
        where ri.organization_id = $1 and ri.return_request_id = $2 order by ri.id`,
      [organizationId, requestId]
    );
  const media = await client.query(
      `select rm.upload_asset_id, ua.url, ua.mime_type
         from return_media rm
         join upload_assets ua on ua.id = rm.upload_asset_id and ua.organization_id = rm.organization_id
        where rm.organization_id = $1 and rm.return_request_id = $2 order by rm.attached_at`,
      [organizationId, requestId]
    );
  const refunds = await client.query(
      `select id, provider, amount, currency, status, provider_ref, reason, requested_at, processed_at
         from refunds where organization_id = $1 and return_request_id = $2 order by requested_at`,
      [organizationId, requestId]
    );
  const events = await client.query(
      `select id, event_type, from_status, to_status, actor_type, actor_id,
              public_message, created_at
         from return_events where organization_id = $1 and return_request_id = $2 order by created_at, id`,
      [organizationId, requestId]
    );
  return { ...request, items: items.rows, media: media.rows, refunds: refunds.rows, events: events.rows };
}

async function createReturnRequest(client, { organization, account, input, now = new Date() }) {
  const orderResult = await client.query(
    `select o.*,
            (select max(e.created_at) from order_events e
              where e.organization_id = o.organization_id and e.order_id = o.id
                and e.event_type = 'fulfillment_status_changed' and e.to_status = 'delivered') as delivered_at
       from orders o
      where o.organization_id = $1 and o.id = $2 and o.customer_id = $3
      for update`,
    [organization.id, input.orderId, account.customer_id]
  );
  const order = orderResult.rows[0];
  if (!order) throw workflowError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  const deadline = assertRequestEligibility({
    order,
    requestType: input.requestType,
    deliveredAt: order.delivered_at,
    days: returnWindowDays(organization.store_settings || {}),
    now,
  });

  const itemIds = input.items.map((item) => item.orderItemId);
  const itemResult = await client.query(
    `select id, quantity from order_items
      where organization_id = $1 and order_id = $2 and id = any($3::bigint[])
      for update`,
    [organization.id, order.id, itemIds]
  );
  if (itemResult.rows.length !== itemIds.length) throw workflowError('Siparis kalemi bulunamadi', 404, 'ORDER_ITEM_NOT_FOUND');
  const previous = await client.query(
    `select ri.order_item_id, coalesce(sum(ri.quantity), 0)::int as quantity
       from return_items ri
       join return_requests rr on rr.id = ri.return_request_id and rr.organization_id = ri.organization_id
      where rr.organization_id = $1 and rr.order_id = $2
        and rr.status not in ('rejected','cancelled') and ri.order_item_id = any($3::bigint[])
      group by ri.order_item_id`,
    [organization.id, order.id, itemIds]
  );
  const ordered = new Map(itemResult.rows.map((item) => [Number(item.id), Number(item.quantity)]));
  const already = new Map(previous.rows.map((item) => [Number(item.order_item_id), Number(item.quantity)]));
  for (const item of input.items) {
    const available = ordered.get(item.orderItemId) - (already.get(item.orderItemId) || 0);
    if (item.quantity > available) {
      throw workflowError('Talep adedi kalan uygun siparis adedini asamaz', 409, 'RETURN_QUANTITY_EXCEEDED', {
        orderItemId: item.orderItemId, available,
      });
    }
  }

  const inserted = await client.query(
    `insert into return_requests
       (organization_id, order_id, customer_account_id, request_type, reason_code,
        customer_note, return_deadline)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning *`,
    [organization.id, order.id, account.id, input.requestType, input.reasonCode,
      input.customerNote, deadline?.toISOString() || null]
  );
  const request = inserted.rows[0];
  for (const item of input.items) {
    await client.query(
      `insert into return_items
         (organization_id, return_request_id, order_item_id, quantity, reason_code,
          requested_resolution, replacement_variant_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [organization.id, request.id, item.orderItemId, item.quantity, item.reasonCode,
        item.requestedResolution, item.replacementVariantId]
    );
  }
  if (input.mediaAssetIds.length) {
    const media = await client.query(
      `insert into return_media (organization_id, return_request_id, upload_asset_id)
       select $1, $2, ua.id from upload_assets ua
        where ua.organization_id = $1 and ua.id = any($3::uuid[]) and ua.status <> 'deleted'
       on conflict do nothing returning upload_asset_id`,
      [organization.id, request.id, input.mediaAssetIds]
    );
    if (media.rows.length !== input.mediaAssetIds.length) throw workflowError('Iade medyasi bulunamadi', 404, 'RETURN_MEDIA_NOT_FOUND');
  }
  await appendReturnEvent(client, {
    organizationId: organization.id, requestId: request.id, eventType: 'request_created',
    toStatus: 'requested', actorType: 'customer', actorId: account.id,
    publicMessage: 'Talebiniz alindi.', metadata: { type: input.requestType },
  });
  return loadReturnDetail(client, organization.id, request.id, { customerAccountId: account.id });
}

async function createExchangeOrder(client, { organizationId, detail, decision, actor }) {
  const overrides = new Map(decision.replacements.map((row) => [row.returnItemId, row.variantId]));
  const requested = detail.items.map((item) => ({
    returnItemId: Number(item.id),
    variantId: overrides.get(Number(item.id)) || Number(item.replacement_variant_id || 0),
    quantity: Number(item.quantity),
  }));
  if (requested.some((item) => !item.variantId)) {
    throw workflowError('Degisim icin her kalemde yeni varyant secilmelidir', 400, 'EXCHANGE_VARIANT_REQUIRED');
  }
  const variants = await client.query(
    `select pv.id, pv.product_id, pv.color, pv.size, pv.sku, p.name
       from product_variants pv
       join products p on p.id = pv.product_id and p.organization_id = pv.organization_id
      where pv.organization_id = $1 and pv.id = any($2::bigint[]) and pv.is_active`,
    [organizationId, requested.map((item) => item.variantId)]
  );
  const variantById = new Map(variants.rows.map((row) => [Number(row.id), row]));
  if (variantById.size !== new Set(requested.map((item) => item.variantId)).size) {
    throw workflowError('Degisim varyanti bulunamadi veya pasif', 404, 'EXCHANGE_VARIANT_NOT_FOUND');
  }
  const original = await client.query(
    'select * from orders where organization_id = $1 and id = $2 for update',
    [organizationId, detail.order_id]
  );
  const order = original.rows[0];
  const orderCode = await nextOrderCode(client);
  await setOrderActorContext(client, { type: 'staff', id: actor.id, source: 'exchange_order' });
  const replacement = await client.query(
    `insert into orders
       (organization_id, order_code, customer_id, total, subtotal, status, payment_method,
        payment_provider, note, customer_snapshot, shipping_address_snapshot)
     values ($1,$2,$3,0,0,'paid','iban','manual',$4,$5::jsonb,$6::jsonb)
     returning *`,
    [organizationId, orderCode, order.customer_id, `Degisim siparisi: ${detail.id}`,
      JSON.stringify(order.customer_snapshot || {}), JSON.stringify(order.shipping_address_snapshot || {})]
  );
  const reservationItems = [];
  for (const item of requested) {
    const variant = variantById.get(item.variantId);
    const orderItem = await client.query(
      `insert into order_items
         (organization_id, order_id, product_id, variant_id, product_name,
          selected_color, selected_size, sku, quantity, unit_price)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0) returning *`,
      [organizationId, replacement.rows[0].id, variant.product_id, variant.id, variant.name,
        variant.color || '', variant.size || '', variant.sku || '', item.quantity]
    );
    reservationItems.push(orderItem.rows[0]);
    await client.query(
      `update return_items set replacement_variant_id = $1, updated_at = now()
        where organization_id = $2 and id = $3`,
      [variant.id, organizationId, item.returnItemId]
    );
  }
  await createInventoryReservation(client, {
    organizationId, orderId: replacement.rows[0].id, customerId: order.customer_id,
    items: reservationItems, idempotencyKey: `exchange:${detail.id}`, ttlMinutes: 10080,
  });
  await client.query(
    'update return_requests set replacement_order_id = $1, updated_at = now() where organization_id = $2 and id = $3',
    [replacement.rows[0].id, organizationId, detail.id]
  );
  return replacement.rows[0];
}

async function decideReturnRequest(client, { organizationId, requestId, decision, actor }) {
  const detail = await loadReturnDetail(client, organizationId, requestId, { lock: true });
  if (detail.status !== 'requested') throw workflowError('Bu talep daha once karara baglanmis', 409, 'RETURN_ALREADY_DECIDED');
  const updated = await client.query(
    `update return_requests
        set status = $1,
            approved_at = case when $1 = 'approved' then now() else approved_at end,
            approved_by = case when $1 = 'approved' then $2 else approved_by end,
            rejected_at = case when $1 = 'rejected' then now() else rejected_at end,
            rejected_by = case when $1 = 'rejected' then $2 else rejected_by end,
            rejection_reason = $3, internal_note = $4,
            return_shipping_code = $5, return_instructions = $6, updated_at = now()
      where organization_id = $7 and id = $8 returning *`,
    [decision.status, actor.id, decision.rejectionReason || null, decision.internalNote,
      decision.returnShippingCode || null, decision.returnInstructions || null,
      organizationId, requestId]
  );
  if (decision.status === 'approved') {
    const orderResult = await client.query(
      'select * from orders where organization_id = $1 and id = $2 for update',
      [organizationId, detail.order_id]
    );
    const order = orderResult.rows[0];
    if (detail.request_type === 'cancellation') {
      await transitionOrderOperation(client, {
        organizationId, orderId: order.id,
        changes: {
          order: 'cancelled', fulfillment: 'cancelled',
          ...(!['paid', 'partially_refunded', 'refunded'].includes(order.payment_status) ? { payment: 'cancelled' } : {}),
        },
        expectedVersion: order.version,
        actor: { type: 'staff', id: actor.id, source: 'return_approval', publicMessage: decision.publicMessage },
      });
    } else if (order.order_status === 'delivered') {
      await transitionOrderOperation(client, {
        organizationId, orderId: order.id, changes: { order: 'return_requested' }, expectedVersion: order.version,
        actor: { type: 'staff', id: actor.id, source: 'return_approval', publicMessage: decision.publicMessage },
      });
    }
    if (detail.request_type === 'exchange') {
      await createExchangeOrder(client, { organizationId, detail, decision, actor });
    }
  }
  await appendReturnEvent(client, {
    organizationId, requestId, eventType: `request_${decision.status}`,
    fromStatus: detail.status, toStatus: decision.status, actorType: 'staff', actorId: actor.id,
    publicMessage: decision.publicMessage || null,
    metadata: decision.status === 'rejected' ? { rejectionReason: decision.rejectionReason } : {},
  });
  return { ...detail, ...updated.rows[0] };
}

async function receiveReturnRequest(client, { organizationId, requestId, receipt, actor }) {
  const detail = await loadReturnDetail(client, organizationId, requestId, { lock: true });
  if (!['approved', 'awaiting_shipment', 'in_transit'].includes(detail.status)) {
    throw workflowError('Talep teslim almaya uygun degil', 409, 'RETURN_RECEIPT_INVALID');
  }
  const itemById = new Map(detail.items.map((item) => [Number(item.id), item]));
  const productIds = [];
  for (const received of receipt.items) {
    const item = itemById.get(received.returnItemId);
    if (!item) throw workflowError('Iade kalemi bulunamadi', 404, 'RETURN_ITEM_NOT_FOUND');
    if (received.receivedQuantity > Number(item.quantity)) throw workflowError('Teslim adedi talep adedini asamaz', 409, 'RETURN_RECEIPT_QUANTITY_EXCEEDED');
    if (received.restockQuantity > 0 && !item.variant_id) throw workflowError('Varyantsiz kalem stok geri kabulune uygun degil', 409, 'RETURN_VARIANT_REQUIRED');
    await client.query(
      `update return_items set received_quantity = $1, restock_quantity = $2,
              item_condition = $3, updated_at = now()
        where organization_id = $4 and id = $5`,
      [received.receivedQuantity, received.restockQuantity, received.condition, organizationId, item.id]
    );
    if (received.restockQuantity > 0) {
      await applyInventoryMovement(client, {
        organizationId, variantId: Number(item.variant_id), movementType: 'return',
        onHandDelta: received.restockQuantity, referenceType: 'return_request', referenceId: requestId,
        idempotencyKey: `return:${requestId}:item:${item.id}:restock`,
        reason: 'Returned item accepted after inspection', actorType: 'admin', actorId: actor.id,
        syncProduct: false,
      });
      productIds.push(Number(item.product_id));
    }
  }
  if (productIds.length) await syncProductStock(client, productIds, { organizationId });
  await client.query(
    `update return_requests set status = 'inspected', received_at = now(), inspected_at = now(),
            internal_note = case when $1 = '' then internal_note else $1 end, updated_at = now()
      where organization_id = $2 and id = $3`,
    [receipt.internalNote, organizationId, requestId]
  );
  await appendReturnEvent(client, {
    organizationId, requestId, eventType: 'items_inspected', fromStatus: detail.status,
    toStatus: 'inspected', actorType: 'staff', actorId: actor.id,
    publicMessage: receipt.publicMessage || null,
    metadata: { items: receipt.items.map((item) => ({ id: item.returnItemId, received: item.receivedQuantity, restocked: item.restockQuantity })) },
  });
  return loadReturnDetail(client, organizationId, requestId);
}

async function createRefund(client, { organizationId, requestId, input, actor }) {
  const detail = await loadReturnDetail(client, organizationId, requestId, { lock: true });
  if (!['approved', 'received', 'inspected', 'resolved'].includes(detail.status)) {
    throw workflowError('Refund icin talep onaylanmis veya teslim alinmis olmali', 409, 'REFUND_NOT_APPROVED');
  }
  const existing = await client.query(
    'select * from refunds where organization_id = $1 and idempotency_key = $2 limit 1',
    [organizationId, input.idempotencyKey]
  );
  if (existing.rows[0]) return { refund: existing.rows[0], replay: true };

  const orderResult = await client.query(
    'select * from orders where organization_id = $1 and id = $2 for update',
    [organizationId, detail.order_id]
  );
  const order = orderResult.rows[0];
  if (!['paid', 'partially_refunded'].includes(order.payment_status)) {
    throw workflowError('Odenmemis siparis refund edilemez', 409, 'ORDER_NOT_PAID');
  }
  const orderItems = await client.query(
    'select * from order_items where organization_id = $1 and order_id = $2 order by id for update',
    [organizationId, order.id]
  );
  const returnItemByOrderItem = new Map(detail.items.map((item) => [Number(item.order_item_id), item]));
  const refundedQuantities = await client.query(
    `select ra.order_item_id, coalesce(sum(ra.quantity), 0)::int as quantity
       from refund_allocations ra
       join refunds r on r.id = ra.refund_id and r.organization_id = ra.organization_id
      where r.organization_id = $1 and r.order_id = $2 and r.status = 'succeeded'
        and ra.allocation_type = 'item' and ra.order_item_id is not null
      group by ra.order_item_id`,
    [organizationId, order.id]
  );
  const alreadyRefundedQuantity = new Map(refundedQuantities.rows.map((item) => [
    Number(item.order_item_id), Number(item.quantity),
  ]));
  for (const item of input.items) {
    const approved = returnItemByOrderItem.get(item.orderItemId);
    const availableQuantity = approved
      ? Number(approved.quantity) - (alreadyRefundedQuantity.get(item.orderItemId) || 0)
      : 0;
    if (!approved || item.quantity > availableQuantity) {
      throw workflowError('Refund adedi onaylanan iade adedini asamaz', 409, 'REFUND_QUANTITY_EXCEEDED', {
        orderItemId: item.orderItemId,
        approvedQuantity: Number(approved?.quantity || 0),
        alreadyRefundedQuantity: alreadyRefundedQuantity.get(item.orderItemId) || 0,
        availableQuantity,
      });
    }
  }
  if (input.refundShipping) {
    const shippingRefund = await client.query(
      `select 1 from refund_allocations ra
        join refunds r on r.id = ra.refund_id and r.organization_id = ra.organization_id
       where r.organization_id = $1 and r.order_id = $2 and r.status = 'succeeded'
         and ra.allocation_type = 'shipping' limit 1`,
      [organizationId, order.id]
    );
    if (shippingRefund.rows[0]) throw workflowError('Kargo tutari daha once refund edildi', 409, 'SHIPPING_ALREADY_REFUNDED');
  }
  const previous = await client.query(
    `select coalesce(sum(amount), 0) as total from refunds
      where organization_id = $1 and order_id = $2 and status = 'succeeded'`,
    [organizationId, order.id]
  );
  const quote = calculateRefundQuote({
    order, orderItems: orderItems.rows, requestedItems: input.items,
    previousRefundTotal: previous.rows[0].total, refundShipping: input.refundShipping,
  });
  const provider = createRefundProvider(input.provider);
  const providerResult = await provider.createRefund({
    order, amount: quote.amount, currency: quote.currency, idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  });
  const refundResult = await client.query(
    `insert into refunds
       (organization_id, order_id, return_request_id, provider, amount, currency, status,
        provider_ref, idempotency_key, reason, requested_by, processed_at, raw_response)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     returning *`,
    [organizationId, order.id, requestId, provider.name, quote.amount, quote.currency,
      providerResult.status, providerResult.providerRef, input.idempotencyKey, input.reason,
      actor.id, providerResult.processedAt || null, JSON.stringify(providerResult.raw || {})]
  );
  const refund = refundResult.rows[0];
  for (const allocation of quote.allocations) {
    await client.query(
      `insert into refund_allocations
         (organization_id, refund_id, order_item_id, allocation_type, amount, quantity, metadata)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [organizationId, refund.id, allocation.orderItemId, allocation.type,
        allocation.amount, allocation.quantity, JSON.stringify(allocation.metadata || {})]
    );
  }
  if (providerResult.status === 'succeeded') {
    const nextRefunded = Math.round((Number(previous.rows[0].total) + quote.amount) * 100) / 100;
    const fullyRefunded = nextRefunded >= Number(order.total);
    await setOrderActorContext(client, { type: 'staff', id: actor.id, source: 'refund' });
    await client.query(
      `update orders set refunded_total = $1, payment_status = $2, order_status = $3, updated_at = now()
        where organization_id = $4 and id = $5`,
      [nextRefunded, fullyRefunded ? 'refunded' : 'partially_refunded',
        fullyRefunded ? 'refunded' : 'partially_refunded', organizationId, order.id]
    );
    await client.query(
      `update return_requests set status = 'resolved', resolution = $1,
              resolved_at = now(), updated_at = now()
        where organization_id = $2 and id = $3`,
      [`${quote.amount.toFixed(2)} ${quote.currency} refund`, organizationId, requestId]
    );
    await appendReturnEvent(client, {
      organizationId, requestId, eventType: 'refund_succeeded', fromStatus: detail.status,
      toStatus: 'resolved', actorType: 'staff', actorId: actor.id,
      publicMessage: 'Para iadesi kaydedildi.', metadata: { refundId: refund.id, amount: quote.amount, currency: quote.currency },
    });
  }
  return { refund, quote, replay: false };
}

module.exports = {
  appendReturnEvent,
  assertRequestEligibility,
  createRefund,
  createExchangeOrder,
  createReturnRequest,
  decideReturnRequest,
  loadReturnDetail,
  receiveReturnRequest,
  returnWindowDays,
};
