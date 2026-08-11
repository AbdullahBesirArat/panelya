'use strict';

// A29 public, versioned external API.
//
// The rule that shapes every handler here: this file contains NO business logic. Each route
// validates its input, calls the same canonical service the dashboard calls, and formats the
// result. Duplicating the logic would mean an integration could reach a state the dashboard
// cannot produce — a stock level written without a ledger entry, an order status set without
// a transition check, a paid order nobody paid for.
//
// In particular there is deliberately no way to set a payment state from here. Payment
// status is owned by the verified provider callback and the manual-authorization flow; an
// API key that could write `paid` would be a way to fabricate revenue.

const express = require('express');
const db = require('../db');
const { requireApiKey, requireScope } = require('../middleware/apiKeyAuth');
const {
  apiError, enforceMonthlyQuota, externalErrorHandler, idempotent, parsePagination,
  rateLimitApiKey, requireJsonBody,
} = require('../middleware/externalApi');
const service = require('../modules/integrations/service');
const outbox = require('../modules/integrations/outbox');
const inventory = require('../services/inventory');
const orderOperations = require('../services/orderOperations');
const { EVENT_TYPES } = require('../modules/integrations/events');

const router = express.Router();

router.use(requireApiKey);
router.use(rateLimitApiKey);
router.use(enforceMonthlyQuota);
router.use(requireJsonBody);

// Every external response says which request produced it, so a tenant reporting a problem
// can be correlated with our logs without guessing.
router.use((req, res, next) => {
  res.set('X-Request-Id', req.id);
  next();
});

/** Runs a handler inside the tenant context derived from the API key. */
function tenantRoute(run, { status = 200 } = {}) {
  return async (req, res, next) => {
    try {
      const result = await db.withTenantContext(req.organizationId, (client) =>
        run({ req, res, client, organizationId: req.organizationId }));
      if (res.headersSent) return undefined;
      return res.status(result?.statusOverride || status).json(result?.body ?? result);
    } catch (error) {
      return next(error);
    }
  };
}

// ---------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------

// The external projection. Internal columns (cost prices, supplier notes, internal flags)
// are not listed, so adding one to the table never silently publishes it.
const PRODUCT_FIELDS = `id, name, status, price, sale_price, stock,
  category_id, created_at, updated_at`;

