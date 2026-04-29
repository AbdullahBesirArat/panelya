const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { reserveStock, syncStockForStatusChange } = require('../services/inventory');
const { expirePendingOrders } = require('../services/pendingOrders');
const { cartTotal, priceCartItems } = require('../services/cartPricing');
const { auditLog } = require('../services/audit');
const { sanitizeCustomer } = require('../services/validation');
const { resolveOrganization } = require('../services/tenant');
const { nextOrderCode } = require('../services/orderCodes');
const { insertOrderItems } = require('../services/orderItems');
const { normalizeCheckoutOptions } = require('../services/checkoutPayload');
const { assertPlanCapacity } = require('../services/planLimits');
const { fetchOrderCustomer, upsertCustomer } = require('../services/customers');
const { sendOrderStatusEmail } = require('../services/email');

const router = express.Router();
const ORDER_STATUSES = ['new', 'payment_pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid'];
const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ORDER_CREATE_RATE_LIMIT || 60),
  message: 'Cok fazla siparis denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function safePaging(limit, offset, defaultLimit = 100) {
  return {
    limit: Math.min(Math.max(Number(limit) || defaultLimit, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

function publicOrderView(row) {
  if (!row) return null;
  return {
    id: row.id,
    order_code: row.order_code,
    total: row.total,
    status: row.status,
    payment_provider: row.payment_provider,
    payment_method: row.payment_method,
    note: row.note,
    gift_wrap: row.gift_wrap,
    shipping_fee: row.shipping_fee,
    shipping_company: row.shipping_company,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url,
    shipped_at: row.shipped_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    customer: {
      name: row.customer_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
    },
    items: Array.isArray(row.items) ? row.items : [],
  };
}

function orderDetailView(row) {
  if (!row) return null;
  return {
    ...row,
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
    },
    items: Array.isArray(row.items) ? row.items : [],
  };
}

async function notifyOrderUpdate(order, customer) {
  await sendOrderStatusEmail(order, customer).catch((error) => {
    console.warn('Order status email gonderilemedi', {
      orderCode: order?.order_code,
      message: error.message,
    });
  });
}

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: Siparis listesi
 *     tags: [Orders]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [new, payment_pending, processing, shipped, delivered, cancelled, paid]
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Siparis dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Order'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     summary: Public siparis olusturur
 *     tags: [Orders]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customer, items]
 *             properties:
 *               organizationSlug:
 *                 type: string
 *                 example: panelya
 *               customer:
 *                 type: object
 *                 required: [name, email, phone]
 *                 properties:
 *                   name: { type: string, example: Northstar Labs }
 *                   email: { type: string, format: email, example: ops@northstarlabs.co }
 *                   phone: { type: string, example: '+90 212 555 0101' }
 *                   address: { type: string, example: Maslak, Istanbul }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity]
 *                   properties:
 *                     product_id: { type: integer, example: 1 }
 *                     quantity: { type: integer, example: 1 }
 *     responses:
 *       201:
 *         description: Siparis olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 */
