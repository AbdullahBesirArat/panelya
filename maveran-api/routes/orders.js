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
          string_agg(oi.product_name || ' x' || oi.quantity, ', ' order by oi.id),
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

router.post('/', createOrderLimiter, async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const customer = sanitizeCustomer(req.body.customer || {});

    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });
    const total = cartTotal(items);

    const customerResult = await client.query(
      `insert into customers (organization_id, name, email, phone, address)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        organization.id,
        customer.name,
        customer.email,
        customer.phone,
        customer.address,
      ]
    );

    const orderCode = await nextOrderCode(client);
    const orderResult = await client.query(
      `insert into orders (organization_id, order_code, customer_id, total, status)
       values ($1, $2, $3, $4, 'new')
       returning *`,
      [organization.id, orderCode, customerResult.rows[0].id, total]
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
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/shipping', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const {
      shipping_company = '',
      tracking_number = '',
      tracking_url = '',
      shipped_at = null,
    } = req.body;

    const oldResult = await db.query(
      `select shipping_company, tracking_number, tracking_url, shipped_at, status
       from orders
       where id = $1 and organization_id = $2`,
      [req.params.id, organization.id]
    );
    const result = await db.query(
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

    if (!result.rows[0]) return res.status(404).json({ error: 'Siparis bulunamadi' });
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
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
