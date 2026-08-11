'use strict';

// A26 subscription business operations. Sits between the routes and the two primitives:
// subscriptionLifecycle (the only writer of status) and planVersions (limit resolution).
// Nothing here writes `subscriptions.status` directly.

const lifecycle = require('./subscriptionLifecycle');
const planVersions = require('./planVersions');
const { getPlanUsage } = require('./planLimits');
const { getProvider, providerCapabilities, normalizeProviderEvent } = require('./subscriptionProviders');

function serviceError(message, code, status = 400, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

const DEFAULT_TRIAL_DAYS = Math.min(Math.max(Number(process.env.SUBSCRIPTION_TRIAL_DAYS || 14), 1), 90);
const DEFAULT_GRACE_DAYS = Math.min(Math.max(Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7), 1), 60);

async function loadSubscription(client, organizationId, { lock = false } = {}) {
  const result = await client.query(
    `select * from subscriptions where organization_id = $1
      order by updated_at desc nulls last, created_at desc limit 1${lock ? ' for update' : ''}`,
    [organizationId]
  );
  return result.rows[0] || null;
}

// --- trial ---------------------------------------------------------------------------

// A tenant gets one trial. The partial unique index on organization_trials makes a second
// RUNNING trial impossible; this adds the history check so a finished trial cannot simply
// be restarted either.
async function assertTrialAllowed(client, organizationId) {
  const result = await client.query(
    'select count(*)::int as n from organization_trials where organization_id = $1',
    [organizationId]
  );
  if (Number(result.rows[0].n) > 0) {
    throw serviceError(
      'Bu magaza icin deneme suresi daha once kullanildi',
      'TRIAL_ALREADY_USED', 409
    );
  }
}

async function startSubscription(client, {
  organizationId, planName, provider = 'manual', withTrial = false,
  trialDays = DEFAULT_TRIAL_DAYS, actorId = null, reason = '',
}) {
  const existing = await loadSubscription(client, organizationId, { lock: true });
  if (existing && !['cancelled', 'expired'].includes(existing.status)) {
    throw serviceError('Magazanin zaten aktif bir aboneligi var', 'SUBSCRIPTION_ALREADY_EXISTS', 409);
  }

  const version = await planVersions.resolveActiveVersion(client, planName);
  if (!version) {
    throw serviceError(`Plan icin yayinlanmis versiyon yok: ${planName}`, 'PLAN_VERSION_NOT_PUBLISHED', 400);
  }

  if (withTrial) await assertTrialAllowed(client, organizationId);

  const adapter = getProvider(provider);
  const remote = await adapter.startSubscription({
    organizationId,
    planName,
    planVersionId: Number(version.id),
    periodEnd: null,
    trialEnd: withTrial ? `${trialDays} days` : null,
  });

  const inserted = await client.query(
    `insert into subscriptions
       (organization_id, provider, plan, plan_version_id, status,
        provider_customer_id, provider_subscription_id,
        current_period_start, current_period_end, trial_start, trial_end,
        last_transition_at, last_transition_reason)
     values ($1,$2,$3,$4,$5,$6,$7, now(),
             now() + ($8 || ' days')::interval,
             case when $9 then now() else null end,
             case when $9 then now() + ($8 || ' days')::interval else null end,
             now(), $10)
     returning *`,
    [
      organizationId, adapter.name, planName, Number(version.id),
      withTrial ? 'trialing' : 'active',
      remote.customerReference || null, remote.subscriptionReference || null,
      String(withTrial ? trialDays : 30),
      withTrial,
      String(reason || 'subscription started').slice(0, 300),
    ]
  );
  const subscription = inserted.rows[0];

  if (withTrial) {
    await client.query(
      `insert into organization_trials (organization_id, subscription_id, plan_name, started_at, ends_at, outcome)
       values ($1,$2,$3, now(), $4, 'running')`,
      [organizationId, subscription.id, planName, subscription.trial_end]
    );
  }

  await lifecycle.recordTransition(client, {
    organizationId, subscriptionId: subscription.id,
    from: 'none', to: subscription.status, reason: reason || 'subscription started',
    actorType: actorId ? 'user' : 'system', actorId, billingEventId: null,
  });

  return { subscription, provider: providerCapabilities(adapter.name), remote };
}

// --- downgrade preview ---------------------------------------------------------------

// Read-only. It never writes, never deactivates anything, and only reports resources this
// platform actually measures — A27/A29 resources (domains, API calls, webhooks) are
// deliberately absent rather than reported with a fabricated usage of 0.
const PREVIEW_RESOURCES = Object.freeze([
  { key: 'products', limitKey: 'maxProducts', usageKey: 'products' },
  { key: 'members', limitKey: 'maxMembers', usageKey: 'members' },
  { key: 'orders_month', limitKey: 'maxOrdersMonth', usageKey: 'ordersMonth' },
  { key: 'storage_mb', limitKey: 'maxStorageMb', usageKey: 'storageMb' },
  { key: 'collections', limitKey: 'maxCollections', usageKey: 'collections' },
  { key: 'blog_posts', limitKey: 'maxBlogPosts', usageKey: 'blogPosts' },
]);

