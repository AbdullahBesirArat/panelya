const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');
const { assertPlanCapacity } = require('../services/planLimits');
const { setInventoryBalances } = require('../services/inventory');
const { syncMediaReferences } = require('../services/mediaAssets');
const notifications = require('../modules/notifications/service');

const router = express.Router();
const {
  PRODUCT_STATUSES,
  normalizeProductIds,
  normalizeStockUpdates,
  normalizeVariants,
  productParams,
} = require('../modules/catalog/validation');
const { isAdminManagementRequest } = require('../modules/catalog/policy');
const { assertCategoryScope, productSelect, fetchProduct } = require('../modules/catalog/repository');
const { synchronizeProductRelations } = require('../modules/catalog/service');
const { listProducts, getProduct } = require('../modules/catalog/controller');

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Urun listesi
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: organizationSlug
 *         schema: { type: string, example: panelya }
 *         description: Public API calls icin workspace slug
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: category_id
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, draft, out] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Urun dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *   post:
 *     summary: Yeni urun olusturur
 *     tags: [Products]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Inventory Control Pack
 *               category_id:
 *                 type: integer
 *                 nullable: true
 *               price:
 *                 type: number
 *                 example: 3290
 *               sale_price:
 *                 type: number
 *                 nullable: true
 *               stock:
 *                 type: integer
 *                 example: 10
 *               status:
 *                 type: string
 *                 enum: [active, draft, out]
 *                 default: draft
 *               colors:
 *                 type: array
 *                 items: { type: string }
 *               sizes:
 *                 type: array
 *                 items: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string }
 *               tags:
 *                 type: string
 *               description:
 *                 type: string
 *               emoji:
 *                 type: string
 *     responses:
 *       201:
 *         description: Urun olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/', listProducts);

router.get('/:id', getProduct);

