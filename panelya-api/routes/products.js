const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');
const { assertPlanCapacity } = require('../services/planLimits');

const router = express.Router();
const PRODUCT_STATUSES = ['active', 'draft', 'out'];

function normalizeProductIds(ids) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  return uniqueIds.slice(0, 200);
}

function safePaging(limit, offset, defaultLimit = 50) {
  return {
    limit: Math.min(Math.max(Number(limit) || defaultLimit, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

function productParams(body) {
  const price = Number(body.price);
  const salePrice = body.sale_price == null || body.sale_price === '' ? null : Number(body.sale_price);
  const stock = Number(body.stock || 0);
  const status = PRODUCT_STATUSES.includes(body.status) ? body.status : 'draft';

  if (!String(body.name || '').trim() || !Number.isFinite(price) || price <= 0) {
    throw Object.assign(new Error('Urun adi ve gecerli fiyat zorunlu'), { status: 400 });
  }

  return [
    String(body.name).trim().slice(0, 200),
    body.category_id ? Number(body.category_id) : null,
    price,
    Number.isFinite(salePrice) ? salePrice : null,
    Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0,
    status,
    JSON.stringify(Array.isArray(body.colors) ? body.colors.slice(0, 20) : []),
    JSON.stringify(Array.isArray(body.sizes) ? body.sizes.slice(0, 30) : []),
    JSON.stringify(Array.isArray(body.images) ? body.images.slice(0, 20) : []),
    JSON.stringify(body.details && typeof body.details === 'object' ? body.details : {}),
    String(body.tags || '').slice(0, 500),
    String(body.description || '').slice(0, 5000),
    String(body.emoji || '').slice(0, 16),
  ];
}

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
router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const { q = '', category_id, status, limit = 50, offset = 0 } = req.query;
    const paging = safePaging(limit, offset);
    const params = [organization.id, `%${String(q).slice(0, 120)}%`];
    const filters = ['p.organization_id = $1', 'p.name ilike $2'];

    if (category_id) {
      const categoryId = Number(category_id);
      if (!Number.isInteger(categoryId) || categoryId < 1) return res.status(400).json({ error: 'Kategori gecersiz' });
      params.push(categoryId);
      filters.push(`p.category_id = $${params.length}`);
    }

    if (status) {
      if (!PRODUCT_STATUSES.includes(status)) return res.status(400).json({ error: 'Durum gecersiz' });
      params.push(status);
      filters.push(`p.status = $${params.length}`);
    }

    params.push(paging.limit, paging.offset);

    const result = await db.query(
      `select
        p.id,
        p.name,
        p.category_id,
        c.name as category_name,
        p.price,
        p.sale_price,
        p.stock,
        p.status,
        p.colors,
        p.sizes,
        p.images,
        p.details,
        p.tags,
        p.description,
        p.emoji,
        p.created_at,
        p.updated_at
       from products p
       left join categories c on c.id = p.category_id and c.organization_id = p.organization_id
       where ${filters.join(' and ')}
       order by p.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const result = await db.query(
      `select p.*, c.name as category_name
       from products p
       left join categories c on c.id = p.category_id and c.organization_id = p.organization_id
       where p.id = $1 and p.organization_id = $2`,
      [req.params.id, organization.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Urun bulunamadi' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    await assertPlanCapacity(db, organization.id, 'products');
    const result = await db.query(
      `insert into products
       (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, images, details, tags, description, emoji)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning *`,
      [organization.id, ...productParams(req.body)]
    );

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'product',
      resourceId: result.rows[0].id,
      newValue: result.rows[0],
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
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
  try {
    const organization = await resolveOrganization(req);
    const oldResult = await db.query(
      'select * from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await db.query(
      `update products set
        name=$1, category_id=$2, price=$3, sale_price=$4, stock=$5, status=$6,
        colors=$7, sizes=$8, images=$9, details=$10, tags=$11, description=$12, emoji=$13,
        updated_at=now()
       where id=$14 and organization_id=$15
       returning *`,
      [...productParams(req.body), req.params.id, organization.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Urun bulunamadi' });
    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'product',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
      newValue: result.rows[0],
    });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
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
