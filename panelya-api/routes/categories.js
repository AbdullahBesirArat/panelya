const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization, slugify } = require('../services/tenant');

const router = express.Router();

/**
 * @swagger
 * /api/categories:
 *   get:
 *     summary: Kategori listesi
 *     tags: [Categories]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: organizationSlug
 *         schema: { type: string, example: panelya }
 *     responses:
 *       200:
 *         description: Kategori dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Category'
 *   post:
 *     summary: Yeni kategori olusturur
 *     tags: [Categories]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Fulfillment
 *               slug:
 *                 type: string
 *                 example: fulfillment
 *     responses:
 *       201:
 *         description: Kategori olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Category'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const result = await db.query(
      `select id, name, slug, image_url
       from categories
       where organization_id = $1
       order by name asc`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const name = String(req.body.name || '').trim().slice(0, 160);
    const slug = slugify(req.body.slug || name);
    const imageUrl = String(req.body.image_url || '').trim().slice(0, 500);
    if (!name || !slug) return res.status(400).json({ error: 'Kategori adi zorunlu' });

    const result = await db.query(
      `insert into categories (organization_id, name, slug, image_url)
       values ($1, $2, $3, $4)
       returning id, name, slug, image_url`,
      [organization.id, name, slug, imageUrl]
    );

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'category',
      resourceId: result.rows[0].id,
      newValue: result.rows[0],
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const name = String(req.body.name || '').trim().slice(0, 160);
    const slug = slugify(req.body.slug || name);
    const imageUrl = String(req.body.image_url || '').trim().slice(0, 500);
    if (!name || !slug) return res.status(400).json({ error: 'Kategori adi zorunlu' });

    const oldResult = await db.query(
      'select * from categories where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await db.query(
      `update categories
       set name = $1, slug = $2, image_url = $3, updated_at = now()
       where id = $4 and organization_id = $5
       returning id, name, slug, image_url`,
      [name, slug, imageUrl, req.params.id, organization.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Kategori bulunamadi' });

    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'category',
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
      'select * from categories where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from categories where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'category',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
