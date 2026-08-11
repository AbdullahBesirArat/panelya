const express = require('express');
const db = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/authSession');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const planVersions = require('../services/planVersions');
const lifecycle = require('../services/subscriptionLifecycle');
const service = require('../services/subscriptionService');
const { getProvider } = require('../services/subscriptionProviders');

const router = express.Router();

// Super-admin only, and rate limited like the rest of the platform surface. Cross-tenant
// reach exists ONLY behind this guard; nothing here is reachable with a tenant session.
const opsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PLATFORM_WRITE_RATE_LIMIT || 120),
  message: 'Cok fazla abonelik islemi. Lutfen biraz sonra tekrar deneyin.',
});
router.use(requireSuperAdmin, opsLimiter);
const requireBillingStepUp = requireStepUp('billing');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ensureOrganizationId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID.test(id)) throw Object.assign(new Error('Gecersiz magaza kimligi'), { status: 400 });
  return id;
}

// Every mutation must state why. An unexplained billing override is not acceptable even
// from a super-admin, so this is enforced rather than merely encouraged.
function requireReason(body) {
  const reason = String(body?.reason || '').trim();
  if (reason.length < 5) {
    throw Object.assign(new Error('Gerekce zorunlu (en az 5 karakter)'), {
      status: 400, code: 'REASON_REQUIRED',
    });
  }
  return reason.slice(0, 500);
}

// Super-admin work runs on the system pool (RLS-bypassing) because it is legitimately
// cross-tenant; each handler still scopes every statement by organization_id.
async function withSystemTransaction(run) {
  const client = await db.getSystemPool().connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --- plan definitions and versions ----------------------------------------------------

router.get('/plans', async (req, res, next) => {
  try {
    const [limits, versions] = await Promise.all([
      db.getSystemPool().query('select * from plan_limits order by plan_name'),
      db.getSystemPool().query('select * from plan_versions order by plan_name, version desc'),
    ]);
    res.json({ plans: limits.rows, versions: versions.rows });
  } catch (error) { next(error); }
});

router.post('/plans/:planName/versions', requireBillingStepUp, async (req, res, next) => {
  try {
    const planName = String(req.params.planName || '').trim();
    const created = await withSystemTransaction((client) => planVersions.createDraftVersion(client, {
      planName, limits: req.body.limits || {}, notes: req.body.notes || '',
    }));
    await auditLog(req, {
      action: 'PLAN_VERSION_DRAFTED', resourceType: 'plan_version', resourceId: String(created.id),
      newValue: { plan_name: planName, version: created.version },
    });
    res.status(201).json({ version: created });
  } catch (error) { next(error); }
});

// Publishing is the only way limits ever change, and it never rewrites history: existing
// subscriptions stay pinned to the version they were sold.
router.post('/plans/:planName/versions/:version/publish', requireBillingStepUp, async (req, res, next) => {
  try {
    const planName = String(req.params.planName || '').trim();
    const version = Number(req.params.version);
    const published = await withSystemTransaction((client) => planVersions.publishVersion(client, {
      planName, version, actorId: req.auth?.userId || null,
    }));
    await auditLog(req, {
      action: 'PLAN_VERSION_PUBLISHED', resourceType: 'plan_version', resourceId: String(published.id),
      newValue: { plan_name: planName, version },
    });
    res.json({ version: published });
  } catch (error) { next(error); }
});

// --- subscriptions --------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const result = await db.getSystemPool().query(
      `select s.*, o.slug as organization_slug, o.name as organization_name,
              pv.version as plan_version
         from subscriptions s
         join organizations o on o.id = s.organization_id
         left join plan_versions pv on pv.id = s.plan_version_id
        order by s.updated_at desc nulls last, s.created_at desc
        limit 200`
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.get('/:organizationId', async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const pool = db.getSystemPool();
    const [subscription, invoices, events, overrides, changes] = await Promise.all([
      pool.query('select * from subscriptions where organization_id = $1 order by created_at desc limit 1', [organizationId]),
      pool.query('select * from subscription_invoices where organization_id = $1 order by issued_at desc nulls last, id desc limit 50', [organizationId]),
      pool.query('select id, provider, provider_event_id, event_type, event_sequence, status, processing_attempts, last_error, received_at, processed_at from billing_events where organization_id = $1 order by received_at desc limit 50', [organizationId]),
      // is_live is computed against the database clock, which is the same authority
      // resolveEffectiveLimits uses. The UI must not re-derive expiry from a browser clock.
      pool.query(
        `select *, (revoked_at is null and expires_at > now()) as is_live
           from subscription_overrides where organization_id = $1
          order by created_at desc limit 50`,
        [organizationId]
      ),
      pool.query('select * from plan_change_requests where organization_id = $1 order by requested_at desc limit 50', [organizationId]),
    ]);
    res.json({
      subscription: subscription.rows[0] || null,
      invoices: invoices.rows,
      billing_events: events.rows,
      overrides: overrides.rows,
      plan_changes: changes.rows,
    });
  } catch (error) { next(error); }
});