router.get('/', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const { status, q = '', limit = 100, offset = 0 } = req.query;
    const paging = safePaging(limit, offset);
    const params = [organization.id, `%${String(q).slice(0, 120)}%`];
    const filters = ['o.organization_id = $1', '(o.order_code ilike $2 or c.name ilike $2 or c.email ilike $2)'];

    if (status) {
      if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Durum gecersiz' });
      params.push(status);
      filters.push(`o.status = $${params.length}`);
    }

    params.push(paging.limit, paging.offset);

    const result = await db.query(
      `select o.*, c.name as customer, c.email, c.phone, c.address,
        coalesce(
          string_agg(
            oi.product_name ||
            case when oi.selected_color <> '' or oi.selected_size <> ''
              then ' (' || concat_ws(' / ', nullif(oi.selected_color, ''), nullif(oi.selected_size, '')) || ')'
              else ''
            end ||
            ' x' || oi.quantity,
            ', ' order by oi.id
          ),
          'Siparis kalemi yok'
        ) as items
       from orders o
       left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
       left join order_items oi on oi.order_id = o.id
       where ${filters.join(' and ')}
       group by o.id, c.id
       order by o.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/expire-pending', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const olderThanMinutes = Math.min(
      Math.max(Number(req.body.olderThanMinutes || process.env.PAYMENT_PENDING_TIMEOUT_MINUTES || 30), 5),
      1440
    );
    const limit = Math.min(Math.max(Number(req.body.limit || process.env.PAYMENT_PENDING_EXPIRE_LIMIT || 100), 1), 500);
    const expired = await expirePendingOrders({ olderThanMinutes, limit });
    await auditLog(req, {
      action: 'EXPIRE_PENDING',
      resourceType: 'order',
      newValue: { olderThanMinutes, expiredCount: expired.length },
    });
    res.json({ ok: true, expiredCount: expired.length, expired });
  } catch (err) {
    next(err);
  }
});

router.get('/lookup', async (req, res, next) => {
  try {
    const orderCode = String(req.query.orderCode || '').trim().slice(0, 40);
    if (!orderCode) return res.status(400).json({ error: 'Siparis kodu zorunlu' });
    const customerEmail = String(req.query.email || req.query.customerEmail || '').trim().toLowerCase().slice(0, 254);
    if (!req.auth && (!customerEmail || !customerEmail.includes('@'))) {
      return res.status(400).json({ error: 'Siparis takibi icin email zorunlu' });
    }

    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const params = [organization.id, orderCode];
    const filters = ['o.organization_id = $1', 'o.order_code = $2'];
    if (!req.auth) {
      params.push(customerEmail);
      filters.push(`lower(c.email) = $${params.length}`);
    }

    const result = await db.query(
      `select
         o.id,
         o.order_code,
         o.total,
         o.status,
         o.payment_provider,
         o.payment_method,
         o.note,
         o.gift_wrap,
         o.shipping_fee,
         o.shipping_company,
         o.tracking_number,
         o.tracking_url,
         o.shipped_at,
         o.created_at,
         o.updated_at,
         c.name as customer_name,
         c.email,
         c.phone,
         c.address,
         coalesce(
           json_agg(
             json_build_object(
               'product_id', oi.product_id,
               'name', oi.product_name,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price
             )
             order by oi.id
           ) filter (where oi.id is not null),
           '[]'::json
         ) as items
       from orders o
       left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
       left join order_items oi on oi.order_id = o.id
       where ${filters.join(' and ')}
       group by o.id, c.id
       limit 1`,
      params
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Siparis bulunamadi' });
    res.json(publicOrderView(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/', createOrderLimiter, async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const customer = sanitizeCustomer(req.body.customer || {});

    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await assertPlanCapacity(client, organization.id, 'orders_month');
    const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });
    const subtotal = cartTotal(items);
    const checkoutOptions = normalizeCheckoutOptions(req.body, organization.store_settings || {}, subtotal);
    const total = subtotal + checkoutOptions.shippingFee;

    const customerResult = await upsertCustomer(client, organization.id, customer);

    const orderCode = await nextOrderCode(client);
    const orderResult = await client.query(
      `insert into orders
       (organization_id, order_code, customer_id, total, status, payment_method, note, gift_wrap, shipping_fee)
       values ($1, $2, $3, $4, 'new', $5, $6, $7, $8)
       returning *`,
      [
        organization.id,
        orderCode,
        customerResult.id,
        total,
        checkoutOptions.paymentMethod,
        checkoutOptions.note,
        checkoutOptions.giftWrap,
        checkoutOptions.shippingFee,
      ]
    );

    await insertOrderItems(client, orderResult.rows[0].id, items);

    await reserveStock(client, items);

    await client.query('commit');
    res.status(201).json(orderResult.rows[0]);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select
         o.*,
         c.name as customer_name,
         c.email,
         c.phone,
         c.address,
         coalesce(
           json_agg(
             json_build_object(
               'id', oi.id,
               'product_id', oi.product_id,
               'variant_id', oi.variant_id,
               'name', oi.product_name,
               'color', oi.selected_color,
               'size', oi.selected_size,
               'sku', oi.sku,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price,
               'line_total', oi.quantity * oi.unit_price
             )
             order by oi.id
           ) filter (where oi.id is not null),
           '[]'::json
         ) as items
       from orders o
       left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
       left join order_items oi on oi.order_id = o.id
       where o.id = $1 and o.organization_id = $2
       group by o.id, c.id
       limit 1`,
      [req.params.id, organization.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Siparis bulunamadi' });
    res.json(orderDetailView(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/orders/{id}/status:
 *   put:
 *     summary: Siparis durumunu gunceller
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [new, payment_pending, processing, shipped, delivered, cancelled, paid]
 *                 example: shipped
 *     responses:
 *       200:
 *         description: Durum guncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.put('/:id/status', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const { status } = req.body;
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Durum gecersiz' });

    await client.query('begin');
    const organization = await resolveOrganization(req, client);

    const current = await client.query(
      'select * from orders where id = $1 and organization_id = $2 for update',
      [req.params.id, organization.id]
    );
    if (!current.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Siparis bulunamadi' });
    }

    await syncStockForStatusChange(client, current.rows[0].id, current.rows[0].status, status);

    const result = await client.query(
      'update orders set status = $1, updated_at = now() where id = $2 and organization_id = $3 returning *',
      [status, req.params.id, organization.id]
    );

    await auditLog(req, {
      action: 'UPDATE_STATUS',
      resourceType: 'order',
      resourceId: req.params.id,
      oldValue: { status: current.rows[0].status },
      newValue: { status },
    });
    await client.query('commit');
    const customer = await fetchOrderCustomer(db, result.rows[0].id, organization.id);
    await notifyOrderUpdate(result.rows[0], customer);
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/shipping', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    const {
      shipping_company = '',
      tracking_number = '',
      tracking_url = '',
      shipped_at = null,
    } = req.body;

    const oldResult = await client.query(
      `select shipping_company, tracking_number, tracking_url, shipped_at, status
       from orders
       where id = $1 and organization_id = $2
       for update`,
      [req.params.id, organization.id]
    );

    if (!oldResult.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Siparis bulunamadi' });
    }

    const result = await client.query(
      `update orders
       set shipping_company = $1,
           tracking_number = $2,
           tracking_url = $3,
           shipped_at = nullif($4, '')::timestamptz,
           status = case when status in ('new', 'paid', 'processing') and nullif($2, '') is not null then 'shipped' else status end,
           updated_at = now()
       where id = $5 and organization_id = $6
       returning *`,
      [
        String(shipping_company).slice(0, 120),
        String(tracking_number).slice(0, 120),
        String(tracking_url).slice(0, 500),
        shipped_at,
        req.params.id,
        organization.id,
      ]
    );

    await auditLog(req, {
      action: 'UPDATE_SHIPPING',
      resourceType: 'order',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
      newValue: {
        shipping_company: result.rows[0].shipping_company,
        tracking_number: result.rows[0].tracking_number,
        tracking_url: result.rows[0].tracking_url,
        shipped_at: result.rows[0].shipped_at,
        status: result.rows[0].status,
      },
    });
    await client.query('commit');
    const customer = await fetchOrderCustomer(db, result.rows[0].id, organization.id);
    await notifyOrderUpdate(result.rows[0], customer);
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