async function planChangePreview(client, { organizationId, targetPlanName }) {
  const usage = await getPlanUsage(client, organizationId);
  if (!usage) throw serviceError('Plan kullanimi cozulemedi', 'PLAN_USAGE_UNAVAILABLE', 404);

  const target = await planVersions.resolveActiveVersion(client, targetPlanName);
  if (!target) {
    throw serviceError(`Plan icin yayinlanmis versiyon yok: ${targetPlanName}`, 'PLAN_VERSION_NOT_PUBLISHED', 400);
  }
  const targetLimits = target.limits || {};

  const resources = PREVIEW_RESOURCES.map((resource) => {
    const currentUsage = Number(usage.usage[resource.usageKey] || 0);
    const targetLimit = Number(targetLimits[resource.limitKey] || 0);
    const exceeded = targetLimit > 0 && currentUsage > targetLimit;
    return {
      resource: resource.key,
      currentUsage,
      currentLimit: Number(usage.limits[resource.limitKey] || 0),
      targetLimit,
      exceeded,
      // Positive means "over by this much"; never negative.
      difference: exceeded ? currentUsage - targetLimit : 0,
    };
  });

  return {
    sourcePlan: usage.plan,
    sourcePlanVersion: usage.planVersion,
    targetPlan: targetPlanName,
    targetPlanVersion: Number(target.version),
    targetPlanVersionId: Number(target.id),
    resources,
    exceeded: resources.some((r) => r.exceeded),
    // Stated explicitly so the UI never implies data will be removed.
    dataImpact: 'none: exceeding a limit blocks new creation, it never deletes or deactivates existing data',
  };
}

// --- plan change ----------------------------------------------------------------------

function classifyChange(sourceLimits = {}, targetLimits = {}) {
  const keys = ['maxProducts', 'maxOrdersMonth', 'maxMembers', 'maxStorageMb'];
  let higher = 0;
  let lower = 0;
  for (const key of keys) {
    const from = Number(sourceLimits[key] || 0);
    const to = Number(targetLimits[key] || 0);
    if (to > from) higher += 1;
    if (to < from) lower += 1;
  }
  if (higher && !lower) return 'upgrade';
  if (lower && !higher) return 'downgrade';
  if (!higher && !lower) return 'same_plan_version';
  // Mixed movement is treated as a downgrade so the exceeded-limit policy applies.
  return 'downgrade';
}

// An upgrade applies immediately. A downgrade that would leave the tenant over a limit is
// NOT applied destructively: it is scheduled for period end, so nothing is deleted and the
// tenant keeps working until the term they paid for actually ends.
async function requestPlanChange(client, {
  organizationId, targetPlanName, actorId = null, reason = '', applyImmediately = null,
}) {
  const subscription = await loadSubscription(client, organizationId, { lock: true });
  if (!subscription) throw serviceError('Abonelik bulunamadi', 'SUBSCRIPTION_NOT_FOUND', 404);

  const preview = await planChangePreview(client, { organizationId, targetPlanName });
  const sourceVersion = await planVersions.loadVersionById(client, subscription.plan_version_id);
  const targetVersion = await planVersions.loadVersionById(client, preview.targetPlanVersionId);
  const changeType = classifyChange(sourceVersion?.limits, targetVersion?.limits);

  const immediate = applyImmediately == null
    ? (changeType !== 'downgrade' || !preview.exceeded)
    : Boolean(applyImmediately);

  const adapter = getProvider(subscription.provider);
  let remote = null;
  if (immediate) {
    remote = await adapter.changePlan({
      organizationId,
      subscriptionReference: subscription.provider_subscription_id,
      targetPlanName,
      targetPlanVersionId: preview.targetPlanVersionId,
    });
  }

  const request = await client.query(
    `insert into plan_change_requests
       (organization_id, subscription_id, source_plan_name, source_plan_version_id,
        target_plan_name, target_plan_version_id, change_type, status,
        preview_snapshot, proration, requested_by, effective_at, applied_at, failure_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,null)
     returning *`,
    [
      organizationId, subscription.id, subscription.plan, subscription.plan_version_id,
      targetPlanName, preview.targetPlanVersionId, changeType,
      immediate ? 'applied' : 'scheduled',
      JSON.stringify(preview),
      JSON.stringify(remote?.proration || { supported: Boolean(adapter.supportsProration), reason: 'not_applicable', amount: null }),
      actorId,
      immediate ? null : subscription.current_period_end,
      immediate ? new Date().toISOString() : null,
    ]
  );

  if (immediate) {
    await client.query(
      `update subscriptions set plan = $2, plan_version_id = $3, updated_at = now()
        where id = $1`,
      [subscription.id, targetPlanName, preview.targetPlanVersionId]
    );
    // organizations.plan stays the display/fallback value the rest of the app reads.
    await client.query('update organizations set plan = $2, updated_at = now() where id = $1',
      [organizationId, targetPlanName]);
  }

  await client.query(
    `insert into activity_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1,$2,'SUBSCRIPTION_PLAN_CHANGE','subscription',$3,$4::jsonb)`,
    [organizationId, actorId, String(subscription.id), JSON.stringify({
      change_type: changeType,
      target_plan: targetPlanName,
      applied: immediate,
      exceeded: preview.exceeded,
      reason: String(reason || '').slice(0, 300),
    })]
  );

  return { request: request.rows[0], preview, applied: immediate, proration: remote?.proration || null };
}

