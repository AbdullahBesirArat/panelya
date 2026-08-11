const { getShippingProvider } = require('./providers');
const { SHIPMENT_STATUSES } = require('./validation');

const TRANSITIONS = {
  pending: new Set(['label_ready', 'shipped', 'cancelled', 'failed']),
  label_ready: new Set(['shipped', 'cancelled', 'failed']),
  shipped: new Set(['in_transit', 'delivered', 'failed', 'returned']),
  in_transit: new Set(['delivered', 'failed', 'returned']),
  delivered: new Set(['returned']),
  failed: new Set(['cancelled', 'returned']),
  cancelled: new Set(),
  returned: new Set(),
};

function workflowError(message, status = 409, code = 'SHIPMENT_WORKFLOW_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function assertShipmentTransition(from, to) {
  if (from === to) return;
  if (!TRANSITIONS[from]?.has(to)) throw workflowError(`${from} durumundan ${to} durumuna gecilemez`);
}

function actorValues(actor = {}, fallback = 'system') {
  return {
    type: actor.type || actor.actorType || fallback,
    id: actor.id == null ? null : String(actor.id),
  };
}

async function appendShipmentEvent(client, {
  organizationId, shipmentId, eventType, fromStatus = null, toStatus = null,
  actor, publicMessage = '', metadata = {}, providerEventKey = null,
}) {
  const source = actorValues(actor);
  await client.query(
    `insert into shipment_events
      (organization_id, shipment_id, event_type, from_status, to_status, actor_type,
       actor_id, public_message, metadata, provider_event_key)
     values ($1,$2,$3,$4,$5,$6,$7,nullif($8,''),$9::jsonb,$10)`,
    [organizationId, shipmentId, eventType, fromStatus, toStatus, source.type,
      source.id, publicMessage, JSON.stringify(metadata), providerEventKey]
  );
}

async function loadShipmentDetail(client, organizationId, shipmentId) {
  const shipmentResult = await client.query(
    `select s.*, o.order_code
       from shipments s
       join orders o on o.id = s.order_id and o.organization_id = s.organization_id
      where s.organization_id = $1 and s.id = $2`,
    [organizationId, shipmentId]
  );
  const shipment = shipmentResult.rows[0];
  if (!shipment) throw workflowError('Shipment bulunamadi', 404, 'SHIPMENT_NOT_FOUND');
  const items = await client.query(
    `select si.id, si.order_item_id, si.quantity, oi.product_name, oi.selected_color,
            oi.selected_size, oi.sku, oi.quantity as ordered_quantity
       from shipment_items si
       join order_items oi on oi.id = si.order_item_id and oi.organization_id = si.organization_id
      where si.organization_id = $1 and si.shipment_id = $2 order by si.id`,
    [organizationId, shipmentId]
  );
  const events = await client.query(
    `select id, event_type, from_status, to_status, actor_type, actor_id,
            public_message, metadata, created_at
       from shipment_events where organization_id = $1 and shipment_id = $2
      order by created_at, id`,
    [organizationId, shipmentId]
  );
  const labels = await client.query(
    `select id, upload_asset_id, provider_label_ref, filename, content_type, created_at
       from shipping_labels where organization_id = $1 and shipment_id = $2
      order by created_at, id`,
    [organizationId, shipmentId]
  );
  return { ...shipment, items: items.rows, events: events.rows, labels: labels.rows };
}

async function loadRateSnapshot(client, organizationId, rateId) {
  if (!rateId) return {};
  const result = await client.query(
    `select sr.id, sr.name, sr.calculation_type, sr.amount, sr.per_kg_amount,
            sr.currency, sr.estimated_days_min, sr.estimated_days_max,
            sp.id as profile_id, sp.provider
       from shipping_rates sr
       join shipping_zone_rules zr on zr.id = sr.shipping_zone_rule_id and zr.organization_id = sr.organization_id
       join shipping_zones z on z.id = zr.shipping_zone_id and z.organization_id = sr.organization_id
       join shipping_profiles sp on sp.id = z.shipping_profile_id and sp.organization_id = sr.organization_id
      where sr.organization_id = $1 and sr.id = $2 and sr.is_active`,
    [organizationId, rateId]
  );
  if (!result.rows[0]) throw workflowError('Kargo rate bulunamadi', 400, 'SHIPPING_RATE_NOT_FOUND');
  return result.rows[0];
}

