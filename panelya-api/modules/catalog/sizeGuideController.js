'use strict';

const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');
const { resolveForProduct } = require('./sizeGuides');

// Public storefront endpoint: the resolved size guide for a product (override > category).
async function getProductSizeGuide(req, res, next) {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const productId = Number(req.query.product_id || req.query.productId);
    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({ error: 'Gecerli urun kimligi zorunlu', code: 'INVALID_PRODUCT_ID' });
    }
    const guide = await resolveForProduct(db, { organizationId: organization.id, productId });
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.json({ guide: guide || null });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getProductSizeGuide };