router.post('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const variants = normalizeVariants(req.body.variants);
    const params = productParams(req.body);
    const requestedStock = params[4];
    const canonicalParams = [...params.slice(0, 4), ...params.slice(5)];

    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    await assertPlanCapacity(client, organization.id, 'products');
    await assertCategoryScope(client, organization.id, params[1]);
    const result = await client.query(
      `insert into products
       (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, images, details, tags, description, product_story, emoji, featured_in_category)
       values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning *`,
      [organization.id, ...canonicalParams]
    );
    await synchronizeProductRelations(client, {
      organizationId: organization.id,
      productId: result.rows[0].id,
      variants,
      defaultStock: requestedStock,
      productStatus: params[5],
      autoGenerateSku: req.body.auto_generate_sku === true,
      tenantPrefix: organization.slug,
      productName: params[0],
      actorId: req.auth?.sub || req.auth?.userId || null,
      images: JSON.parse(params[8]),
      altText: params[0],
    });
    const product = await fetchProduct(client, result.rows[0].id, organization.id);

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'product',
      resourceId: product.id,
      newValue: product,
    });
    await client.query('commit');
    res.status(201).json(product);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/bulk', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const ids = normalizeProductIds(req.body.ids);
    const action = String(req.body.action || '').trim();

    if (!ids.length) return res.status(400).json({ error: 'En az bir urun secin' });
    if (!['status', 'category', 'delete'].includes(action)) return res.status(400).json({ error: 'Toplu islem gecersiz' });
    if (action === 'delete' && !['owner', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Toplu silme icin sahip rolu gerekir' });
    }

    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    const oldResult = await client.query(
      'select id, name, status, category_id from products where organization_id = $1 and id = any($2::bigint[]) order by id',
      [organization.id, ids]
    );

    let result;
    if (action === 'status') {
      const status = PRODUCT_STATUSES.includes(req.body.status) ? req.body.status : '';
      if (!status) {
        await client.query('rollback');
        return res.status(400).json({ error: 'Durum gecersiz' });
      }
      result = await client.query(
        `update products
         set status = $1,
             updated_at = now()
         where organization_id = $2 and id = any($3::bigint[])
         returning id, name, status, category_id`,
        [status, organization.id, ids]
      );
    } else if (action === 'category') {
      const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
      if (categoryId) {
        const categoryResult = await client.query(
          'select id from categories where id = $1 and organization_id = $2 limit 1',
          [categoryId, organization.id]
        );
        if (!categoryResult.rows[0]) {
          await client.query('rollback');
          return res.status(400).json({ error: 'Kategori bulunamadi' });
        }
      }
      result = await client.query(
        `update products
         set category_id = $1,
             updated_at = now()
         where organization_id = $2 and id = any($3::bigint[])
         returning id, name, status, category_id`,
        [categoryId, organization.id, ids]
      );
    } else {
      result = await client.query(
        `delete from products
         where organization_id = $1 and id = any($2::bigint[])
         returning id, name, status, category_id`,
        [organization.id, ids]
      );
      for (const product of result.rows) {
        await syncMediaReferences(client, {
          organizationId: organization.id,
          resourceType: 'product',
          resourceId: product.id,
          fieldName: 'images',
          values: [],
        });
      }
    }

    await auditLog(req, {
      action: `BULK_${action.toUpperCase()}`,
      resourceType: 'product',
      newValue: {
        requestedIds: ids,
        affectedCount: result.rows.length,
        action,
        status: req.body.status || null,
        category_id: req.body.category_id || null,
      },
      oldValue: oldResult.rows,
    });
    await client.query('commit');

    res.json({
      ok: true,
      action,
      affectedCount: result.rows.length,
      products: result.rows,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/bulk-stock', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const updates = normalizeStockUpdates(req.body.updates || req.body.items);
    if (!updates.length) return res.status(400).json({ error: 'Gecerli stok guncellemesi zorunlu' });

    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    const oldProducts = await client.query(
      `select id, name, stock, status
       from products
       where organization_id = $1 and id = any($2::bigint[])
       order by id`,
      [organization.id, [...new Set(updates.map((item) => item.product_id))]]
    );

    const inventoryResult = await setInventoryBalances(client, updates, {
      organizationId: organization.id,
      reason: 'Bulk inventory adjustment',
      actorType: 'admin',
      actorId: req.auth?.sub || req.auth?.userId || null,
    });
    const variants = inventoryResult.results.map((entry) => entry.variant).filter(Boolean);
    const affectedCount = inventoryResult.results.length;
    // A23: notify back-in-stock subscribers for every variant this adjustment brought
    // from 0 -> positive availability, atomically within this stock transaction.
    await notifications.notifyRestockTransitions(client, {
      organizationId: organization.id,
      results: inventoryResult.results,
    });
    await auditLog(req, {
      action: 'BULK_STOCK',
      resourceType: 'product',
      oldValue: oldProducts.rows,
      newValue: {
        requestedCount: updates.length,
        affectedCount,
        products: inventoryResult.products,
        variants,
      },
    });
    await client.query('commit');

    res.json({
      ok: true,
      affectedCount,
      products: inventoryResult.products,
      variants,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/products/{id}:
 *   put:
 *     summary: Urunu gunceller
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name: { type: string, example: Inventory Control Pack }
 *               category_id: { type: integer, nullable: true }
 *               price: { type: number, example: 3290 }
 *               sale_price: { type: number, nullable: true }
 *               stock: { type: integer, example: 12 }
 *               status: { type: string, enum: [active, draft, out] }
 *               colors:
 *                 type: array
 *                 items: { type: string }
 *               sizes:
 *                 type: array
 *                 items: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string }
 *               tags: { type: string }
 *               description: { type: string }
 *               emoji: { type: string }
 *     responses:
 *       200:
 *         description: Urun guncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   delete:
 *     summary: Urunu siler
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Urun silindi
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.put('/:id', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const variants = normalizeVariants(req.body.variants);
    const params = productParams(req.body, { preserveMissingEmoji: true });
    const requestedStock = params[4];
    const canonicalParams = [...params.slice(0, 4), ...params.slice(5)];

    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    await assertCategoryScope(client, organization.id, params[1]);
    const oldProduct = await fetchProduct(client, req.params.id, organization.id);
    const oldResult = await client.query(
      'select * from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await client.query(
      `update products set
        name=$1, category_id=$2, price=$3, sale_price=$4, status=$5,
        colors=$6, sizes=$7, images=$8, details=$9, tags=$10, description=$11, product_story=$12, emoji=coalesce($13, emoji),
        featured_in_category=$14,
        updated_at=now()
       where id=$15 and organization_id=$16
      returning *`,
      [...canonicalParams, req.params.id, organization.id]
    );
    if (!result.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Urun bulunamadi' });
    }
    await synchronizeProductRelations(client, {
      organizationId: organization.id,
      productId: req.params.id,
      variants,
      defaultStock: requestedStock,
      productStatus: params[5],
      autoGenerateSku: req.body.auto_generate_sku === true,
      tenantPrefix: organization.slug,
      productName: params[0],
      actorId: req.auth?.sub || req.auth?.userId || null,
      images: JSON.parse(params[8]),
      altText: params[0],
    });
    const product = await fetchProduct(client, req.params.id, organization.id);
    // A23: a genuine drop in the server-authoritative effective price notifies price
    // alarm + wishlist subscribers, atomically within this update transaction.
    const previous = oldResult.rows[0];
    if (previous) {
      const oldEffective = Number(previous.sale_price ?? previous.price);
      const newEffective = Number(result.rows[0].sale_price ?? result.rows[0].price);
      if (Number.isFinite(newEffective) && newEffective < oldEffective) {
        await notifications.triggerEffectivePriceChange(client, {
          organizationId: organization.id, productId: Number(req.params.id), newPrice: newEffective,
        });
      }
    }
    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'product',
      resourceId: req.params.id,
      oldValue: oldProduct || oldResult.rows[0] || null,
      newValue: product,
    });
    await client.query('commit');
    res.json(product);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/products/category/{categoryId}/featured:
 *   put:
 *     summary: Bir kategorideki one cikan urunleri toplu ayarla
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: categoryId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               product_ids:
 *                 type: array
 *                 items: { type: integer }
 *     responses:
 *       200:
 *         description: Guncellenen kategori one cikan urun listesi
 */
router.put('/category/:categoryId/featured', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organization = await resolveOrganization(req, client);
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      return res.status(400).json({ error: 'Kategori gecersiz' });
    }
    const featuredIds = normalizeProductIds(req.body.product_ids || req.body.productIds || req.body.ids);

    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    await assertCategoryScope(client, organization.id, categoryId);

    const previous = await client.query(
      `select id, featured_in_category
       from products
       where organization_id = $1 and category_id = $2`,
      [organization.id, categoryId]
    );

    const result = await client.query(
      `update products
       set featured_in_category = case when id = any($1::bigint[]) then true else false end,
           updated_at = now()
       where organization_id = $2 and category_id = $3
       returning id, name, featured_in_category`,
      [featuredIds, organization.id, categoryId]
    );

    await auditLog(req, {
      action: 'UPDATE_FEATURED',
      resourceType: 'product',
      newValue: {
        category_id: categoryId,
        featured_ids: featuredIds,
        affected: result.rows.length,
      },
      oldValue: previous.rows,
    });

    await client.query('commit');
    res.json({
      ok: true,
      category_id: categoryId,
      featured_ids: result.rows.filter((row) => row.featured_in_category).map((row) => Number(row.id)),
      products: result.rows,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', requireAuth, requireRole(['super_admin', 'owner']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const oldResult = await db.query(
      'select * from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await syncMediaReferences(db, {
      organizationId: organization.id,
      resourceType: 'product',
      resourceId: req.params.id,
      fieldName: 'images',
      values: [],
    });
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'product',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Test edilebilirlik icin ic yardimcilar (route davranisini degistirmez).
module.exports.productSelect = productSelect;
module.exports.normalizeVariants = normalizeVariants;
module.exports.isAdminManagementRequest = isAdminManagementRequest;
