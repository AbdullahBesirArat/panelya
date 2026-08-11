const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/authSession');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const { getPlanUsage } = require('../services/planLimits');
const { resolveAccess } = require('../services/subscriptionAccess');
const { providerCapabilities } = require('../services/subscriptionProviders');
const service = require('../services/subscriptionService');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
// Billing actions are an owner/admin concern, not a member/viewer one.
const BILLING_ROLES = ['super_admin', 'owner', 'admin'];

// Soft-warning threshold. Configurable rather than hardcoded per resource, and always
// distinct from the hard block, which is enforced server-side by assertPlanCapacity.
const WARNING_RATIO = Math.min(Math.max(Number(process.env.PLAN_WARNING_RATIO || 0.8), 0.5), 0.99);

function withWarnings(usage) {
  const pairs = [
    ['products', 'maxProducts', 'products'],
    ['ordersMonth', 'maxOrdersMonth', 'orders_month'],
    ['members', 'maxMembers', 'members'],
    ['storageMb', 'maxStorageMb', 'storage_mb'],
    ['collections', 'maxCollections', 'collections'],
    ['blogPosts', 'maxBlogPosts', 'blog_posts'],
  ];
  return pairs.map(([usageKey, limitKey, resource]) => {
    const used = Number(usage.usage[usageKey] || 0);
    const limit = Number(usage.limits[limitKey] || 0);
    const ratio = limit > 0 ? used / limit : 0;
    return {
      resource,
      used,
      limit,
      ratio: Number(ratio.toFixed(4)),
      // Two distinct states: a warning is advisory, a block is what the backend enforces.
      warning: limit > 0 && ratio >= WARNING_RATIO && used < limit,
      atLimit: limit > 0 && used >= limit,
    };
  });
}

function presentSubscription(subscription) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    provider: subscription.provider,
    plan: subscription.plan,
    plan_version_id: subscription.plan_version_id,
    status: subscription.status,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    trial_start: subscription.trial_start,
    trial_end: subscription.trial_end,
    grace_until: subscription.grace_until,
    suspended_at: subscription.suspended_at,
    suspension_reason: subscription.suspension_reason,
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancelled_at: subscription.cancelled_at,
  };
}

// Tenant-facing snapshot: subscription, pinned plan version, usage, warnings, access.
router.get('/', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const subscription = await service.loadSubscription(db, organization.id);
    const usage = await getPlanUsage(db, organization.id);
    const access = resolveAccess(subscription);
    res.json({
      subscription: presentSubscription(subscription),
      provider: subscription ? providerCapabilities(subscription.provider) : null,
      plan: usage ? {
        name: usage.plan,
        version: usage.planVersion,
        version_id: usage.planVersionId,
        limit_source: usage.limitSource,
        overrides: usage.overrides,
      } : null,
      usage: usage ? usage.usage : null,
      limits: usage ? usage.limits : null,
      warnings: usage ? withWarnings(usage) : [],
      access,
    });
  } catch (error) { next(error); }
});

router.get('/invoices', requireAuth, requireRole(BILLING_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select id, invoice_number, provider, provider_invoice_reference, currency,
              subtotal, tax_total, total, status, period_start, period_end,
              issued_at, due_at, paid_at, created_at
         from subscription_invoices
        where organization_id = $1
        order by issued_at desc nulls last, id desc
        limit 100`,
      [organization.id]
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

// Read-only downgrade/upgrade preview. Never writes; explicitly reports that exceeding a
// limit blocks creation rather than deleting anything.
router.get('/plan-change/preview', requireAuth, requireRole(BILLING_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const targetPlanName = String(req.query.plan || req.query.target_plan || '').trim();
    if (!targetPlanName) return res.status(400).json({ error: 'Hedef plan zorunlu', code: 'TARGET_PLAN_REQUIRED' });
    const preview = await service.planChangePreview(db, { organizationId: organization.id, targetPlanName });
    res.json({ preview });
  } catch (error) { next(error); }
});

router.post('/plan-change', requireAuth, requireRole(BILLING_ROLES), requireStepUp('billing'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organization = await resolveOrganization(req);
    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    const result = await service.requestPlanChange(client, {
      organizationId: organization.id,
      targetPlanName: String(req.body.plan || req.body.target_plan || '').trim(),
      actorId: req.auth?.userId || null,
      reason: req.body.reason || '',
    });
    await client.query('commit');
    await auditLog(req, {
      action: result.applied ? 'SUBSCRIPTION_PLAN_CHANGED' : 'SUBSCRIPTION_PLAN_CHANGE_SCHEDULED',
      resourceType: 'subscription', resourceId: String(result.request.subscription_id),
      newValue: { target_plan: result.request.target_plan_name, change_type: result.request.change_type },
      organizationId: organization.id,
    });
    res.status(result.applied ? 200 : 202).json(result);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.post('/cancel', requireAuth, requireRole(BILLING_ROLES), requireStepUp('billing'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organization = await resolveOrganization(req);
    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    const subscription = await service.cancelAtPeriodEnd(client, {
      organizationId: organization.id,
      actorId: req.auth?.userId || null,
      reason: req.body?.reason || '',
    });
    await client.query('commit');
    await auditLog(req, {
      action: 'SUBSCRIPTION_CANCEL_SCHEDULED', resourceType: 'subscription',
      resourceId: String(subscription.id), organizationId: organization.id,
    });
    res.json({ subscription: presentSubscription(subscription) });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.post('/resume', requireAuth, requireRole(BILLING_ROLES), requireStepUp('billing'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organization = await resolveOrganization(req);
    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    const subscription = await service.resumeScheduledCancel(client, {
      organizationId: organization.id, actorId: req.auth?.userId || null,
    });
    await client.query('commit');
    await auditLog(req, {
      action: 'SUBSCRIPTION_CANCEL_REVOKED', resourceType: 'subscription',
      resourceId: String(subscription.id), organizationId: organization.id,
    });
    res.json({ subscription: presentSubscription(subscription) });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.withWarnings = withWarnings;
module.exports.presentSubscription = presentSubscription;