// Manual grant: start a subscription for a tenant out of band.
router.post('/:organizationId/grant', requireBillingStepUp, async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const reason = requireReason(req.body);
    const result = await withSystemTransaction((client) => service.startSubscription(client, {
      organizationId,
      planName: String(req.body.plan || '').trim(),
      provider: req.body.provider || 'manual',
      withTrial: req.body.with_trial === true,
      actorId: req.auth?.userId || null,
      reason,
    }));
    await auditLog(req, {
      action: 'SUBSCRIPTION_GRANTED', resourceType: 'subscription',
      resourceId: String(result.subscription.id),
      newValue: { plan: result.subscription.plan, status: result.subscription.status, reason },
      organizationId,
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

// Explicit lifecycle control. The state machine validates the edge; an illegal one is
// refused with a machine-readable code and recorded, never silently ignored.
router.post('/:organizationId/transition', requireBillingStepUp, async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const reason = requireReason(req.body);
    const to = String(req.body.to || '').trim();
    const result = await withSystemTransaction((client) => lifecycle.transitionSubscription(client, {
      organizationId,
      to,
      reason,
      actorType: 'user',
      actorId: req.auth?.userId || null,
      graceUntil: req.body.grace_until || null,
      suspensionReason: req.body.suspension_reason || reason,
    }));
    await auditLog(req, {
      action: 'SUBSCRIPTION_TRANSITIONED', resourceType: 'subscription',
      resourceId: String(result.subscription.id),
      oldValue: { status: result.previous.status },
      newValue: { status: result.subscription.status, reason },
      organizationId,
    });
    res.json({ subscription: result.subscription, previous_status: result.previous.status });
  } catch (error) {
    if (error.code === 'INVALID_SUBSCRIPTION_TRANSITION' || error.code === 'SUBSCRIPTION_TRANSITION_NOOP') {
      await db.getSystemPool().query(
        `insert into activity_logs (organization_id, actor_user_id, action, entity_type, metadata)
         values ($1,$2,'SUBSCRIPTION_TRANSITION_REFUSED','subscription',$3::jsonb)`,
        [req.params.organizationId, req.auth?.userId || null, JSON.stringify(error.meta || {})]
      ).catch(() => {});
    }
    next(error);
  }
});

router.post('/:organizationId/plan-change', requireBillingStepUp, async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const reason = requireReason(req.body);
    const result = await withSystemTransaction((client) => service.requestPlanChange(client, {
      organizationId,
      targetPlanName: String(req.body.plan || '').trim(),
      actorId: req.auth?.userId || null,
      reason,
      applyImmediately: req.body.apply_immediately,
    }));
    await auditLog(req, {
      action: 'SUBSCRIPTION_PLAN_CHANGED', resourceType: 'subscription',
      resourceId: String(result.request.subscription_id),
      newValue: { target_plan: result.request.target_plan_name, applied: result.applied, reason },
      organizationId,
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Manual invoice record. There is no automated charge here: an invoice is only 'paid'
// when the admin states a settlement timestamp, which the schema also enforces.
router.post('/:organizationId/invoices', requireBillingStepUp, async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const reason = requireReason(req.body);
    const status = String(req.body.status || 'open');
    const paidAt = req.body.paid_at || null;
    if (status === 'paid' && !paidAt) {
      return res.status(400).json({
        error: 'Odendi olarak isaretlemek icin gercek tahsilat zamani zorunlu',
        code: 'PAID_REQUIRES_TIMESTAMP',
      });
    }
    const created = await withSystemTransaction(async (client) => {
      const subscription = await service.loadSubscription(client, organizationId);
      const result = await client.query(
        `insert into subscription_invoices
           (organization_id, subscription_id, provider, provider_invoice_reference,
            invoice_number, currency, subtotal, tax_total, total, status,
            period_start, period_end, issued_at, due_at, paid_at, provider_snapshot)
         values ($1,$2,$3,$4,$5,'TRY',$6,$7,$8,$9,$10,$11, now(), $12, $13, $14::jsonb)
         returning *`,
        [
          organizationId, subscription ? subscription.id : null,
          String(req.body.provider || 'manual'),
          req.body.provider_invoice_reference || null,
          String(req.body.invoice_number || `MAN-${Date.now()}`),
          Number(req.body.subtotal || 0), Number(req.body.tax_total || 0),
          Number(req.body.subtotal || 0) + Number(req.body.tax_total || 0),
          status,
          req.body.period_start || null, req.body.period_end || null,
          req.body.due_at || null, paidAt,
          JSON.stringify({ recorded_by: 'super_admin', reason }),
        ]
      );
      return result.rows[0];
    });
    await auditLog(req, {
      action: 'SUBSCRIPTION_INVOICE_RECORDED', resourceType: 'subscription_invoice',
      resourceId: String(created.id),
      newValue: { invoice_number: created.invoice_number, status: created.status, reason },
      organizationId,
    });
    res.status(201).json({ invoice: created });
  } catch (error) { next(error); }
});

// --- overrides ------------------------------------------------------------------------

router.post('/:organizationId/overrides', requireBillingStepUp, async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const reason = requireReason(req.body);
    const expiresAt = req.body.expires_at;
    if (!expiresAt) {
      return res.status(400).json({ error: 'Override icin bitis zamani zorunlu', code: 'EXPIRY_REQUIRED' });
    }
    const created = await withSystemTransaction(async (client) => {
      const subscription = await service.loadSubscription(client, organizationId);
      if (!subscription) throw Object.assign(new Error('Abonelik bulunamadi'), { status: 404 });
      const result = await client.query(
        `insert into subscription_overrides
           (organization_id, subscription_id, override_type, target_key, target_value,
            reason, created_by, expires_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning *`,
        [
          organizationId, subscription.id,
          String(req.body.override_type || 'limit'),
          String(req.body.target_key || ''),
          JSON.stringify(req.body.target_value || {}),
          reason, req.auth?.userId || null, expiresAt,
        ]
      );
      return result.rows[0];
    });
    await auditLog(req, {
      action: 'SUBSCRIPTION_OVERRIDE_CREATED', resourceType: 'subscription_override',
      resourceId: String(created.id),
      newValue: { target_key: created.target_key, expires_at: created.expires_at, reason },
      organizationId,
    });
    res.status(201).json({ override: created });
  } catch (error) { next(error); }
});

