const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const customerAuth = require('./customerAuth');

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

async function customerAccountView(client, { organization, account }) {
  const customerId = account?.customer_id || null;
  let customer = null;
  if (customerId) {
    const customerResult = await client.query(
      `select id, name, email, phone, address, created_at, updated_at
       from customers
       where id = $1 and organization_id = $2
       limit 1`,
      [customerId, organization.id]
    );
    customer = customerResult.rows[0] || null;
  }

  const orders = await customerAuth.accountOrders(client, organization.id, customerId);
  return {
    customer,
    account: customerAuth.publicAccount(account),
    orders,
  };
}

router.get('/account', async (req, res, next) => {
  try {
    const session = await customerAuth.requireCustomerAccount(req, db);
    const view = await customerAccountView(db, session);
    res.json(view);
  } catch (err) {
    next(err);
  }
});

router.customerAccountView = customerAccountView;

module.exports = router;
