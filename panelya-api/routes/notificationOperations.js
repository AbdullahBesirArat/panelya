const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const admin = require('../modules/notifications/admin');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

router.get('/overview', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.overview(db, { organizationId: organization.id });
    res.json(data);
  } catch (error) { next(error); }
});

router.get('/outbox', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.listOutbox(db, {
      organizationId: organization.id,
      status: req.query.status, eventType: req.query.event_type, channel: req.query.channel,
      page: req.query.page, pageSize: req.query.page_size,
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.get('/deliveries', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.listDeliveries(db, {
      organizationId: organization.id, status: req.query.status,
      page: req.query.page, pageSize: req.query.page_size,
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.get('/failed', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.listFailed(db, {
      organizationId: organization.id, page: req.query.page, pageSize: req.query.page_size,
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.get('/subscriptions', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.listSubscriptions(db, {
      organizationId: organization.id,
      subscriptionType: req.query.subscription_type, status: req.query.status,
      page: req.query.page, pageSize: req.query.page_size,
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.get('/suppressions', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.listSuppressions(db, {
      organizationId: organization.id, page: req.query.page, pageSize: req.query.page_size,
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.get('/providers', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    await resolveOrganization(req);
    res.json({ providers: admin.providerStatus() });
  } catch (error) { next(error); }
});

router.get('/metrics', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const data = await admin.metrics(db, {
      organizationId: organization.id, windowDays: req.query.window_days,
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.post('/outbox/:id/retry', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await admin.retryOutbox(db, { organizationId: organization.id, outboxId: req.params.id });
    await auditLog(req, {
      action: 'notification.retry', resourceType: 'notification_outbox', resourceId: String(req.params.id),
      newValue: { status: result.status }, organizationId: organization.id,
    });
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/suppressions', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await admin.manualSuppress(db, {
      organizationId: organization.id,
      channel: req.body.channel, email: req.body.email || '', phone: req.body.phone || '',
      reason: String(req.body.reason || 'manual'),
    });
    await auditLog(req, {
      action: 'notification.suppress', resourceType: 'communication_suppression', resourceId: result.channel,
      newValue: { channel: result.channel }, organizationId: organization.id,
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

module.exports = router;