function productPayload(row) {
  return {
    id: Number(row.id),
    name: row.name,
    status: row.status,
    price: row.price,
    sale_price: row.sale_price,
    stock: Number(row.stock || 0),
    category_id: row.category_id ? Number(row.category_id) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * @swagger
 * /v1/products:
 *   get:
 *     tags: [External API]
 *     summary: Urunleri listeler (cursor sayfalama)
 *     description: >
 *       products:read yetkisi gerektirir. Siralama ve filtre alanlari sunucu tarafinda
 *       izinli listeden secilir; istemci serbest bir sort ifadesi veremez.
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Onceki yanittaki next_cursor degeri.
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Urun listesi
 *       401: { $ref: '#/components/responses/ExternalError' }
 *       403: { $ref: '#/components/responses/ExternalError' }
 *       429: { $ref: '#/components/responses/ExternalError' }
 */
router.get('/products', requireScope('products:read'), tenantRoute(async ({ req, client, organizationId }) => {
  const page = parsePagination(req.query, { allowedSort: ['created_at', 'id'], defaultSort: 'created_at' });
  const params = [organizationId];
  const filters = ['organization_id = $1'];
  if (req.query.status) {
    params.push(String(req.query.status).slice(0, 20));
    filters.push(`status = $${params.length}`);
  }
  if (page.cursor) {
    params.push(page.cursor.id);
    filters.push(page.direction === 'desc' ? `id < $${params.length}` : `id > $${params.length}`);
  }
  params.push(page.limit + 1);
  const result = await client.query(
    `select ${PRODUCT_FIELDS} from products
      where ${filters.join(' and ')}
      order by id ${page.direction}
      limit $${params.length}`,
    params
  );
  const rows = result.rows.slice(0, page.limit);
  return {
    data: rows.map(productPayload),
    has_more: result.rows.length > page.limit,
    next_cursor: result.rows.length > page.limit
      ? Buffer.from(JSON.stringify({ id: Number(rows[rows.length - 1].id) })).toString('base64url')
      : null,
  };
}));

router.get('/products/:id', requireScope('products:read'), tenantRoute(async ({ req, client, organizationId }) => {
  const result = await client.query(
    `select ${PRODUCT_FIELDS} from products where organization_id = $1 and id = $2`,
    [organizationId, Number(req.params.id)]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error('Urun bulunamadi'), { status: 404, code: 'PRODUCT_NOT_FOUND' });
  }
  return { data: productPayload(result.rows[0]) };
}));

// ---------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------

router.get('/inventory/:productId', requireScope('inventory:read'), tenantRoute(async ({ req, client, organizationId }) => {
  // Balances live on the product and its variants — the same rows the ledger keeps in step.
  // There is no separate inventory table to read, and inventing one here would be a second
  // source of truth for stock.
  const result = await client.query(
    `select p.id as product_id, null::bigint as variant_id, p.stock, p.updated_at
       from products p where p.organization_id = $1 and p.id = $2
     union all
     select v.product_id, v.id as variant_id, v.stock, v.updated_at
       from product_variants v where v.organization_id = $1 and v.product_id = $2
     order by variant_id nulls first`,
    [organizationId, Number(req.params.productId)]
  );
  if (!result.rows.length) {
    throw Object.assign(new Error('Urun bulunamadi'), { status: 404, code: 'PRODUCT_NOT_FOUND' });
  }
  return {
    data: result.rows.map((row) => ({
      product_id: Number(row.product_id),
      variant_id: row.variant_id ? Number(row.variant_id) : null,
      stock: Number(row.stock || 0),
      updated_at: row.updated_at,
    })),
  };
}));

/**
 * Stock is written through the A13 ledger service, never with an UPDATE. That service is
 * what records the movement, keeps the product-level aggregate in step and enforces the
 * non-negative invariant; bypassing it would leave a balance no ledger explains.
 */
/**
 * @swagger
 * /v1/inventory/adjustments:
 *   post:
 *     tags: [External API]
 *     summary: Stok seviyesini ayarlar
 *     description: >
 *       inventory:write yetkisi gerektirir. Yazma A13 stok defteri servisinden gecer; dogrudan
 *       UPDATE yapilmaz, boylece her bakiye degisikliginin bir hareket kaydi olur.
 *       Idempotency-Key zorunludur: ayni anahtar + ayni govde ayni sonucu dondurur,
 *       ayni anahtar + farkli govde 409 IDEMPOTENCY_KEY_REUSED ile reddedilir.
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, maxLength: 200 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [product_id, stock]
 *             properties:
 *               product_id: { type: integer }
 *               variant_id: { type: integer, nullable: true }
 *               stock: { type: integer, minimum: 0 }
 *               reason: { type: string, maxLength: 200 }
 *     responses:
 *       201: { description: Stok guncellendi }
 *       400: { $ref: '#/components/responses/ExternalError' }
 *       403: { $ref: '#/components/responses/ExternalError' }
 *       409: { $ref: '#/components/responses/ExternalError' }
 *       415: { $ref: '#/components/responses/ExternalError' }
 */
router.post(
  '/inventory/adjustments',
  requireScope('inventory:write'),
  idempotent('POST /v1/inventory/adjustments'),
  tenantRoute(async ({ req, client, organizationId }) => {
    const productId = Number(req.body?.product_id);
    const stock = Number(req.body?.stock);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw Object.assign(new Error('product_id zorunlu'), { status: 400, code: 'PRODUCT_ID_REQUIRED' });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      throw Object.assign(new Error('stock negatif olmayan bir tam sayi olmali'), {
        status: 400, code: 'STOCK_INVALID',
      });
    }
    const result = await inventory.setInventoryBalance(client, {
      organizationId,
      productId,
      variantId: req.body?.variant_id == null ? null : Number(req.body.variant_id),
      stock,
      reason: String(req.body?.reason || 'External API adjustment').slice(0, 200),
      actorType: 'api_key',
      actorId: null,
    });

    // Emitted in the SAME transaction as the ledger write, so an event cannot exist for a
    // movement that rolled back.
    await outbox.emitEvent(client, {
      organizationId,
      eventType: 'inventory.changed',
      aggregateId: `${productId}:${req.body?.variant_id ?? 'default'}`,
      aggregateVersion: await outbox.nextAggregateVersion(client, {
        organizationId, aggregateType: 'inventory', aggregateId: `${productId}:${req.body?.variant_id ?? 'default'}`,
      }),
      data: {
        productId,
        variantId: req.body?.variant_id ?? null,
        available: stock,
        reason: 'api_adjustment',
      },
    });
    return { data: { product_id: productId, stock, applied: Boolean(result) } };
  }, { status: 201 })
);