// --- cancel / resume ------------------------------------------------------------------

async function cancelAtPeriodEnd(client, { organizationId, actorId = null, reason = '' }) {
  const subscription = await loadSubscription(client, organizationId, { lock: true });
  if (!subscription) throw serviceError('Abonelik bulunamadi', 'SUBSCRIPTION_NOT_FOUND', 404);
  const adapter = getProvider(subscription.provider);
  await adapter.cancel({ subscriptionReference: subscription.provider_subscription_id, atPeriodEnd: true });
  const updated = await client.query(
    `update subscriptions set cancel_at_period_end = true, updated_at = now(),
            last_transition_reason = $2
      where id = $1 returning *`,
    [subscription.id, String(reason || 'cancel at period end').slice(0, 300)]
  );
  await client.query(
    `insert into activity_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1,$2,'SUBSCRIPTION_CANCEL_SCHEDULED','subscription',$3,$4::jsonb)`,
    [organizationId, actorId, String(subscription.id), JSON.stringify({ effective_at: subscription.current_period_end })]
  );
  return updated.rows[0];
}

async function resumeScheduledCancel(client, { organizationId, actorId = null }) {
  const subscription = await loadSubscription(client, organizationId, { lock: true });
  if (!subscription) throw serviceError('Abonelik bulunamadi', 'SUBSCRIPTION_NOT_FOUND', 404);
  if (!subscription.cancel_at_period_end) {
    throw serviceError('Planlanmis bir iptal yok', 'NO_SCHEDULED_CANCELLATION', 409);
  }
  const adapter = getProvider(subscription.provider);
  await adapter.resume({ subscriptionReference: subscription.provider_subscription_id });
  const updated = await client.query(
    'update subscriptions set cancel_at_period_end = false, updated_at = now() where id = $1 returning *',
    [subscription.id]
  );
  await client.query(
    `insert into activity_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1,$2,'SUBSCRIPTION_CANCEL_REVOKED','subscription',$3,'{}'::jsonb)`,
    [organizationId, actorId, String(subscription.id)]
  );
  return updated.rows[0];
}

// --- billing events -------------------------------------------------------------------

// Stores a provider event exactly once. The unique index is the real guarantee; this
// returns `duplicate` so the caller can answer the webhook 200 without re-processing.
async function ingestBillingEvent(client, { organizationId = null, provider, event }) {
  const normalized = normalizeProviderEvent(provider, event);
  const inserted = await client.query(
    `insert into billing_events
       (organization_id, provider, provider_event_id, event_type, event_sequence,
        event_created_at, payload, status)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending')
     on conflict (provider, provider_event_id) do nothing
     returning *`,
    [
      organizationId, normalized.provider, normalized.providerEventId, normalized.eventType,
      normalized.eventSequence, normalized.eventCreatedAt,
      JSON.stringify(normalized.payload || {}),
    ]
  );
  if (!inserted.rows[0]) {
    const existing = await client.query(
      'select * from billing_events where provider = $1 and provider_event_id = $2',
      [normalized.provider, normalized.providerEventId]
    );
    return { event: existing.rows[0], duplicate: true };
  }
  return { event: inserted.rows[0], duplicate: false };
}

// An event older than what has already been applied must not rewind state. Ordering uses
// the provider's own sequence where it gives one, and falls back to received_at.
async function isStaleEvent(client, { subscriptionId, eventSequence, receivedAt }) {
  if (!subscriptionId) return false;
  const applied = await client.query(
    `select event_sequence, received_at from billing_events
      where subscription_id = $1 and status = 'processed'
      order by event_sequence desc nulls last, received_at desc limit 1`,
    [subscriptionId]
  );
  const latest = applied.rows[0];
  if (!latest) return false;
  if (eventSequence != null && latest.event_sequence != null) {
    return Number(eventSequence) < Number(latest.event_sequence);
  }
  if (receivedAt && latest.received_at) {
    return new Date(receivedAt).getTime() < new Date(latest.received_at).getTime();
  }
  return false;
}

module.exports = {
  DEFAULT_TRIAL_DAYS,
  DEFAULT_GRACE_DAYS,
  PREVIEW_RESOURCES,
  loadSubscription,
  assertTrialAllowed,
  startSubscription,
  planChangePreview,
  classifyChange,
  requestPlanChange,
  cancelAtPeriodEnd,
  resumeScheduledCancel,
  ingestBillingEvent,
  isStaleEvent,
  serviceError,
};
