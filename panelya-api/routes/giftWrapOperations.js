const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const gift = require('../modules/cart/giftWrap');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

router.get('/', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json({ items: await gift.listOptions(db, { organizationId: organization.id }) });
  } catch (error) { next(error); }
});

router.post('/', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const option = await gift.createOption(db, { organizationId: organization.id, ...req.body });
    await auditLog(req, {
      action: 'gift_wrap.create', resourceType: 'gift_wrap_option', resourceId: String(option.id),
      newValue: { title: option.title, fee: option.fee, is_active: option.is_active },
      organizationId: organization.id,
    });
    res.status(201).json({ option });
  } catch (error) { next(error); }
});

router.put('/:id', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const option = await gift.updateOption(db, {
      organizationId: organization.id, optionId: req.params.id, ...req.body,
    });
    await auditLog(req, {
      action: 'gift_wrap.update', resourceType: 'gift_wrap_option', resourceId: String(req.params.id),
      newValue: { title: option.title, fee: option.fee, is_active: option.is_active },
      organizationId: organization.id,
    });
    res.json({ option });
  } catch (error) { next(error); }
});

// Activate / deactivate without touching the rest of the row. Deactivating is the
// safe way to retire a wrap: live carts drop it on their next reprice and historical
// orders keep their snapshot.
router.post('/:id/active', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const option = await gift.setOptionActive(db, {
      organizationId: organization.id, optionId: req.params.id, isActive: req.body.is_active === true,
    });
    await auditLog(req, {
      action: 'gift_wrap.set_active', resourceType: 'gift_wrap_option', resourceId: String(req.params.id),
      newValue: { is_active: option.is_active }, organizationId: organization.id,
    });
    res.json({ option });
  } catch (error) { next(error); }
});

router.delete('/:id', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    await gift.deleteOption(db, { organizationId: organization.id, optionId: req.params.id });
    await auditLog(req, {
      action: 'gift_wrap.delete', resourceType: 'gift_wrap_option', resourceId: String(req.params.id),
      organizationId: organization.id,
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