async function validateShipmentItems(client, organizationId, orderId, items, { returnOfShipmentId = null } = {}) {
  const ids = items.map((item) => item.orderItemId);
  const ordered = await client.query(
    `select id, quantity from order_items
      where organization_id = $1 and order_id = $2 and id = any($3::bigint[])
      for update`,
    [organizationId, orderId, ids]
  );
  if (ordered.rows.length !== ids.length) throw workflowError('Siparis kalemi bulunamadi', 400, 'ORDER_ITEM_NOT_FOUND');
  const caps = new Map(ordered.rows.map((item) => [Number(item.id), Number(item.quantity)]));
  let allocated;
  if (returnOfShipmentId) {
    const source = await client.query(
      `select si.order_item_id, si.quantity
         from shipment_items si join shipments s on s.id = si.shipment_id and s.organization_id = si.organization_id
        where si.organization_id = $1 and si.shipment_id = $2 and s.order_id = $3`,
      [organizationId, returnOfShipmentId, orderId]
    );
    const sourceCaps = new Map(source.rows.map((item) => [Number(item.order_item_id), Number(item.quantity)]));
    for (const item of items) caps.set(item.orderItemId, Math.min(caps.get(item.orderItemId) || 0, sourceCaps.get(item.orderItemId) || 0));
    allocated = await client.query(
      `select si.order_item_id, coalesce(sum(si.quantity),0)::int as quantity
         from shipment_items si join shipments s on s.id = si.shipment_id and s.organization_id = si.organization_id
        where si.organization_id = $1 and s.return_of_shipment_id = $2 and s.status not in ('cancelled','failed')
        group by si.order_item_id`,
      [organizationId, returnOfShipmentId]
    );
  } else {
    allocated = await client.query(
      `select si.order_item_id, coalesce(sum(si.quantity),0)::int as quantity
         from shipment_items si join shipments s on s.id = si.shipment_id and s.organization_id = si.organization_id
        where si.organization_id = $1 and s.order_id = $2 and s.return_of_shipment_id is null
          and s.status not in ('cancelled','failed')
        group by si.order_item_id`,
      [organizationId, orderId]
    );
  }
  const used = new Map(allocated.rows.map((item) => [Number(item.order_item_id), Number(item.quantity)]));
  for (const item of items) {
    if (item.quantity + (used.get(item.orderItemId) || 0) > (caps.get(item.orderItemId) || 0)) {
      throw workflowError('Shipment adedi siparis veya kaynak shipment adedini asamaz', 409, 'SHIPMENT_QUANTITY_EXCEEDED');
    }
  }
}

async function recomputeOrderFulfillment(client, organizationId, orderId) {
  const totals = await client.query(
    `select coalesce((select sum(quantity) from order_items where organization_id = $1 and order_id = $2),0)::int as ordered,
            coalesce((select sum(si.quantity) from shipment_items si join shipments s
              on s.id = si.shipment_id and s.organization_id = si.organization_id
              where si.organization_id = $1 and s.order_id = $2 and s.return_of_shipment_id is null
                and s.status in ('shipped','in_transit','delivered','returned')),0)::int as shipped,
            coalesce((select sum(si.quantity) from shipment_items si join shipments s
              on s.id = si.shipment_id and s.organization_id = si.organization_id
              where si.organization_id = $1 and s.order_id = $2 and s.return_of_shipment_id is null
                and s.status in ('delivered','returned')),0)::int as delivered,
            coalesce((select sum(si.quantity) from shipment_items si join shipments s
              on s.id = si.shipment_id and s.organization_id = si.organization_id
              where si.organization_id = $1 and s.order_id = $2 and s.return_of_shipment_id is null
                and s.status = 'returned'),0)::int as returned`,
    [organizationId, orderId]
  );
  const { ordered, shipped, delivered, returned } = totals.rows[0];
  let fulfillment = 'unfulfilled';
  let legacy = null;
  let orderStatus = null;
  if (ordered > 0 && returned >= ordered) {
    fulfillment = 'returned'; legacy = 'delivered';
  } else if (ordered > 0 && delivered >= ordered) {
    fulfillment = 'delivered'; legacy = 'delivered'; orderStatus = 'delivered';
  } else if (shipped > 0) {
    fulfillment = shipped >= ordered ? 'shipped' : 'processing';
    legacy = shipped >= ordered ? 'shipped' : 'processing';
    orderStatus = shipped >= ordered ? 'shipped' : 'processing';
  }
  const result = await client.query(
    `update orders set fulfillment_status = $1,
       status = coalesce($2, status),
       order_status = case when order_status in ('cancelled','partially_refunded','refunded') then order_status else coalesce($3, order_status) end,
       updated_at = now(), version = version + 1
     where organization_id = $4 and id = $5 returning *`,
    [fulfillment, legacy, orderStatus, organizationId, orderId]
  );
  return result.rows[0];
}