// ---------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------

function orderPayload(row) {
  return {
    id: Number(row.id),
    order_code: row.order_code,
    status: row.status,
    payment_status: row.payment_status,
    total: row.total,
    currency: row.currency || 'TRY',
    customer_id: row.customer_id ? Number(row.customer_id) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/orders', requireScope('orders:read'), tenantRoute(async ({ req, client, organizationId }) => {
  const page = parsePagination(req.query, { allowedSort: ['created_at', 'id'], defaultSort: 'created_at' });
  const params = [organizationId];
  const filters = ['organization_id = $1'];
  if (req.query.status) {
    params.push(String(req.query.status).slice(0, 30));
    filters.push(`status = $${params.length}`);
  }
  if (page.cursor) {
    params.push(page.cursor.id);
    filters.push(page.direction === 'desc' ? `id < $${params.length}` : `id > $${params.length}`);
  }
  params.push(page.limit + 1);
  const result = await client.query(
    `select id, order_code, status, payment_status, total, currency, customer_id, created_at, updated_at
       from orders where ${filters.join(' and ')} order by id ${page.direction} limit $${params.length}`,
    params
  );
  const rows = result.rows.slice(0, page.limit);
  return {
    data: rows.map(orderPayload),
    has_more: result.rows.length > page.limit,
    next_cursor: result.rows.length > page.limit
      ? Buffer.from(JSON.stringify({ id: Number(rows[rows.length - 1].id) })).toString('base64url')
      : null,
  };
}));

router.get('/orders/:id', requireScope('orders:read'), tenantRoute(async ({ req, client, organizationId }) => {
  const result = await client.query(
    `select id, order_code, status, payment_status, total, currency, customer_id, created_at, updated_at
       from orders where organization_id = $1 and id = $2`,
    [organizationId, Number(req.params.id)]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error('Siparis bulunamadi'), { status: 404, code: 'ORDER_NOT_FOUND' });
  }
  return { data: orderPayload(result.rows[0]) };
}));

/**
 * Status changes go through the A16 state machine. An illegal transition is refused there,
 * with the same rules the dashboard obeys.
 *
 * `paid` is explicitly not reachable: payment state belongs to the verified provider
 * callback and the manual-authorization flow, and an API key must not be able to assert it.
 */
const API_FORBIDDEN_ORDER_STATUSES = new Set(['paid', 'payment_pending', 'refunded']);

/**
 * @swagger
 * /v1/orders/{id}/status:
 *   post:
 *     tags: [External API]
 *     summary: Siparis durumunu degistirir
 *     description: >
 *       orders:write yetkisi gerektirir. Gecis A16 durum makinesinden gecer; gecersiz bir
 *       gecis orada reddedilir. Odeme durumlari (paid, payment_pending, refunded) bu uctan
 *       ASLA yazilamaz: odeme durumu dogrulanmis saglayici callback'ine ve manuel yetkilendirme
 *       akisina aittir, bir API anahtarina degil.
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, maxLength: 200 }
 *     responses:
 *       200: { description: Siparis guncellendi }
 *       403:
 *         description: Yetki yok veya odeme durumu talep edildi (ORDER_PAYMENT_STATUS_FORBIDDEN)
 *       404: { $ref: '#/components/responses/ExternalError' }
 */
