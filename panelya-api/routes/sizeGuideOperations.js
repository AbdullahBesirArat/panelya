const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const sg = require('../modules/catalog/sizeGuides');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

router.get('/', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json({ items: await sg.listGuides(db, { organizationId: organization.id }) });
  } catch (error) { next(error); }
});

router.post('/', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const guide = await sg.createGuide(db, { organizationId: organization.id, ...req.body });
    await auditLog(req, { action: 'size_guide.create', resourceType: 'size_guide', resourceId: String(guide.id), organizationId: organization.id });
    res.status(201).json({ guide });
  } catch (error) { next(error); }
});

router.put('/:id', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const guide = await sg.updateGuide(db, { organizationId: organization.id, guideId: req.params.id, ...req.body });
    await auditLog(req, { action: 'size_guide.update', resourceType: 'size_guide', resourceId: String(req.params.id), organizationId: organization.id });
    res.json({ guide });
  } catch (error) { next(error); }
});

router.delete('/:id', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    await sg.deleteGuide(db, { organizationId: organization.id, guideId: req.params.id });
    await auditLog(req, { action: 'size_guide.delete', resourceType: 'size_guide', resourceId: String(req.params.id), organizationId: organization.id });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/product/:productId', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json({ size_guide_id: await sg.getProductAssignment(db, { organizationId: organization.id, productId: req.params.productId }) });
  } catch (error) { next(error); }
});

router.put('/product/:productId', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await sg.assignToProduct(db, {
      organizationId: organization.id, productId: req.params.productId, sizeGuideId: req.body.size_guide_id,
    });
    await auditLog(req, { action: 'size_guide.assign', resourceType: 'product', resourceId: String(req.params.productId), newValue: result, organizationId: organization.id });
    res.json(result);
  } catch (error) { next(error); }
});

module.exports = router;