async function createShipment(client, { organizationId, input, actor = {}, providerOverride = null }) {
  const order = await client.query(
    `select * from orders where organization_id = $1 and id = $2 for update`,
    [organizationId, input.orderId]
  );
  if (!order.rows[0]) throw workflowError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  if (order.rows[0].order_status === 'cancelled') throw workflowError('Iptal siparis icin shipment olusturulamaz');
  if (!['paid', 'partially_refunded', 'refunded'].includes(order.rows[0].payment_status)) {
    throw workflowError('Odeme onaylanmadan shipment olusturulamaz', 409, 'ORDER_NOT_PAID');
  }
  await validateShipmentItems(client, organizationId, input.orderId, input.items, {
    returnOfShipmentId: input.returnOfShipmentId,
  });
  const rateSnapshot = await loadRateSnapshot(client, organizationId, input.rateId);
  const provider = providerOverride || getShippingProvider(input.provider);
  const providerResult = input.returnOfShipmentId
    ? await provider.createReturnShipment(input)
    : await provider.createShipment(input);
  const status = providerResult.status || 'pending';
  if (!SHIPMENT_STATUSES.has(status)) throw workflowError('Provider gecersiz shipment durumu dondurdu', 502);
  const result = await client.query(
    `insert into shipments
      (organization_id, order_id, provider, provider_shipment_ref, status, carrier_name,
       service_name, tracking_number, tracking_url, package_weight_kg, package_length_cm,
       package_width_cm, package_height_cm, package_desi, rate_snapshot,
       estimated_delivery_at, shipped_at, return_of_shipment_id, return_request_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,
       case when $5 in ('shipped','in_transit','delivered','returned') then now() else null end,$17,$18,$19)
     returning *`,
    [organizationId, input.orderId, input.provider, providerResult.providerShipmentRef,
      status, providerResult.carrierName || input.carrierName, providerResult.serviceName || input.serviceName,
      providerResult.trackingNumber || input.trackingNumber, providerResult.trackingUrl || input.trackingUrl,
      input.package.weightKg, input.package.lengthCm, input.package.widthCm, input.package.heightCm,
      input.package.desi, JSON.stringify(rateSnapshot), input.estimatedDeliveryAt,
      input.returnOfShipmentId, input.returnRequestId, actor.id || null]
  );
  for (const item of input.items) {
    await client.query(
      `insert into shipment_items (organization_id, shipment_id, order_item_id, quantity)
       values ($1,$2,$3,$4)`,
      [organizationId, result.rows[0].id, item.orderItemId, item.quantity]
    );
  }
  await appendShipmentEvent(client, {
    organizationId, shipmentId: result.rows[0].id, eventType: 'shipment_created',
    toStatus: status, actor, publicMessage: input.returnOfShipmentId ? 'Iade gonderisi olusturuldu.' : 'Gonderi olusturuldu.',
  });
  if (!input.returnOfShipmentId) {
    await client.query(
      `update orders set shipping_company = nullif($1,''), tracking_number = nullif($2,''),
         tracking_url = nullif($3,''), shipped_at = coalesce(shipped_at, $4), updated_at = now()
       where organization_id = $5 and id = $6`,
      [result.rows[0].carrier_name, result.rows[0].tracking_number, result.rows[0].tracking_url,
        result.rows[0].shipped_at, organizationId, input.orderId]
    );
    await recomputeOrderFulfillment(client, organizationId, input.orderId);
  }
  return loadShipmentDetail(client, organizationId, result.rows[0].id);
}