router.post(
  '/orders/:id/status',
  requireScope('orders:write'),
  idempotent('POST /v1/orders/:id/status'),
  tenantRoute(async ({ req, client, organizationId }) => {
    const status = String(req.body?.status || '').trim();
    if (!status) {
      throw Object.assign(new Error('status zorunlu'), { status: 400, code: 'ORDER_STATUS_REQUIRED' });
    }
    if (API_FORBIDDEN_ORDER_STATUSES.has(status)) {
      throw Object.assign(new Error('Odeme durumu API ile degistirilemez'), {
        status: 403, code: 'ORDER_PAYMENT_STATUS_FORBIDDEN',
      });
    }
    const orderId = Number(req.params.id);
    const before = await client.query(
      'select status from orders where organization_id = $1 and id = $2',
      [organizationId, orderId]
    );
    if (!before.rows[0]) {
      throw Object.assign(new Error('Siparis bulunamadi'), { status: 404, code: 'ORDER_NOT_FOUND' });
    }

    await orderOperations.transitionLegacyOrderStatus(client, {
      organizationId,
      orderId,
      status,
      actorType: 'api_key',
      actorId: null,
      reason: String(req.body?.reason || 'External API').slice(0, 200),
    });

    const after = await client.query(
      `select id, order_code, status, payment_status, total, currency, customer_id, created_at, updated_at
         from orders where organization_id = $1 and id = $2`,
      [organizationId, orderId]
    );
    await outbox.emitEvent(client, {
      organizationId,
      eventType: 'order.status_changed',
      aggregateId: String(orderId),
      aggregateVersion: await outbox.nextAggregateVersion(client, {
        organizationId, aggregateType: 'order', aggregateId: String(orderId),
      }),
      data: {
        id: orderId,
        orderCode: after.rows[0].order_code,
        status: after.rows[0].status,
        previousStatus: before.rows[0].status,
      },
    });
    return { data: orderPayload(after.rows[0]) };
  })
);

// ---------------------------------------------------------------------------------------
// Customers (minimised)
// ---------------------------------------------------------------------------------------

/**
 * Customer data is the most sensitive thing on this platform, so the external projection is
 * an allowlist of exactly what an integration plausibly needs. Auth credentials, tokens,
 * tax identities and addresses are not in it, and cannot be requested into it.
 */
router.get('/customers', requireScope('customers:read'), tenantRoute(async ({ req, client, organizationId }) => {
  const page = parsePagination(req.query, { allowedSort: ['created_at', 'id'], defaultSort: 'created_at' });
  const params = [organizationId];
  const filters = ['organization_id = $1'];
  if (page.cursor) {
    params.push(page.cursor.id);
    filters.push(page.direction === 'desc' ? `id < $${params.length}` : `id > $${params.length}`);
  }
  params.push(page.limit + 1);
  const result = await client.query(
    `select id, name, email, created_at from customers
      where ${filters.join(' and ')} order by id ${page.direction} limit $${params.length}`,
    params
  );
  const rows = result.rows.slice(0, page.limit);
  return {
    data: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      email: row.email,
      created_at: row.created_at,
    })),
    has_more: result.rows.length > page.limit,
    next_cursor: result.rows.length > page.limit
      ? Buffer.from(JSON.stringify({ id: Number(rows[rows.length - 1].id) })).toString('base64url')
      : null,
  };
}));

// ---------------------------------------------------------------------------------------
// Webhooks (same canonical service the dashboard uses)
// ---------------------------------------------------------------------------------------

router.get('/webhooks/events', requireScope('webhooks:read'), tenantRoute(async () => ({
  data: EVENT_TYPES.filter((eventType) => eventType !== 'webhook.test'),
})));

router.get('/webhooks', requireScope('webhooks:read'), tenantRoute(async ({ client, organizationId }) => ({
  data: await service.listWebhookEndpoints(client, { organizationId }),
})));

router.post(
  '/webhooks',
  requireScope('webhooks:write'),
  idempotent('POST /v1/webhooks'),
  tenantRoute(async ({ req, res, client, organizationId }) => {
    const created = await service.createWebhookEndpoint(client, {
      organizationId,
      name: req.body?.name,
      url: req.body?.url,
      events: req.body?.events,
    });
    // The signing secret is returned exactly once, here, and this response must not be
    // cached by anything between us and the caller.
    res.set('Cache-Control', 'no-store');
    return { statusOverride: 201, body: { data: created.endpoint, secret: created.secret } };
  })
);

router.delete('/webhooks/:id', requireScope('webhooks:write'), tenantRoute(async ({ req, client, organizationId }) => ({
  data: await service.setEndpointStatus(client, {
    organizationId, endpointId: Number(req.params.id), status: 'archived',
  }),
})));

// A method the router does not implement is a 405 with the allowed set, not a 404: telling
// a client "wrong verb" is the difference between a five-second fix and an afternoon.
router.use((req, res) => apiError(res, req, {
  status: 404, code: 'NOT_FOUND', message: 'Bu endpoint bulunamadi',
}));

router.use(externalErrorHandler);

module.exports = router;
