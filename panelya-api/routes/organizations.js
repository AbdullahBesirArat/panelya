const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { sendInviteEmail } = require('../services/email');
const { assertPlanCapacity } = require('../services/planLimits');
const { getOrganizationSummary, invalidateOrganizationSummary, setOrganizationSummary } = require('../services/summaryCache');
const { requestedOrganizationSlug, resolveOrganization, slugify } = require('../services/tenant');

const router = express.Router();
const INVITE_ROLES = ['admin', 'member', 'viewer'];
const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'];

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicInvite(invite) {
  if (!invite) return null;
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expires_at: invite.expires_at,
    accepted_at: invite.accepted_at,
    created_at: invite.created_at,
    invited_by_name: invite.invited_by_name || null,
    invited_by_email: invite.invited_by_email || null,
  };
}

function cleanStoreSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  const paymentProvider = ['manual', 'iyzico'].includes(settings.paymentProvider)
    ? settings.paymentProvider
    : 'manual';
  const shippingFee = Number(settings.shippingFee);
  const freeShippingThreshold = Number(settings.freeShippingThreshold);

  return {
    contactEmail: cleanEmail(settings.contactEmail || ''),
    supportPhone: String(settings.supportPhone || '').trim().slice(0, 40),
    shippingFee: Number.isFinite(shippingFee) && shippingFee >= 0 ? shippingFee : 0,
    freeShippingThreshold: Number.isFinite(freeShippingThreshold) && freeShippingThreshold >= 0
      ? freeShippingThreshold
      : 0,
    paymentProvider,
    paymentEnabled: settings.paymentEnabled !== false,
    orderEmailEnabled: settings.orderEmailEnabled !== false,
  };
}

