const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { requestedOrganizationSlug, resolveOrganization, slugify } = require('../services/tenant');

const router = express.Router();

router.get('/current', async (req, res, next) => {
  try {
    const slug = requestedOrganizationSlug(req);
    const result = await db.query(
      `select id, name, slug, plan, status, created_at
       from organizations
       where slug = $1
       limit 1`,
      [slug]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Organizasyon bulunamadi' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/organizations/current/summary:
 *   get:
 *     summary: Aktif workspace dashboard ozetini dondurur
 *     tags: [Organizations]
 *     responses:
 *       200:
 *         description: Dashboard, analytics ve settings icin workspace ozeti
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OrganizationSummary'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/current/summary', requireAuth, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const organizationId = organization.id;

    const [
      productMetricsResult,
      categoryMetricsResult,
      customerMetricsResult,
      orderMetricsResult,
      memberMetricsResult,
      recentOrdersResult,
      lowStockResult,
      recentActivityResult,
      statusBreakdownResult,
      topCustomersResult,
      subscriptionResult,
    ] = await Promise.all([
      db.query(
        `select
          count(*)::int as product_count,
          (count(*) filter (where status = 'active'))::int as active_products,
          (count(*) filter (where status = 'draft'))::int as draft_products,
          (count(*) filter (where stock = 0))::int as out_of_stock_products,
          (count(*) filter (where stock between 1 and 5))::int as low_stock_products
         from products
         where organization_id = $1`,
        [organizationId]
      ),
      db.query(
        `select count(*)::int as category_count
         from categories
         where organization_id = $1`,
        [organizationId]
      ),
      db.query(
        `select
          count(*)::int as customer_count,
          (count(*) filter (where created_at >= date_trunc('month', now())))::int as new_customers_this_month,
          (count(*) filter (where order_count > 1))::int as repeat_customers
         from (
          select c.id, c.created_at, count(o.id)::int as order_count
          from customers c
          left join orders o
            on o.customer_id = c.id
           and o.organization_id = c.organization_id
           and o.status <> 'cancelled'
          where c.organization_id = $1
          group by c.id, c.created_at
         ) customer_orders`,
        [organizationId]
      ),
      db.query(
        `select
          count(*)::int as order_count,
          (count(*) filter (where created_at >= date_trunc('day', now())))::int as today_orders,
          (count(*) filter (where status = 'payment_pending'))::int as pending_orders,
          (count(*) filter (where status = 'shipped'))::int as shipped_orders,
          (count(*) filter (where status = 'delivered'))::int as delivered_orders,
          (count(*) filter (where status = 'cancelled'))::int as cancelled_orders,
          coalesce(sum(total) filter (where status in ('paid', 'processing', 'shipped', 'delivered')), 0)::numeric(12,2) as gross_revenue,
          coalesce(sum(total) filter (
            where created_at >= date_trunc('month', now())
              and status in ('paid', 'processing', 'shipped', 'delivered')
          ), 0)::numeric(12,2) as month_revenue
         from orders
         where organization_id = $1`,
        [organizationId]
      ),
      db.query(
        `select count(*)::int as active_members
         from memberships
         where organization_id = $1 and status = 'active'`,
        [organizationId]
      ),
      db.query(
        `select
          o.id,
          o.order_code,
          o.total,
          o.status,
          o.created_at,
          c.name as customer_name
         from orders o
         left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
         where o.organization_id = $1
         order by o.created_at desc
         limit 6`,
        [organizationId]
      ),
      db.query(
        `select
          p.id,
          p.name,
          p.stock,
          p.status,
          c.name as category_name
         from products p
         left join categories c on c.id = p.category_id and c.organization_id = p.organization_id
         where p.organization_id = $1 and p.stock <= 5
         order by p.stock asc, p.updated_at desc
         limit 6`,
        [organizationId]
      ),
      db.query(
        `select
          al.id,
          al.action,
          al.entity_type,
          al.entity_id,
          al.metadata,
          al.created_at,
          coalesce(nullif(u.name, ''), u.email, 'Workspace') as actor_name
         from activity_logs al
         left join app_users u on u.id = al.actor_user_id
         where al.organization_id = $1
         order by al.created_at desc
         limit 8`,
        [organizationId]
      ),
      db.query(
        `select status, count(*)::int as count
         from orders
         where organization_id = $1
         group by status
         order by count desc, status asc`,
        [organizationId]
      ),
      db.query(
        `select
          c.id,
          c.name,
          c.email,
          count(o.id)::int as orders,
          coalesce(sum(o.total), 0)::numeric(12,2) as total
         from customers c
         left join orders o
           on o.customer_id = c.id
          and o.organization_id = c.organization_id
          and o.status <> 'cancelled'
         where c.organization_id = $1
         group by c.id
         order by total desc, orders desc, c.created_at desc
         limit 6`,
        [organizationId]
      ),
      db.query(
        `select provider, plan, status, current_period_start, current_period_end, cancel_at_period_end, updated_at
         from subscriptions
         where organization_id = $1
         order by updated_at desc nulls last, created_at desc
         limit 1`,
        [organizationId]
      ),
    ]);

    res.json({
      organization,
      metrics: {
        ...productMetricsResult.rows[0],
        ...categoryMetricsResult.rows[0],
        ...customerMetricsResult.rows[0],
        ...orderMetricsResult.rows[0],
        ...memberMetricsResult.rows[0],
      },
      recentOrders: recentOrdersResult.rows,
      lowStockProducts: lowStockResult.rows,
      recentActivity: recentActivityResult.rows,
      orderStatusBreakdown: statusBreakdownResult.rows,
      topCustomers: topCustomersResult.rows,
      subscription: subscriptionResult.rows[0] || null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requireRole(['super_admin']), async (req, res, next) => {
  try {
    const result = await db.query(
      `select id, name, slug, plan, status, created_at, updated_at
       from organizations
       order by created_at desc`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireRole(['super_admin']), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 160);
    const slug = slugify(req.body.slug || name);
    const plan = ['starter', 'growth', 'business', 'enterprise'].includes(req.body.plan)
      ? req.body.plan
      : 'starter';

    if (!name || !slug) return res.status(400).json({ error: 'Organizasyon adi zorunlu' });

    const result = await db.query(
      `insert into organizations (name, slug, plan, status)
       values ($1, $2, $3, 'active')
       returning id, name, slug, plan, status, created_at`,
      [name, slug, plan]
    );

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'organization',
      resourceId: result.rows[0].id,
      newValue: result.rows[0],
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
