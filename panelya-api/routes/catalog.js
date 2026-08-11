const express = require('express');
const { listPublicCatalog } = require('../modules/catalog/publicController');
const { listRelatedProducts } = require('../modules/catalog/relationsController');
const { listProductCardsByIds } = require('../modules/catalog/cardsController');
const { getProductSizeGuide } = require('../modules/catalog/sizeGuideController');

const router = express.Router();

/**
 * @swagger
 * /api/catalog/products:
 *   get:
 *     summary: Public, paginated product catalog with disjunctive facets
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: organizationSlug
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         schema: { type: string, maxLength: 120 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 60, default: 24 }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [recommended, newest, oldest, price_asc, price_desc, name_asc] }
 *     responses:
 *       200:
 *         description: Catalog page and database-backed facets
 *       304:
 *         description: ETag matched
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.get('/products', listPublicCatalog);

/**
 * @swagger
 * /api/catalog/related:
 *   get:
 *     summary: Related / complementary / upsell products for a product (curated or fallback)
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: product_id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [related, complementary, upsell] }
 *     responses:
 *       200:
 *         description: Ordered product cards (curated first, else deterministic fallback)
 */
router.get('/related', listRelatedProducts);

/**
 * @swagger
 * /api/catalog/by-ids:
 *   get:
 *     summary: Ordered public product cards for an explicit id list (recently viewed / compare)
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: ids
 *         required: true
 *         schema: { type: string, example: "12,7,3" }
 *     responses:
 *       200:
 *         description: Active/out product cards in the requested order (passive ids dropped)
 */
router.get('/by-ids', listProductCardsByIds);

/**
 * @swagger
 * /api/catalog/size-guide:
 *   get:
 *     summary: Resolved size guide for a product (product override, else category default)
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: product_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: The active resolved guide, or null when none applies
 */
router.get('/size-guide', getProductSizeGuide);

module.exports = router;