router.post('/:organizationId/overrides/:id/revoke', requireBillingStepUp, async (req, res, next) => {
  try {
    const organizationId = ensureOrganizationId(req.params.organizationId);
    const reason = requireReason(req.body);
    const revoked = await withSystemTransaction(async (client) => {
      const result = await client.query(
        `update subscription_overrides
            set revoked_at = now(), revoked_by = $3, updated_at = now()
          where organization_id = $1 and id = $2 and revoked_at is null returning *`,
        [organizationId, Number(req.params.id), req.auth?.userId || null]
      );
      if (!result.rows[0]) throw Object.assign(new Error('Override bulunamadi'), { status: 404 });
      return result.rows[0];
    });
    await auditLog(req, {
      action: 'SUBSCRIPTION_OVERRIDE_REVOKED', resourceType: 'subscription_override',
      resourceId: String(revoked.id), newValue: { reason }, organizationId,
    });
    res.json({ override: revoked });
  } catch (error) { next(error); }
});

// --- billing events -------------------------------------------------------------------

router.get('/billing-events/failed', async (req, res, next) => {
  try {
    const result = await db.getSystemPool().query(
      `select id, organization_id, provider, provider_event_id, event_type, status,
              processing_attempts, last_error, received_at, next_retry_at
         from billing_events
        where status in ('failed', 'pending')
        order by received_at desc limit 100`
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

// Requeue a failed event. This does NOT re-apply it blindly: it resets the row to pending
// so the normal processor re-evaluates it, including its staleness check.
router.post('/billing-events/:id/retry', requireBillingStepUp, async (req, res, next) => {
  try {
    const reason = requireReason(req.body);
    const updated = await withSystemTransaction(async (client) => {
      const result = await client.query(
        `update billing_events
            set status = 'pending', next_retry_at = now(), last_error = null, updated_at = now()
          where id = $1 and status = 'failed' returning *`,
        [Number(req.params.id)]
      );
      if (!result.rows[0]) throw Object.assign(new Error('Yeniden denenecek olay bulunamadi'), { status: 404 });
      return result.rows[0];
    });
    await auditLog(req, {
      action: 'BILLING_EVENT_REQUEUED', resourceType: 'billing_event',
      resourceId: String(updated.id), newValue: { reason },
      organizationId: updated.organization_id,
    });
    res.json({ event: updated });
  } catch (error) { next(error); }
});

// Provider capability probe, so the UI can show "not configured" honestly.
router.get('/providers/:name', async (req, res, next) => {
  try {
    const adapter = getProvider(String(req.params.name || 'manual'));
    res.json({
      provider: adapter.name,
      configured: adapter.configured !== false,
      supports_proration: Boolean(adapter.supportsProration),
    });
  } catch (error) { next(error); }
});

module.exports = router;
