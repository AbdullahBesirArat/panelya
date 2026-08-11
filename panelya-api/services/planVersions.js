'use strict';

// A26 plan version resolution.
//
// The contract this module has to protect: an existing tenant's limits must not change
// because A26 shipped. Migration 058 backfills a v1 plan_versions row whose limits are a
// verbatim copy of that plan's plan_limits row, and this module reads the version the
// subscription is pinned to — so pre-A26 and post-A26 resolution return the same numbers
// for every existing tenant. plan_limits stays as the fallback for an organization with
// no subscription row at all, which is exactly what planLimits.js did before.

const LIMIT_KEYS = Object.freeze({
  maxProducts: 'max_products',
  maxOrdersMonth: 'max_orders_month',
  maxMembers: 'max_members',
  maxStorageMb: 'max_storage_mb',
  maxCollections: 'max_collections',
  maxBlogPosts: 'max_blog_posts',
  // A27: domains became a countable resource with migration 061.
  maxDomains: 'max_domains',
  // A29: the integration platform adds two countable resources and one monthly quota
  // (migration 067), backfilled into every existing version snapshot so no tenant's
  // effective terms moved.
  maxApiKeys: 'max_api_keys',
  maxWebhooks: 'max_webhooks',
  maxApiCallsMonth: 'max_api_calls_month',
});

function planError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Turn a plan_versions.limits jsonb object into the snake_case shape planLimits.js
// already consumes, so its public functions keep working untouched.
function limitsToSnapshotColumns(limits = {}) {
  const columns = {};
  for (const [camel, column] of Object.entries(LIMIT_KEYS)) {
    const value = limits[camel];
    columns[column] = value == null ? null : Number(value);
  }
  return columns;
}

function snapshotColumnsToLimits(row = {}) {
  const limits = {};
  for (const [camel, column] of Object.entries(LIMIT_KEYS)) {
    limits[camel] = Number(row[column] || 0);
  }
  return limits;
}

// The version a NEW subscription should be sold: the single active version for that plan.
async function resolveActiveVersion(client, planName) {
  const result = await client.query(
    "select * from plan_versions where plan_name = $1 and status = 'active' limit 1",
    [planName]
  );
  return result.rows[0] || null;
}

async function loadVersionById(client, planVersionId) {
  if (!planVersionId) return null;
  const result = await client.query('select * from plan_versions where id = $1', [Number(planVersionId)]);
  return result.rows[0] || null;
}

// Live limit overrides for this subscription: not revoked and not yet expired. Expiry is
// evaluated in SQL against now(), so an override stops applying on its own without any
// sweeper having to run.
async function activeLimitOverrides(client, { organizationId, subscriptionId }) {
  if (!subscriptionId) return [];
  const result = await client.query(
    `select target_key, target_value
       from subscription_overrides
      where organization_id = $1 and subscription_id = $2
        and override_type = 'limit'
        and revoked_at is null
        and expires_at > now()`,
    [organizationId, subscriptionId]
  );
  return result.rows;
}