async function transitionShipment(client, {
  organizationId, shipmentId, input, actor = {}, providerEventKey = null,
}) {
  const current = await client.query(
    `select * from shipments where organization_id = $1 and id = $2 for update`,
    [organizationId, shipmentId]
  );
  const shipment = current.rows[0];
  if (!shipment) throw workflowError('Shipment bulunamadi', 404, 'SHIPMENT_NOT_FOUND');
  assertShipmentTransition(shipment.status, input.status);
  const trackingNumber = input.trackingNumber === undefined ? shipment.tracking_number : input.trackingNumber;
  const trackingUrl = input.trackingUrl === undefined ? shipment.tracking_url : input.trackingUrl;
  await client.query(
    `update shipments set status = $1, tracking_number = $2, tracking_url = $3,
       shipped_at = case when $1 in ('shipped','in_transit','delivered','returned') then coalesce(shipped_at, now()) else shipped_at end,
       delivered_at = case when $1 = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
       cancelled_at = case when $1 = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
       updated_at = now() where organization_id = $4 and id = $5`,
    [input.status, trackingNumber, trackingUrl, organizationId, shipmentId]
  );
  await appendShipmentEvent(client, {
    organizationId, shipmentId, eventType: 'status_changed', fromStatus: shipment.status,
    toStatus: input.status, actor, publicMessage: input.publicMessage, providerEventKey,
  });
  if (!shipment.return_of_shipment_id) {
    await client.query(
      `update orders set shipping_company = nullif($1,''), tracking_number = nullif($2,''),
       tracking_url = nullif($3,''), updated_at = now() where organization_id = $4 and id = $5`,
      [shipment.carrier_name, trackingNumber, trackingUrl, organizationId, shipment.order_id]
    );
    await recomputeOrderFulfillment(client, organizationId, shipment.order_id);
  }
  return loadShipmentDetail(client, organizationId, shipmentId);
}

async function cancelShipment(client, { organizationId, shipmentId, actor = {} }) {
  const current = await client.query(
    `select * from shipments where organization_id = $1 and id = $2 for update`,
    [organizationId, shipmentId]
  );
  if (!current.rows[0]) throw workflowError('Shipment bulunamadi', 404, 'SHIPMENT_NOT_FOUND');
  const provider = getShippingProvider(current.rows[0].provider);
  const outcome = await provider.cancelShipment(current.rows[0]);
  return transitionShipment(client, {
    organizationId, shipmentId,
    input: { status: outcome.status || 'cancelled', publicMessage: 'Gonderi iptal edildi.' }, actor,
  });
}

async function attachLabel(client, { organizationId, shipmentId, uploadAssetId, filename, actor = {} }) {
  const asset = await client.query(
    `select ua.id, ua.original_filename, ua.content_type
       from upload_assets ua join shipments s on s.organization_id = ua.organization_id
      where ua.organization_id = $1 and ua.id = $2 and s.id = $3 and ua.status = 'ready' limit 1`,
    [organizationId, uploadAssetId, shipmentId]
  );
  if (!asset.rows[0]) throw workflowError('Etiket dosyasi bulunamadi', 404, 'LABEL_ASSET_NOT_FOUND');
  const result = await client.query(
    `insert into shipping_labels (organization_id, shipment_id, upload_asset_id, filename, content_type)
     values ($1,$2,$3,$4,$5) returning *`,
    [organizationId, shipmentId, uploadAssetId,
      String(filename || asset.rows[0].original_filename || 'kargo-etiketi').slice(0, 240), asset.rows[0].content_type]
  );
  await appendShipmentEvent(client, {
    organizationId, shipmentId, eventType: 'label_attached', actor,
    publicMessage: 'Kargo etiketi hazirlandi.', metadata: { labelId: result.rows[0].id },
  });
  return result.rows[0];
}

module.exports = {
  TRANSITIONS,
  appendShipmentEvent,
  assertShipmentTransition,
  attachLabel,
  cancelShipment,
  createShipment,
  loadShipmentDetail,
  recomputeOrderFulfillment,
  transitionShipment,
  validateShipmentItems,
};
