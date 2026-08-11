const test = require('node:test');
const assert = require('node:assert/strict');

const { assertPlanCapacity, assertStorageCapacity, getPlanUsage } = require('../services/planLimits');
const { resolveEffectiveLimits } = require('../services/planVersions');

// A26 changed WHERE limits come from (the plan version a subscription is pinned to, with
// plan_limits as the fallback), not what enforcement does. These fakes model an
// organization with no subscription row, i.e. exactly the pre-A26 resolution path, so the
// enforcement assertions below are unchanged from before A26.
function fakeClient({ limits, counts = {}, bytes = 0, subscription = null, planVersion = null }) {
  const queries = [];
  return {
    queries,
    async query(text) {
      queries.push(text);
      if (text.includes('from plan_versions')) {
        return { rows: planVersion ? [planVersion] : [] };
      }
      if (text.includes('from subscription_overrides')) {
        return { rows: [] };
      }
      if (text.includes('from organizations o')) {
        return { rows: [{ plan: limits.plan, ...subscription }] };
      }
      if (text.includes('from plan_limits')) {
        return { rows: [limits.columns] };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }] };
      if (text.includes('for update')) return { rows: [{ id: 'org-1' }] };
      if (text.includes('from products')) return { rows: [{ count: counts.products }] };
      if (text.includes('from orders')) return { rows: [{ count: counts.orders }] };
      if (text.includes('from memberships')) return { rows: [{ count: counts.members }] };
      if (text.includes('from collections')) return { rows: [{ count: counts.collections }] };
      if (text.includes('from blog_posts')) return { rows: [{ count: counts.blogPosts }] };
      if (text.includes('from custom_domains')) return { rows: [{ count: counts.domains ?? 0 }] };
      // A29 countable resources and the monthly external API quota.
      if (text.includes('from api_keys')) return { rows: [{ count: counts.apiKeys ?? 0 }] };
      if (text.includes('from webhook_endpoints')) return { rows: [{ count: counts.webhooks ?? 0 }] };
      if (text.includes('from api_usage_counters')) return { rows: [{ count: counts.apiCallsMonth ?? 0 }] };
      if (text.includes('from upload_assets')) return { rows: [{ bytes }] };
      return { rows: [{ count: counts.products, bytes }] };
    },
  };
}

const STARTER = {
  plan: 'starter',
  columns: {
    max_products: 25, max_orders_month: 150, max_members: 3,
    max_storage_mb: 512, max_collections: 8, max_blog_posts: 24, max_domains: 1,
  },
};

test('assertPlanCapacity allows requests when usage stays within the plan', async () => {
  const client = fakeClient({ limits: STARTER, counts: { products: 24 } });
  await assert.doesNotReject(() => assertPlanCapacity(client, 'org-1', 'products'));
});

test('assertPlanCapacity rejects with 402 when the plan limit is exceeded', async () => {
  const client = fakeClient({ limits: STARTER, counts: { products: 25 } });
  await assert.rejects(
    assertPlanCapacity(client, 'org-1', 'products'),
    (error) => error.status === 402 && error.code === 'PLAN_LIMIT_REACHED'
  );
});

// A26: the capacity check must serialise before counting, otherwise two concurrent
// creators both see the last free slot. The invariant is the ordering (lock, then count);
// the primitive is a transaction-scoped advisory lock rather than a row lock, because
// locking the organizations row conflicts with the FOR KEY SHARE that every child insert
// takes on it and serialised the whole tenant. The real race is covered by the
// PostgreSQL integration test.
test('assertPlanCapacity serialises before counting, without locking any row', async () => {
  const client = fakeClient({ limits: STARTER, counts: { products: 24 } });
  await assertPlanCapacity(client, 'org-1', 'products');
  const lockIndex = client.queries.findIndex((text) => text.includes('pg_advisory_xact_lock'));
  const countIndex = client.queries.findIndex((text) => text.includes('from products'));
  assert.ok(lockIndex >= 0, 'a capacity lock is taken');
  assert.ok(lockIndex < countIndex, 'the lock is taken before usage is counted');
  assert.ok(
    !client.queries.some((text) => text.includes('from organizations') && text.includes('for update')),
    'the organizations row is never row-locked: that blocks every FK child insert in the tenant'
  );
});

