const db = require('../db');
const { resolveEffectiveLimits } = require('./planVersions');

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
  collections: {
    column: 'max_collections',
    usageQuery: `select count(*)::int as count from collections where organization_id = $1`,
    upgradeMessage: 'Koleksiyon limitine ulastiniz. Daha fazla koleksiyon icin planinizi yukseltebilirsiniz.',
  },
  blog_posts: {
    column: 'max_blog_posts',
    usageQuery: `select count(*)::int as count from blog_posts where organization_id = $1`,
    upgradeMessage: 'Blog yazisi limitine ulastiniz. Daha fazla icerik icin planinizi yukseltebilirsiniz.',
  },
  // A27: a domain is a real, countable resource now. A released/disabled row does not
  // count against the ceiling — only claims that actually occupy the hostname do.
  domains: {
    column: 'max_domains',
    // Counts every state that still holds the hostname claim (migration 062). A released
    // row is history and frees both the hostname and the plan slot; a disabled one does
    // not, because it is still reserving the name globally.
    usageQuery: `select count(*)::int as count from custom_domains
                 where organization_id = $1 and status <> 'released'`,
    upgradeMessage: 'Alan adi limitine ulastiniz. Daha fazla alan adi icin planinizi yukseltebilirsiniz.',
  },
  // A29: API keys and webhook endpoints are countable resources. A revoked key and an
  // archived endpoint are history and free their slot; anything still usable does not.
  api_keys: {
    column: 'max_api_keys',
    usageQuery: `select count(*)::int as count from api_keys
                 where organization_id = $1 and status = 'active'`,
    upgradeMessage: 'API anahtari limitine ulastiniz. Daha fazlasi icin planinizi yukseltebilirsiniz.',
  },
  webhooks: {
    column: 'max_webhooks',
    usageQuery: `select count(*)::int as count from webhook_endpoints
                 where organization_id = $1 and status <> 'archived'`,
    upgradeMessage: 'Webhook limitine ulastiniz. Daha fazlasi icin planinizi yukseltebilirsiniz.',
  },
};

// A26: limits now come from the plan VERSION a subscription is pinned to, with live
// super-admin overrides on top and plan_limits as the fallback. The returned shape is
// unchanged (plan + max_* columns), so assertPlanCapacity / assertStorageCapacity /
// requirePlanCapacity keep their existing public contract, and migration 058's v1
// backfill makes the resolved numbers identical to the pre-A26 join for every tenant
// that already existed.
async function fetchPlanLimitSnapshot(client, organizationId) {
  return resolveEffectiveLimits(client, organizationId);
}

/**
 * A29 monthly external API calls. Read from the counter rather than from a request log:
 * the quota only needs a total, and a row per call would be the most expensive table on
 * the platform for a number nobody reads per-row.
 */
async function fetchApiCallsThisMonth(client, organizationId) {
  const result = await client.query(
    `select coalesce(call_count, 0)::bigint as count from api_usage_counters
      where organization_id = $1 and period_start = date_trunc('month', now() at time zone 'utc')`,
    [organizationId]
  );
  return Number(result.rows[0]?.count || 0);
}

async function fetchStorageUsageBytes(client, organizationId) {
  const result = await client.query(
    `select coalesce(sum(byte_size), 0)::bigint as bytes
     from upload_assets
     where organization_id = $1 and status <> 'deleted'`,
    [organizationId]
  );
  return Number(result.rows[0]?.bytes || 0);
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

  const [
    productCount, monthlyOrderCount, activeMemberCount, collectionCount, blogPostCount,
    domainCount, apiKeyCount, webhookCount, apiCallsMonth, storageBytes,
  ] = await Promise.all([
    fetchResourceUsage(client, organizationId, 'products'),
    fetchResourceUsage(client, organizationId, 'orders_month'),
    fetchResourceUsage(client, organizationId, 'members'),
    fetchResourceUsage(client, organizationId, 'collections'),
    fetchResourceUsage(client, organizationId, 'blog_posts'),
    fetchResourceUsage(client, organizationId, 'domains').catch(() => 0),
    fetchResourceUsage(client, organizationId, 'api_keys').catch(() => 0),
    fetchResourceUsage(client, organizationId, 'webhooks').catch(() => 0),
    fetchApiCallsThisMonth(client, organizationId).catch(() => 0),
    fetchStorageUsageBytes(client, organizationId).catch(() => 0),
  ]);

  return {
    plan: limits.plan,
    // A26: which version these limits came from, so the UI can show a tenant that its
    // terms are pinned and did not move when the plan was re-published.
    planVersion: limits.planVersion || null,
    planVersionId: limits.planVersionId || null,
    limitSource: limits.source || 'plan_limits',
    subscriptionStatus: limits.subscriptionStatus || null,
    overrides: limits.overrides || [],
    limits: {
      maxProducts: Number(limits.max_products || 0),
      maxOrdersMonth: Number(limits.max_orders_month || 0),
      maxMembers: Number(limits.max_members || 0),
      maxStorageMb: Number(limits.max_storage_mb || 0),
      maxCollections: Number(limits.max_collections || 0),
      maxBlogPosts: Number(limits.max_blog_posts || 0),
      maxDomains: Number(limits.max_domains || 0),
      maxApiKeys: Number(limits.max_api_keys || 0),
      maxWebhooks: Number(limits.max_webhooks || 0),
      maxApiCallsMonth: Number(limits.max_api_calls_month || 0),
    },
    usage: {
      products: productCount,
      ordersMonth: monthlyOrderCount,
      members: activeMemberCount,
      collections: collectionCount,
      blogPosts: blogPostCount,
      domains: domainCount,
      apiKeys: apiKeyCount,
      webhooks: webhookCount,
      apiCallsMonth: apiCallsMonth,
      storageBytes,
      storageMb: Math.ceil(storageBytes / (1024 * 1024)),
    },
  };
}

