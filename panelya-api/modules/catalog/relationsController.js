'use strict';

const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');
const { resolveRelated, RELATION_TYPES } = require('./relations');

// Public storefront endpoint: related / complementary / upsell cards for a product.
async function listRelatedProducts(req, res, next) {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const productId = Number(req.query.product_id || req.query.productId);
    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({ error: 'Gecerli urun kimligi zorunlu', code: 'INVALID_PRODUCT_ID' });
    }
    const relationType = RELATION_TYPES.includes(req.query.type) ? req.query.type : 'related';
    const result = await resolveRelated(db, {
      organizationId: organization.id, productId, relationType, limit: req.query.limit,
    });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = { listRelatedProducts };
