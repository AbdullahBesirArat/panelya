const db = require('../db');

const RESOURCE_CONFIG = {
  products: {
    column: 'max_products',
    usageQuery: `select count(*)::int as count from products where organization_id = $1`,
    upgradeMessage: 'Urun limitine ulastiniz. Daha fazla urun icin planinizi yukseltebilirsiniz.',
  },
  orders_month: {
    column: 'max_orders_month',
    usageQuery: `select count(*)::int as count
                 from orders
                 where organization_id = $1
                   and created_at >= date_trunc('month', now())`,
    upgradeMessage: 'Aylik siparis limitine ulastiniz. Daha fazla siparis icin planinizi yukseltebilirsiniz.',
  },
  members: {
    column: 'max_members',
    usageQuery: `select count(*)::int as count
                 from memberships
                 where organization_id = $1
                   and status = 'active'`,
    upgradeMessage: 'Ekip limitine ulastiniz. Daha fazla uye icin planinizi yukseltebilirsiniz.',
  },
};

async function fetchPlanLimitSnapshot(client, organizationId) {
  const result = await client.query(
    `select
       o.plan,
       pl.max_products,
       pl.max_orders_month,
       pl.max_members,
       pl.max_storage_mb
     from organizations o
     left join plan_limits pl on pl.plan_name = o.plan
     where o.id = $1
     limit 1`,
    [organizationId]
  );

  return result.rows[0] || null;
}

async function fetchResourceUsage(client, organizationId, resource) {
  const config = RESOURCE_CONFIG[resource];
  if (!config) {
    throw new Error(`Desteklenmeyen plan kaynagi: ${resource}`);
  }

  const result = await client.query(config.usageQuery, [organizationId]);
  return Number(result.rows[0]?.count || 0);
}

async function getPlanUsage(client, organizationId) {
  const limits = await fetchPlanLimitSnapshot(client, organizationId);
  if (!limits) return null;

  const [productCount, monthlyOrderCount, activeMemberCount] = await Promise.all([
    fetchResourceUsage(client, organizationId, 'products'),
    fetchResourceUsage(client, organizationId, 'orders_month'),
    fetchResourceUsage(client, organizationId, 'members'),
  ]);

  return {
    plan: limits.plan,
    limits: {
      maxProducts: Number(limits.max_products || 0),
      maxOrdersMonth: Number(limits.max_orders_month || 0),
      maxMembers: Number(limits.max_members || 0),
      maxStorageMb: Number(limits.max_storage_mb || 0),
    },
    usage: {
      products: productCount,
      ordersMonth: monthlyOrderCount,
      members: activeMemberCount,
    },
  };
}

async function assertPlanCapacity(client, organizationId, resource, increment = 1) {
  const config = RESOURCE_CONFIG[resource];
  if (!config) {
    throw new Error(`Desteklenmeyen plan kaynagi: ${resource}`);
  }

  const limits = await fetchPlanLimitSnapshot(client, organizationId);
  if (!limits || !limits[config.column]) return;

  const currentUsage = await fetchResourceUsage(client, organizationId, resource);
  const limit = Number(limits[config.column] || 0);
  const nextUsage = currentUsage + increment;

  if (nextUsage <= limit) return;

  const error = new Error(config.upgradeMessage);
  error.status = 402;
  error.code = 'PLAN_LIMIT_REACHED';
  error.meta = {
    plan: limits.plan,
    resource,
    limit,
    usage: currentUsage,
    nextUsage,
  };
  throw error;
}

function requirePlanCapacity(resource, options = {}) {
  const increment = Number(options.increment || 1);

  return async (req, res, next) => {
    try {
      const organizationId = options.resolveOrganizationId
        ? await options.resolveOrganizationId(req)
        : req.organization?.id || req.auth?.organizationId;

      if (!organizationId) {
        throw Object.assign(new Error('Plan limiti icin organization gerekli'), { status: 500 });
      }

      await assertPlanCapacity(db, organizationId, resource, increment);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  assertPlanCapacity,
  getPlanUsage,
  requirePlanCapacity,
};