// A26 concurrency: counting and then inserting is a race — two transactions can both read
// "one slot left" and both create. The check-then-create pair therefore has to be
// serialised, but ONLY against other writers of the same resource in the same tenant.
//
// An earlier version locked the organizations row with SELECT ... FOR UPDATE. That was
// measurably wrong: carts, customers, orders, activity_logs and every other tenant table
// carry an organization_id foreign key, and inserting a child row takes FOR KEY SHARE on
// the parent — which conflicts with FOR UPDATE. Holding it for the length of a checkout
// transaction blocked essentially every write in that tenant (observed: nine backends
// waiting on `Lock/transactionid` behind a single holder for 440+ seconds).
//
// A transaction-scoped advisory lock keyed on (organization, resource) gives the same
// mutual exclusion without touching any row, so it cannot collide with foreign keys:
//   * products capacity does not block orders/members/storage capacity,
//   * tenant A never blocks tenant B,
//   * the lock is released automatically on commit OR rollback (no session-level leak).
// The key is derived deterministically from md5 so it is stable across processes and
// versions. A hash collision would only cause two unrelated pairs to serialise against
// each other — slower, never incorrect.
async function lockCapacity(client, organizationId, resource) {
  await client.query(
    `select pg_advisory_xact_lock(
       ('x' || substr(md5($1::text), 1, 8))::bit(32)::int,
       ('x' || substr(md5($2::text), 1, 8))::bit(32)::int
     )`,
    [String(organizationId), `plan_capacity:${resource}`]
  );
}

async function assertPlanCapacity(client, organizationId, resource, increment = 1) {
  const config = RESOURCE_CONFIG[resource];
  if (!config) {
    throw new Error(`Desteklenmeyen plan kaynagi: ${resource}`);
  }

  const limits = await fetchPlanLimitSnapshot(client, organizationId);
  if (!limits || !limits[config.column]) return;

  await lockCapacity(client, organizationId, resource);

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

async function assertStorageCapacity(client, organizationId, incomingBytes) {
  const safeIncomingBytes = Math.max(Number(incomingBytes || 0), 0);
  if (!safeIncomingBytes) return;

  const limits = await fetchPlanLimitSnapshot(client, organizationId);
  if (!limits || !limits.max_storage_mb) return;

  // Same reasoning as assertPlanCapacity: this used the organizations row too, which
  // conflicts with the FOR KEY SHARE that every child insert takes on that row. Storage
  // now serialises only against other storage writers of the same tenant.
  await lockCapacity(client, organizationId, 'storage');
  const currentBytes = await fetchStorageUsageBytes(client, organizationId);
  const limitBytes = Number(limits.max_storage_mb || 0) * 1024 * 1024;
  const nextBytes = currentBytes + safeIncomingBytes;

  if (nextBytes <= limitBytes) return;

  const error = new Error('Depolama limitine ulastiniz. Daha fazla dosya icin planinizi yukseltebilirsiniz.');
  error.status = 402;
  error.code = 'PLAN_LIMIT_REACHED';
  error.meta = {
    plan: limits.plan,
    resource: 'storage',
    limitBytes,
    usageBytes: currentBytes,
    nextBytes,
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
  assertStorageCapacity,
  getPlanUsage,
  requirePlanCapacity,
};