// Resolves the limits actually in force for an organization, in priority order:
//   1. a live limit override (super-admin, reason + expiry enforced by the schema)
//   2. the plan version the subscription is pinned to
//   3. plan_limits for organizations.plan  (pre-A26 behaviour, kept as the fallback)
// Returns { plan, planVersionId, planVersion, source, ...snake_case limit columns } so it
// is a drop-in replacement for the old fetchPlanLimitSnapshot result.
async function resolveEffectiveLimits(client, organizationId) {
  const orgResult = await client.query(
    `select o.plan,
            s.id as subscription_id,
            s.plan as subscription_plan,
            s.plan_version_id,
            s.status as subscription_status
       from organizations o
       left join lateral (
         select id, plan, plan_version_id, status
           from subscriptions
          where organization_id = o.id
          order by updated_at desc nulls last, created_at desc
          limit 1
       ) s on true
      where o.id = $1
      limit 1`,
    [organizationId]
  );
  const row = orgResult.rows[0];
  if (!row) return null;

  const version = await loadVersionById(client, row.plan_version_id);
  let columns;
  let source;
  if (version) {
    columns = limitsToSnapshotColumns(version.limits || {});
    source = 'plan_version';
  } else {
    const fallback = await client.query(
      `select max_products, max_orders_month, max_members, max_storage_mb,
              max_collections, max_blog_posts, max_domains
         from plan_limits where plan_name = $1 limit 1`,
      [row.plan]
    );
    if (!fallback.rows[0]) return null;
    columns = { ...fallback.rows[0] };
    source = 'plan_limits';
  }

  const overrides = await activeLimitOverrides(client, {
    organizationId, subscriptionId: row.subscription_id,
  });
  const appliedOverrides = [];
  for (const override of overrides) {
    const column = LIMIT_KEYS[override.target_key] || null;
    if (!column) continue;
    const raw = override.target_value && override.target_value.limit;
    const value = raw == null ? null : Number(raw);
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    columns[column] = value;
    appliedOverrides.push({ resource: override.target_key, limit: value });
  }

  return {
    plan: row.plan,
    subscriptionId: row.subscription_id || null,
    subscriptionStatus: row.subscription_status || null,
    planVersionId: version ? Number(version.id) : null,
    planVersion: version ? Number(version.version) : null,
    source,
    overrides: appliedOverrides,
    ...columns,
  };
}

// Publishing a new version. A published version is immutable: this refuses to touch a
// row that is not a draft, so historical terms can never be edited after the fact.
async function publishVersion(client, { planName, version, actorId = null }) {
  const locked = await client.query(
    'select * from plan_versions where plan_name = $1 and version = $2 for update',
    [planName, Number(version)]
  );
  const draft = locked.rows[0];
  if (!draft) throw planError('Plan versiyonu bulunamadi', 'PLAN_VERSION_NOT_FOUND', 404);
  if (draft.status !== 'draft') {
    throw planError(
      'Yayinlanmis plan versiyonu degistirilemez',
      'PLAN_VERSION_NOT_DRAFT', 409
    );
  }
  // Retire the outgoing active version first; the partial unique index would otherwise
  // reject the second active row, which is exactly the guarantee we want.
  await client.query(
    "update plan_versions set status = 'retired', updated_at = now() where plan_name = $1 and status = 'active'",
    [planName]
  );
  const published = await client.query(
    `update plan_versions
        set status = 'active', effective_from = coalesce(effective_from, now()),
            published_at = now(), published_by = $3, updated_at = now()
      where plan_name = $1 and version = $2 returning *`,
    [planName, Number(version), actorId]
  );
  return published.rows[0];
}

async function createDraftVersion(client, { planName, limits, notes = '' }) {
  const next = await client.query(
    'select coalesce(max(version), 0) + 1 as version from plan_versions where plan_name = $1',
    [planName]
  );
  const version = Number(next.rows[0].version);
  const normalized = {};
  for (const camel of Object.keys(LIMIT_KEYS)) {
    const value = Number(limits && limits[camel]);
    if (!Number.isFinite(value) || value < 0) {
      throw planError(`Plan limiti gecersiz: ${camel}`, 'PLAN_LIMIT_INVALID', 400);
    }
    normalized[camel] = value;
  }
  const created = await client.query(
    `insert into plan_versions (plan_name, version, status, limits, notes)
     values ($1, $2, 'draft', $3::jsonb, $4) returning *`,
    [planName, version, JSON.stringify(normalized), String(notes || '').slice(0, 1000)]
  );
  return created.rows[0];
}

module.exports = {
  LIMIT_KEYS,
  limitsToSnapshotColumns,
  snapshotColumnsToLimits,
  resolveActiveVersion,
  loadVersionById,
  activeLimitOverrides,
  resolveEffectiveLimits,
  publishVersion,
  createDraftVersion,
  planError,
};
