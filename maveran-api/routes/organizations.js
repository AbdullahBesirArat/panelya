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

router.get('/current/summary', requireAuth, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const organizationId = organization.id;

    const [
      metricsResult,
      recentOrdersResult,
      lowStockResult,
      recentActivityResult,
      statusBreakdownResult,
      topCustomersResult,
      subscriptionResult,
    ] = await Promise.all([
      db.query(
        `select
          (select count(*)::int from products where organization_id = $1) as product_count,
          (select count(*)::int from products where organization_id = $1 and status = 'active') as active_products,
          (select count(*)::int from products where organization_id = $1 and status = 'draft') as draft_products,
          (select count(*)::int from products where organization_id = $1 and stock = 0) as out_of_stock_products,
          (select count(*)::int from products where organization_id = $1 and stock between 1 and 5) as low_stock_products,
          (select count(*)::int from categories where organization_id = $1) as category_count,
          (select count(*)::int from customers where organization_id = $1) as customer_count,
          (
            select count(*)::int
            from (
              select c.id
              from customers c
              left join orders o
                on o.customer_id = c.id
               and o.organization_id = c.organization_id
               and o.status <> 'cancelled'
              where c.organization_id = $1
              group by c.id
              having count(o.id) > 1
            ) repeaters
          ) as repeat_customers,
          (select count(*)::int from customers where organization_id = $1 and created_at >= date_trunc('month', now())) as new_customers_this_month,
          (select count(*)::int from orders where organization_id = $1) as order_count,
          (select count(*)::int from orders where organization_id = $1 and created_at >= date_trunc('day', now())) as today_orders,
          (select count(*)::int from orders where organization_id = $1 and status = 'payment_pending') as pending_orders,
          (select count(*)::int from orders where organization_id = $1 and status = 'shipped') as shipped_orders,
          (select count(*)::int from orders where organization_id = $1 and status = 'delivered') as delivered_orders,
          (select count(*)::int from orders where organization_id = $1 and status = 'cancelled') as cancelled_orders,
          (
            select coalesce(sum(total), 0)::numeric(12,2)
            from orders
            where organization_id = $1
              and status in ('paid', 'processing', 'shipped', 'delivered')
          ) as gross_revenue,
          (
            select coalesce(sum(total), 0)::numeric(12,2)
            from orders
            where organization_id = $1
              and created_at >= date_trunc('month', now())
              and status in ('paid', 'processing', 'shipped', 'delivered')
          ) as month_revenue,
          (select count(*)::int from memberships where organization_id = $1 and status = 'active') as active_members`,
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
      metrics: metricsResult.rows[0],
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
