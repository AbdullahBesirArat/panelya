const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();

/**
 * @swagger
 * /api/customers:
 *   get:
 *     summary: Musteri listesi ve harcama ozeti
 *     tags: [Customers]
 *     parameters:
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
 *         description: Musteri dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Customer'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const { q = '', limit = 100, offset = 0 } = req.query;
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const result = await db.query(
      `select
        c.id,
        c.name,
        c.email,
        c.phone,
        c.address,
        c.created_at,
        count(o.id)::int as orders,
        coalesce(sum(o.total), 0)::numeric(12,2) as total
       from customers c
       left join orders o on o.customer_id = c.id and o.organization_id = c.organization_id and o.status <> 'cancelled'
       where c.organization_id = $1 and (c.name ilike $2 or c.email ilike $2 or c.phone ilike $2)
       group by c.id
       order by c.created_at desc
       limit $3 offset $4`,
      [organization.id, `%${String(q).slice(0, 120)}%`, safeLimit, safeOffset]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/account', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const email = String(req.query.email || '').trim().toLowerCase().slice(0, 254);
    const orderCode = String(req.query.orderCode || req.query.order_code || '').trim().slice(0, 40);
    const bearer = String(req.get('authorization') || '');
    const customerToken = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
    let verifiedCustomerId = null;

    if (customerToken) {
      const crypto = require('crypto');
      const tokenHash = crypto.createHash('sha256').update(customerToken).digest('hex');
      const accountResult = await db.query(
        `select customer_id
         from customer_accounts
         where organization_id = $1
           and session_token_hash = $2
           and session_expires_at > now()
         limit 1`,
        [organization.id, tokenHash]
      );
      verifiedCustomerId = accountResult.rows[0]?.customer_id || null;
    }

    if (!verifiedCustomerId) {
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email zorunlu' });
      if (!orderCode) return res.status(400).json({ error: 'Siparis kodu zorunlu' });

      const verified = await db.query(
        `select c.id
         from customers c
         join orders o on o.customer_id = c.id and o.organization_id = c.organization_id
         where c.organization_id = $1
           and lower(c.email) = $2
           and o.order_code = $3
         limit 1`,
        [organization.id, email, orderCode]
      );

      if (!verified.rows[0]) {
        return res.status(404).json({ error: 'Hesap bilgisi bulunamadi' });
      }
      verifiedCustomerId = verified.rows[0].id;
    }

    const customerResult = await db.query(
      `select id, name, email, phone, address, created_at, updated_at
       from customers
       where id = $1 and organization_id = $2
       limit 1`,
      [verifiedCustomerId, organization.id]
    );

    const ordersResult = await db.query(
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
       left join order_items oi on oi.order_id = o.id
       where o.organization_id = $1
         and o.customer_id = $2
       group by o.id
       order by o.created_at desc
       limit 50`,
      [organization.id, verifiedCustomerId]
    );

    res.json({
      customer: customerResult.rows[0],
      orders: ordersResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
