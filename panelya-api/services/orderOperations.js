const db = require('../db');
const { transitionOrderInventory } = require('./inventoryReservations');
const { transitionOrderPromotion } = require('./promotionEngine');
const { sendOrderStatusEmail } = require('./email');

const ORDER_TRANSITIONS = Object.freeze({
  pending_payment: ['confirmed', 'paid', 'cancelled'],
  confirmed: ['paid', 'processing', 'cancelled'],
  paid: ['processing', 'cancelled', 'partially_refunded', 'refunded'],
  processing: ['ready_to_ship', 'cancelled', 'partially_refunded', 'refunded'],
  ready_to_ship: ['processing', 'shipped', 'cancelled'],
  shipped: ['delivered', 'return_requested'],
  delivered: ['return_requested', 'partially_refunded', 'refunded'],
  return_requested: ['delivered', 'partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  cancelled: ['pending_payment', 'confirmed'],
  refunded: [],
});

const PAYMENT_TRANSITIONS = Object.freeze({
  pending: ['authorized', 'paid', 'failed', 'cancelled'],
  manual_pending: ['paid', 'failed', 'cancelled'],
  authorized: ['paid', 'failed', 'cancelled'],
  paid: ['partially_refunded', 'refunded'],
  failed: ['pending', 'manual_pending'],
  cancelled: ['pending', 'manual_pending'],
  partially_refunded: ['refunded'],
  refunded: [],
});

const FULFILLMENT_TRANSITIONS = Object.freeze({
  unfulfilled: ['processing', 'ready_to_ship', 'cancelled'],
  processing: ['ready_to_ship', 'shipped', 'cancelled'],
  ready_to_ship: ['processing', 'shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  returned: [],
  cancelled: ['unfulfilled'],
});

const TRANSITIONS = Object.freeze({
  order: ORDER_TRANSITIONS,
  payment: PAYMENT_TRANSITIONS,
  fulfillment: FULFILLMENT_TRANSITIONS,
});

const LEGACY_ACTIONS = Object.freeze({
  payment_pending: { order: 'pending_payment', payment: 'pending', fulfillment: 'unfulfilled' },
  new: { order: 'confirmed' },
  paid: { order: 'paid', payment: 'paid' },
  processing: { order: 'processing', fulfillment: 'processing' },
  shipped: { order: 'shipped', fulfillment: 'shipped' },
  delivered: { order: 'delivered', fulfillment: 'delivered' },
  cancelled: { order: 'cancelled', fulfillment: 'cancelled' },
});

function operationError(message, status, code, details) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}

function transitionsFor(domain, status) {
  const machine = TRANSITIONS[domain];
  if (!machine || !Object.hasOwn(machine, status)) return [];
  return [...machine[status]];
}

function assertTransition(domain, fromStatus, toStatus) {
  const machine = TRANSITIONS[domain];
  if (!machine || !Object.hasOwn(machine, fromStatus) || !Object.hasOwn(machine, toStatus)) {
    throw operationError('Durum alani veya degeri gecersiz', 400, 'ORDER_STATE_INVALID');
  }
  if (fromStatus === toStatus) return false;
  const validTransitions = transitionsFor(domain, fromStatus);
  if (!validTransitions.includes(toStatus)) {
    throw operationError('Bu siparis durum gecisi gecersiz', 409, 'ORDER_TRANSITION_INVALID', {
      domain,
      fromStatus,
      toStatus,
      validTransitions,
    });
  }
  return true;
}

function projectLegacyStatus(orderStatus, fallback = 'new') {
  return {
    pending_payment: 'payment_pending',
    confirmed: 'new',
    paid: 'paid',
    processing: 'processing',
    ready_to_ship: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
    cancelled: 'cancelled',
  }[orderStatus] || fallback;
}

function actorFromRequest(req, source = 'admin_api') {
  const userId = req.auth?.userId || null;
  return {
    type: userId ? 'staff' : 'system',
    id: userId,
    name: String(req.auth?.name || req.auth?.email || '').slice(0, 160),
    source,
  };
}

async function setOrderActorContext(client, actor = {}) {
  await client.query(
    `select
       set_config('app.order_actor_type', $1, true),
       set_config('app.order_actor_id', $2, true),
       set_config('app.order_event_source', $3, true),
       set_config('app.order_public_message', $4, true)`,
    [
      actor.type || 'system',
      actor.id || '',
      String(actor.source || 'application').slice(0, 80),
      String(actor.publicMessage || '').slice(0, 1000),
    ]
  );
}

function normalizeChanges(row, changes = {}) {
  const next = {
    order: changes.order || row.order_status,
    payment: changes.payment || row.payment_status,
    fulfillment: changes.fulfillment || row.fulfillment_status,
  };
  const changedDomains = Object.keys(next).filter((domain) => next[domain] !== row[`${domain}_status`]);
  for (const domain of changedDomains) {
    assertTransition(domain, row[`${domain}_status`], next[domain]);
  }
  return { next, changedDomains };
}

async function transitionOrderOperation(client, {
  organizationId,
  orderId,
  changes,
  expectedVersion,
  actor,
  transitionInventory = transitionOrderInventory,
  transitionPromotion = transitionOrderPromotion,
}) {
  const current = await client.query(
    'select * from orders where id = $1 and organization_id = $2 for update',
    [orderId, organizationId]
  );
  const row = current.rows[0];
  if (!row) throw operationError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');

  if (expectedVersion != null && Number(expectedVersion) !== Number(row.version)) {
    throw operationError('Siparis baska bir kullanici tarafindan guncellendi', 409, 'ORDER_VERSION_CONFLICT', {
      expectedVersion: Number(expectedVersion),
      currentVersion: Number(row.version),
    });
  }

  const { next, changedDomains } = normalizeChanges(row, changes);
  if (!changedDomains.length) return { order: row, previous: row, changed: false, changedDomains: [] };

  const nextLegacyStatus = changes.order
    ? projectLegacyStatus(next.order, row.status)
    : row.status;
  if (nextLegacyStatus !== row.status) {
    await transitionInventory(client, row.id, row.status, nextLegacyStatus, { organizationId });
    await transitionPromotion(client, row.id, row.status, nextLegacyStatus, { organizationId });
  }

  await setOrderActorContext(client, actor);
  const result = await client.query(
    `update orders
        set order_status = $1,
            payment_status = $2,
            fulfillment_status = $3,
            status = $4,
            updated_at = now()
      where id = $5 and organization_id = $6 and version = $7
      returning *`,
    [next.order, next.payment, next.fulfillment, nextLegacyStatus, row.id, organizationId, row.version]
  );
  if (!result.rows[0]) {
    throw operationError('Siparis baska bir kullanici tarafindan guncellendi', 409, 'ORDER_VERSION_CONFLICT');
  }
  return { order: result.rows[0], previous: row, changed: true, changedDomains };
}

function legacyChanges(status, row) {
  const changes = LEGACY_ACTIONS[status];
  if (!changes) throw operationError('Durum gecersiz', 400, 'ORDER_STATE_INVALID');
  if (status === 'payment_pending' && row?.payment_method === 'iban') {
    return { ...changes, payment: 'manual_pending' };
  }
  if (status === 'cancelled' && ['paid', 'partially_refunded', 'refunded'].includes(row?.payment_status)) {
    return { ...changes, payment: row.payment_status };
  }
  return changes;
}

async function transitionLegacyOrderStatus(client, options) {
  const lookup = await client.query(
    'select payment_method, payment_status from orders where id = $1 and organization_id = $2',
    [options.orderId, options.organizationId]
  );
  if (!lookup.rows[0]) throw operationError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  return transitionOrderOperation(client, {
    ...options,
    changes: legacyChanges(options.status, lookup.rows[0]),
  });
}

async function appendOrderEvent(client, {
  organizationId,
  orderId,
  eventType,
  actor,
  publicMessage = null,
  metadata = {},
}) {
  const order = await client.query(
    'select version from orders where id = $1 and organization_id = $2',
    [orderId, organizationId]
  );
  if (!order.rows[0]) throw operationError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  const result = await client.query(
    `insert into order_events
       (organization_id, order_id, event_type, actor_type, actor_id,
        public_message, internal_metadata, order_version)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     returning *`,
    [
      organizationId,
      orderId,
      eventType,
      actor?.type || 'system',
      actor?.id || null,
      publicMessage,
      JSON.stringify(metadata || {}),
      order.rows[0].version,
    ]
  );
  return result.rows[0];
}

function normalizedNoteContent(value) {
  const content = String(value || '').trim();
  if (!content || content.length > 4000) {
    throw operationError('Not 1-4000 karakter olmali', 400, 'ORDER_NOTE_INVALID');
  }
  return content;
}

function canMutateNote(note, actor, now = new Date()) {
  if (['super_admin', 'owner', 'admin'].includes(actor?.role)) return true;
  if (!actor?.id || String(note.author_user_id || '') !== String(actor.id)) return false;
  return now.getTime() - new Date(note.created_at).getTime() <= 24 * 60 * 60 * 1000;
}

async function createOrderNote(client, { organizationId, orderId, visibility, content, actor }) {
  const normalizedVisibility = visibility === 'customer' ? 'customer' : 'internal';
  const result = await client.query(
    `insert into order_notes
       (organization_id, order_id, visibility, author_user_id, author_name, content)
     select $1, o.id, $3, $4, $5, $6
       from orders o
      where o.id = $2 and o.organization_id = $1
     returning *`,
    [organizationId, orderId, normalizedVisibility, actor?.id || null, actor?.name || '', normalizedNoteContent(content)]
  );
  if (!result.rows[0]) throw operationError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  await appendOrderEvent(client, {
    organizationId,
    orderId,
    eventType: 'note_added',
    actor,
    publicMessage: normalizedVisibility === 'customer' ? result.rows[0].content : null,
    metadata: { noteId: result.rows[0].id, visibility: normalizedVisibility },
  });
  return result.rows[0];
}

async function updateOrderNote(client, { organizationId, orderId, noteId, content, actor }) {
  const current = await client.query(
    `select * from order_notes
      where id = $1 and order_id = $2 and organization_id = $3 and deleted_at is null
      for update`,
    [noteId, orderId, organizationId]
  );
  const note = current.rows[0];
  if (!note) throw operationError('Not bulunamadi', 404, 'ORDER_NOTE_NOT_FOUND');
  if (!canMutateNote(note, actor)) throw operationError('Bu notu duzenleme yetkiniz yok', 403, 'ORDER_NOTE_FORBIDDEN');
  const result = await client.query(
    `update order_notes set content = $1, edited_at = now(), updated_at = now()
      where id = $2 and order_id = $3 and organization_id = $4 returning *`,
    [normalizedNoteContent(content), noteId, orderId, organizationId]
  );
  await appendOrderEvent(client, {
    organizationId, orderId, eventType: 'note_edited', actor,
    publicMessage: note.visibility === 'customer' ? result.rows[0].content : null,
    metadata: { noteId: note.id, visibility: note.visibility },
  });
  return result.rows[0];
}

async function deleteOrderNote(client, { organizationId, orderId, noteId, actor }) {
  const current = await client.query(
    `select * from order_notes
      where id = $1 and order_id = $2 and organization_id = $3 and deleted_at is null
      for update`,
    [noteId, orderId, organizationId]
  );
  const note = current.rows[0];
  if (!note) throw operationError('Not bulunamadi', 404, 'ORDER_NOTE_NOT_FOUND');
  if (!canMutateNote(note, actor)) throw operationError('Bu notu silme yetkiniz yok', 403, 'ORDER_NOTE_FORBIDDEN');
  const result = await client.query(
    `update order_notes set deleted_at = now(), deleted_by = $1, updated_at = now()
      where id = $2 and order_id = $3 and organization_id = $4 returning *`,
    [actor?.id || null, noteId, orderId, organizationId]
  );
  await appendOrderEvent(client, {
    organizationId, orderId, eventType: 'note_deleted', actor,
    metadata: { noteId: note.id, visibility: note.visibility },
  });
  return result.rows[0];
}

function normalizeTag(input) {
  const name = String(input?.name || input || '').trim().slice(0, 40);
  const color = /^#[0-9a-f]{6}$/i.test(String(input?.color || '')) ? input.color : '#71717a';
  if (!name) throw operationError('Etiket adi zorunlu', 400, 'ORDER_TAG_INVALID');
  return { name, color };
}

async function createOrderTag(client, { organizationId, tag, actor }) {
  const normalized = normalizeTag(tag);
  const result = await client.query(
    `insert into order_tags (organization_id, name, color, created_by)
     values ($1,$2,$3,$4)
     on conflict (organization_id, (lower(btrim(name))))
     do update set color = excluded.color
     returning *`,
    [organizationId, normalized.name, normalized.color, actor?.id || null]
  );
  return result.rows[0];
}

async function replaceOrderTags(client, { organizationId, orderId, tagIds, actor }) {
  const ids = [...new Set((tagIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const order = await client.query('select id from orders where id = $1 and organization_id = $2', [orderId, organizationId]);
  if (!order.rows[0]) throw operationError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  const valid = ids.length
    ? await client.query('select id from order_tags where organization_id = $1 and id = any($2::bigint[]) order by id', [organizationId, ids])
    : { rows: [] };
  if (valid.rows.length !== ids.length) throw operationError('Etiketlerden biri bu magazaya ait degil', 400, 'ORDER_TAG_INVALID');
  await client.query('delete from order_tag_links where order_id = $1 and organization_id = $2', [orderId, organizationId]);
  if (ids.length) {
    await client.query(
      `insert into order_tag_links (organization_id, order_id, tag_id, attached_by)
       select $1, $2, unnest($3::bigint[]), $4`,
      [organizationId, orderId, ids, actor?.id || null]
    );
  }
  await appendOrderEvent(client, {
    organizationId, orderId, eventType: 'tags_replaced', actor, metadata: { tagIds: ids },
  });
  return valid.rows;
}

async function assignOrder(client, { organizationId, orderId, assignedUserId, actor }) {
  const order = await client.query('select id from orders where id = $1 and organization_id = $2', [orderId, organizationId]);
  if (!order.rows[0]) throw operationError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  if (assignedUserId) {
    const membership = await client.query(
      `select m.user_id, u.name, u.email
         from memberships m join app_users u on u.id = m.user_id
        where m.organization_id = $1 and m.user_id = $2 and m.status = 'active'`,
      [organizationId, assignedUserId]
    );
    if (!membership.rows[0]) throw operationError('Atanan kullanici aktif magaza uyesi degil', 403, 'ORDER_ASSIGNMENT_FORBIDDEN');
  }
  await client.query(
    `update order_assignments
        set active = false, unassigned_at = now(), unassigned_by = $3
      where order_id = $1 and organization_id = $2 and active`,
    [orderId, organizationId, actor?.id || null]
  );
  let assignment = null;
  if (assignedUserId) {
    const result = await client.query(
      `insert into order_assignments
         (organization_id, order_id, assigned_user_id, assigned_by)
       values ($1,$2,$3,$4) returning *`,
      [organizationId, orderId, assignedUserId, actor?.id || null]
    );
    assignment = result.rows[0];
  }
  await appendOrderEvent(client, {
    organizationId,
    orderId,
    eventType: assignedUserId ? 'assignment_changed' : 'assignment_cleared',
    actor,
    metadata: { assignedUserId: assignedUserId || null },
  });
  return assignment;
}

async function loadOrderOperations(client, organizationId, orderId) {
  const [events, notes, tags, assignment] = await Promise.all([
    client.query(
      `select e.*, u.name as actor_name, u.email as actor_email
         from order_events e left join app_users u on u.id = e.actor_id
        where e.organization_id = $1 and e.order_id = $2
        order by e.created_at desc, e.id desc`,
      [organizationId, orderId]
    ),
    client.query(
      `select * from order_notes
        where organization_id = $1 and order_id = $2 and deleted_at is null
        order by created_at desc`,
      [organizationId, orderId]
    ),
    client.query(
      `select t.* from order_tag_links l
         join order_tags t on t.id = l.tag_id and t.organization_id = l.organization_id
        where l.organization_id = $1 and l.order_id = $2 order by t.name`,
      [organizationId, orderId]
    ),
    client.query(
      `select a.*, u.name as assigned_user_name, u.email as assigned_user_email
         from order_assignments a join app_users u on u.id = a.assigned_user_id
        where a.organization_id = $1 and a.order_id = $2 and a.active
        limit 1`,
      [organizationId, orderId]
    ),
  ]);
  return {
    events: events.rows,
    notes: notes.rows,
    tags: tags.rows,
    assignment: assignment.rows[0] || null,
  };
}

function validTransitionsForOrder(order) {
  return {
    order: transitionsFor('order', order.order_status),
    payment: transitionsFor('payment', order.payment_status),
    fulfillment: transitionsFor('fulfillment', order.fulfillment_status),
  };
}

function packingListSnapshot(order, includePrices = false) {
  return {
    orderId: order.id,
    orderCode: order.order_code,
    generatedAt: new Date().toISOString(),
    customer: order.customer_snapshot || {},
    shippingAddress: order.shipping_address_snapshot || {},
    giftWrap: Boolean(order.gift_wrap),
    giftWrapTitle: (order.gift_wrap_snapshot && order.gift_wrap_snapshot.title) || '',
    giftNote: order.gift_note || '',
    items: (order.items || []).map((item) => ({
      productId: item.product_id,
      variantId: item.variant_id,
      name: item.name,
      sku: item.sku || '',
      variant: [item.color, item.size].filter(Boolean).join(' / '),
      quantity: Number(item.quantity),
      ...(includePrices ? { unitPrice: item.unit_price, lineTotal: item.line_total } : {}),
    })),
  };
}

async function deliverPendingOrderNotifications({
  pool = db.getSystemPool(),
  limit = 25,
  staleAfterMinutes = 10,
  send = sendOrderStatusEmail,
} = {}) {
  const client = await pool.connect();
  let rows = [];
  try {
    await client.query('begin');
    const claimed = await client.query(
      `select ob.id as outbox_id, ob.order_id, ob.organization_id, o.*, c.name as customer_name,
              c.email, c.phone, c.address
         from order_notification_outbox ob
         join orders o on o.id = ob.order_id and o.organization_id = ob.organization_id
         left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
        where (ob.status in ('pending','failed') and ob.next_attempt_at <= now())
           or (ob.status = 'processing'
               and ob.claimed_at <= now() - make_interval(mins => $2::int))
        order by ob.id
        for update of ob skip locked
        limit $1`,
      [
        Math.min(Math.max(Number(limit) || 25, 1), 100),
        Math.min(Math.max(Number(staleAfterMinutes) || 10, 1), 1440),
      ]
    );
    rows = claimed.rows;
    if (rows.length) {
      await client.query(
        `update order_notification_outbox
            set status = 'processing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
          where id = any($1::bigint[])`,
        [rows.map((row) => row.outbox_id)]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const results = [];
  for (const row of rows) {
    try {
      await send(row, {
        name: row.customer_name,
        email: row.email,
        phone: row.phone,
        address: row.address,
      });
      await pool.query(
        `update order_notification_outbox
            set status = 'sent', sent_at = now(), last_error = null, updated_at = now()
          where id = $1 and status = 'processing'`,
        [row.outbox_id]
      );
      results.push({ id: row.outbox_id, status: 'sent' });
    } catch (error) {
      await pool.query(
        `update order_notification_outbox
            set status = 'failed', last_error = $2,
                next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, least(attempts, 6)))::int),
                updated_at = now()
          where id = $1 and status = 'processing'`,
        [row.outbox_id, String(error.message || error).slice(0, 500)]
      );
      results.push({ id: row.outbox_id, status: 'failed' });
    }
  }
  return results;
}

module.exports = {
  FULFILLMENT_TRANSITIONS,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  actorFromRequest,
  appendOrderEvent,
  assertTransition,
  assignOrder,
  canMutateNote,
  createOrderNote,
  createOrderTag,
  deleteOrderNote,
  deliverPendingOrderNotifications,
  legacyChanges,
  loadOrderOperations,
  normalizeChanges,
  packingListSnapshot,
  projectLegacyStatus,
  replaceOrderTags,
  setOrderActorContext,
  transitionLegacyOrderStatus,
  transitionOrderOperation,
  transitionsFor,
  updateOrderNote,
  validTransitionsForOrder,
};
