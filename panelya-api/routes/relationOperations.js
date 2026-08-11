const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const relations = require('../modules/catalog/relations');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

// Current curated targets for a source product, grouped by relation type.
router.get('/:productId', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const grouped = await relations.listRelations(db, {
      organizationId: organization.id, sourceProductId: req.params.productId,
    });
    res.json(grouped);
  } catch (error) { next(error); }
});

// Replace the curated target list for one relation type on a source product.
router.put('/:productId', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await relations.setRelations(db, {
      organizationId: organization.id,
      sourceProductId: req.params.productId,
      relationType: req.body.relation_type,
      targetProductIds: Array.isArray(req.body.target_product_ids) ? req.body.target_product_ids : [],
    });
    await auditLog(req, {
      action: 'relations.set', resourceType: 'product', resourceId: String(req.params.productId),
      newValue: result, organizationId: organization.id,
    });
    res.json(result);
  } catch (error) { next(error); }
});

module.exports = router;