// The lock must be scoped per (tenant, resource) so unrelated capacity checks do not
// serialise against one another.
test('capacity locks are keyed per tenant and per resource', async () => {
  const seen = [];
  for (const [org, resource] of [['org-1', 'products'], ['org-1', 'members'], ['org-2', 'products']]) {
    const client = fakeClient({ limits: STARTER, counts: { products: 1, members: 1 } });
    await assertPlanCapacity(client, org, resource);
    const lock = client.queries.find((text) => text.includes('pg_advisory_xact_lock'));
    seen.push(lock);
  }
  assert.equal(seen.filter(Boolean).length, 3, 'every capacity check takes its own lock');
  // The key material is passed as parameters, so the SQL text is shared while the lock
  // identity differs; the integration test proves the runtime keys really are distinct.
  assert.ok(seen[0].includes('md5($1::text)') && seen[0].includes('md5($2::text)'),
    'the key is derived from the organization and the resource, not hardcoded');
});

test('getPlanUsage returns normalized limits and usage payload', async () => {
  const growth = {
    plan: 'growth',
    columns: {
      max_products: 250, max_orders_month: 2000, max_members: 15,
      max_storage_mb: 4096, max_collections: 40, max_blog_posts: 120, max_domains: 3,
      max_api_keys: 5, max_webhooks: 5, max_api_calls_month: 100000,
    },
  };
  const client = fakeClient({
    limits: growth,
    counts: {
      products: 14, orders: 32, members: 5, collections: 3, blogPosts: 9, domains: 2,
      apiKeys: 2, webhooks: 1, apiCallsMonth: 4200,
    },
    bytes: 1536,
  });

  const usage = await getPlanUsage(client, 'org-2');

  assert.equal(usage.plan, 'growth');
  assert.deepEqual(usage.limits, {
    maxProducts: 250,
    maxOrdersMonth: 2000,
    maxMembers: 15,
    maxStorageMb: 4096,
    maxCollections: 40,
    maxBlogPosts: 120,
    // A27 added domains as a countable plan resource.
    maxDomains: 3,
    // A29 added API keys, webhooks and a monthly call quota as plan dimensions.
    maxApiKeys: 5,
    maxWebhooks: 5,
    maxApiCallsMonth: 100000,
  });
  assert.deepEqual(usage.usage, {
    products: 14,
    ordersMonth: 32,
    members: 5,
    collections: 3,
    blogPosts: 9,
    domains: 2,
    apiKeys: 2,
    webhooks: 1,
    apiCallsMonth: 4200,
    storageBytes: 1536,
    storageMb: 1,
  });
  // A26 additions are additive; they must never replace the fields above.
  assert.equal(usage.limitSource, 'plan_limits');
  assert.equal(usage.planVersion, null);
  assert.deepEqual(usage.overrides, []);
});

test('assertStorageCapacity rejects when upload would exceed max_storage_mb', async () => {
  const tiny = { plan: 'starter', columns: { ...STARTER.columns, max_storage_mb: 1 } };
  const client = fakeClient({ limits: tiny, bytes: 900 * 1024 });

  await assert.rejects(
    assertStorageCapacity(client, 'org-1', 200 * 1024),
    (error) => error.status === 402 && error.code === 'PLAN_LIMIT_REACHED' && error.meta.resource === 'storage'
  );
});

// A26: a pinned plan version is what gets enforced, and it does not fall back to
// plan_limits. Publishing a looser v2 therefore cannot widen an existing subscription.
test('a pinned plan version supplies the enforced limits instead of plan_limits', async () => {
  const client = fakeClient({
    limits: { plan: 'starter', columns: { ...STARTER.columns, max_products: 9999 } },
    subscription: { subscription_id: 'sub-1', plan_version_id: 7, subscription_status: 'active' },
    planVersion: {
      id: 7,
      version: 1,
      plan_name: 'starter',
      limits: {
        maxProducts: 25, maxOrdersMonth: 150, maxMembers: 3,
        maxStorageMb: 512, maxCollections: 8, maxBlogPosts: 24,
      },
    },
    counts: { products: 25 },
  });

  const resolved = await resolveEffectiveLimits(client, 'org-1');
  assert.equal(resolved.source, 'plan_version');
  assert.equal(resolved.planVersion, 1);
  assert.equal(resolved.max_products, 25, 'the pinned version wins over the looser plan_limits row');

  await assert.rejects(
    assertPlanCapacity(client, 'org-1', 'products'),
    (error) => error.code === 'PLAN_LIMIT_REACHED',
    'enforcement uses the pinned version, so a later plan edit cannot loosen it'
  );
});