router.get('/current', async (req, res, next) => {
  try {
    const slug = requestedOrganizationSlug(req);
    const result = await db.query(
      `select id, name, slug, plan, status, created_at, store_settings
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
    const cachedSummary = getOrganizationSummary(organizationId);

    if (cachedSummary) {
      return res.json(cachedSummary);
    }

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

    const summary = {
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
    };

    setOrganizationSummary(organizationId, summary);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.put('/current', requireAuth, requireRole(['owner', 'admin', 'super_admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const name = String(req.body.name || '').trim().slice(0, 160);
    const slug = slugify(req.body.slug || organization.slug);
    const storeSettings = cleanStoreSettings({
      ...(organization.store_settings || {}),
      ...(req.body.settings && typeof req.body.settings === 'object' ? req.body.settings : {}),
    });

    if (!name || !slug) return res.status(400).json({ error: 'Magaza adi ve slug zorunlu' });

    const oldResult = await db.query(
      'select id, name, slug, plan, status, store_settings from organizations where id = $1 limit 1',
      [organization.id]
    );

    const result = await db.query(
      `update organizations
       set name = $1,
           slug = $2,
           store_settings = $3::jsonb,
           updated_at = now()
       where id = $4
       returning id, name, slug, plan, status, created_at, updated_at, public_access_token, store_settings`,
      [name, slug, JSON.stringify(storeSettings), organization.id]
    );

    invalidateOrganizationSummary(organization.id);
    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'organization',
      resourceId: organization.id,
      oldValue: oldResult.rows[0] || null,
      newValue: result.rows[0],
    });

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/current/public-access-token/regenerate', requireAuth, requireRole(['owner', 'admin', 'super_admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const token = crypto.randomBytes(24).toString('hex');
    const result = await db.query(
      `update organizations
       set public_access_token = $1,
           updated_at = now()
       where id = $2
       returning id, name, slug, plan, status, created_at, updated_at, public_access_token, store_settings`,
      [token, organization.id]
    );

    invalidateOrganizationSummary(organization.id);
    await auditLog(req, {
      action: 'ROTATE_PUBLIC_ACCESS_TOKEN',
      resourceType: 'organization',
      resourceId: organization.id,
      newValue: { slug: result.rows[0].slug },
    });

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/current/members', requireAuth, requireRole(['owner', 'admin', 'member', 'viewer', 'super_admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select
         m.id,
         m.role,
         m.status,
         m.created_at,
         m.updated_at,
         u.id as user_id,
         u.email,
         u.name,
         u.last_login_at
       from memberships m
       join app_users u on u.id = m.user_id
       where m.organization_id = $1
         and m.status = 'active'
       order by
         case m.role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end,
         u.name asc,
         u.email asc`,
      [organization.id]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/current/invites', requireAuth, requireRole(['owner', 'admin', 'super_admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select
         i.id,
         i.email,
         i.role,
         i.expires_at,
         i.accepted_at,
         i.created_at,
         u.name as invited_by_name,
         u.email as invited_by_email
       from organization_invites i
       left join app_users u on u.id = i.invited_by
       where i.organization_id = $1
       order by i.created_at desc
       limit 100`,
      [organization.id]
    );

    res.json(result.rows.map(publicInvite));
  } catch (err) {
    next(err);
  }
});

router.post('/current/invites', requireAuth, requireRole(['owner', 'admin', 'super_admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const email = cleanEmail(req.body.email);
    const role = INVITE_ROLES.includes(req.body.role) ? req.body.role : 'member';
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Gecerli email zorunlu' });

    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    await assertPlanCapacity(client, organization.id, 'members');

    const existingMember = await client.query(
      `select m.id
       from memberships m
       join app_users u on u.id = m.user_id
       where m.organization_id = $1
         and m.status = 'active'
         and lower(u.email) = lower($2)
       limit 1`,
      [organization.id, email]
    );
    if (existingMember.rows[0]) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Bu kullanici zaten ekipte' });
    }

    await client.query(
      `update organization_invites
       set accepted_at = now(),
           updated_at = now()
       where organization_id = $1
         and lower(email) = lower($2)
         and accepted_at is null`,
      [organization.id, email]
    );

    const token = crypto.randomBytes(32).toString('hex');
    const result = await client.query(
      `insert into organization_invites
       (organization_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '7 days')
       returning id, email, role, expires_at, accepted_at, created_at`,
      [organization.id, email, role, hashInviteToken(token), req.auth.actorType === 'app' ? req.auth.userId : null]
    );

    await auditLog(req, {
      action: 'INVITE_MEMBER',
      resourceType: 'organization_invite',
      resourceId: result.rows[0].id,
      newValue: { email, role },
    });
    await client.query('commit');

    await sendInviteEmail(result.rows[0], organization, token).catch((error) => {
      console.warn('Invite email gonderilemedi', { email, message: error.message });
    });

    res.status(201).json({
      ...publicInvite(result.rows[0]),
      inviteToken: token,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/invites/accept', async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const token = String(req.body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Davet token zorunlu' });

    await client.query('begin');
    const inviteResult = await client.query(
      `select i.*, o.name as organization_name, o.slug as organization_slug
       from organization_invites i
       join organizations o on o.id = i.organization_id
       where i.token_hash = $1
         and i.accepted_at is null
         and i.expires_at > now()
       limit 1
       for update`,
      [hashInviteToken(token)]
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Davet bulunamadi veya suresi doldu' });
    }

    const userResult = await client.query(
      'select id, email, name from app_users where lower(email) = lower($1) limit 1',
      [invite.email]
    );
    let user = userResult.rows[0];

    if (!user) {
      const password = String(req.body.password || '');
      const name = String(req.body.name || invite.email.split('@')[0] || 'Team Member').trim().slice(0, 120);
      if (password.length < 8) {
        await client.query('rollback');
        return res.status(400).json({ error: 'Yeni kullanici icin en az 8 karakterli sifre zorunlu' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const createdUser = await client.query(
        `insert into app_users (email, name, password_hash)
         values ($1, $2, $3)
         returning id, email, name`,
        [invite.email, name, passwordHash]
      );
      user = createdUser.rows[0];
    }

    await assertPlanCapacity(client, invite.organization_id, 'members');
    const membershipResult = await client.query(
      `insert into memberships (organization_id, user_id, role, status)
       values ($1, $2, $3, 'active')
       on conflict (organization_id, user_id) do update set
         role = excluded.role,
         status = 'active',
         updated_at = now()
       returning id, organization_id, user_id, role, status, created_at, updated_at`,
      [invite.organization_id, user.id, invite.role]
    );

    await client.query(
      `update organization_invites
       set accepted_at = now(),
           updated_at = now()
      where id = $1`,
      [invite.id]
    );

    invalidateOrganizationSummary(invite.organization_id);
    await auditLog(req, {
      action: 'ACCEPT_INVITE',
      resourceType: 'membership',
      resourceId: membershipResult.rows[0].id,
      newValue: { email: user.email, role: invite.role, organizationSlug: invite.organization_slug },
      actorType: 'app',
      actorUserId: user.id,
      organizationId: invite.organization_id,
    });
    await client.query('commit');

    res.json({
      membership: membershipResult.rows[0],
      organization: {
        id: invite.organization_id,
        name: invite.organization_name,
        slug: invite.organization_slug,
      },
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/current/members/:membershipId', requireAuth, requireRole(['owner', 'admin', 'super_admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const role = MEMBER_ROLES.includes(req.body.role) ? req.body.role : '';
    if (!role || role === 'owner') return res.status(400).json({ error: 'Gecerli rol secin' });

    const oldResult = await db.query(
      'select id, role, user_id from memberships where id = $1 and organization_id = $2 and status = $3 limit 1',
      [req.params.membershipId, organization.id, 'active']
    );
    if (!oldResult.rows[0]) return res.status(404).json({ error: 'Uyelik bulunamadi' });
    if (oldResult.rows[0].role === 'owner') return res.status(400).json({ error: 'Owner rolu bu endpoint ile degistirilemez' });

    const result = await db.query(
      `update memberships
       set role = $1,
           updated_at = now()
       where id = $2 and organization_id = $3
       returning id, organization_id, user_id, role, status, created_at, updated_at`,
      [role, req.params.membershipId, organization.id]
    );

    invalidateOrganizationSummary(organization.id);
    await auditLog(req, {
      action: 'UPDATE_MEMBER_ROLE',
      resourceType: 'membership',
      resourceId: req.params.membershipId,
      oldValue: oldResult.rows[0],
      newValue: result.rows[0],
    });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/current/members/:membershipId', requireAuth, requireRole(['owner', 'admin', 'super_admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const oldResult = await db.query(
      'select id, role, user_id from memberships where id = $1 and organization_id = $2 and status = $3 limit 1',
      [req.params.membershipId, organization.id, 'active']
    );
    if (!oldResult.rows[0]) return res.status(404).json({ error: 'Uyelik bulunamadi' });
    if (oldResult.rows[0].role === 'owner') return res.status(400).json({ error: 'Owner uyeligi kaldirilamaz' });
    if (req.auth.actorType === 'app' && oldResult.rows[0].user_id === req.auth.userId) {
      return res.status(400).json({ error: 'Kendi uyeliginizi kaldiramazsiniz' });
    }

    const result = await db.query(
      `update memberships
       set status = 'disabled',
           updated_at = now()
       where id = $1 and organization_id = $2
       returning id, organization_id, user_id, role, status, created_at, updated_at`,
      [req.params.membershipId, organization.id]
    );

    invalidateOrganizationSummary(organization.id);
    await auditLog(req, {
      action: 'REMOVE_MEMBER',
      resourceType: 'membership',
      resourceId: req.params.membershipId,
      oldValue: oldResult.rows[0],
      newValue: result.rows[0],
    });
    res.status(204).end();
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
