const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();
const managerOnly = [requireAuth, requireRole(['super_admin', 'owner', 'admin'])];

/**
 * @swagger
 * /api/slider:
 *   get:
 *     summary: Aktif vitrin slaytlarini listeler
 *     tags: [Content]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: organizationSlug
 *         schema: { type: string, example: mavera }
 *     responses:
 *       200:
 *         description: Aktif slayt dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Slide'
 *   post:
 *     summary: Yeni vitrin slayti olusturur
 *     tags: [Content]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               tag: { type: string, example: Panelya Operations }
 *               title: { type: string, example: Mavera vitrin akisi }
 *               sub: { type: string, example: Siparis ve stok akisi }
 *               btn: { type: string, example: Katalogu ac }
 *               image_url: { type: string, example: https://images.unsplash.com/photo.jpg }
 *               active: { type: boolean, example: true }
 *               sort_order: { type: integer, example: 1 }
 *     responses:
 *       201:
 *         description: Slayt olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Slide'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
function slidePayload(body) {
  const sortOrder = Number(body.sort_order || 0);
  return {
    tag: String(body.tag || '').slice(0, 160),
    title: String(body.title || '').trim().slice(0, 200),
    sub: String(body.sub || '').slice(0, 240),
    btn: String(body.btn || 'Kesfet').slice(0, 80),
    image_url: String(body.image_url || '').slice(0, 500),
    active: body.active !== false,
    sort_order: Number.isFinite(sortOrder) ? Math.max(0, Math.floor(sortOrder)) : 0,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select * from slider_items
       where organization_id = $1 and active = true
       order by sort_order asc, id asc`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/slider/admin/all:
 *   get:
 *     summary: Tum vitrin slaytlarini yonetim icin listeler
 *     tags: [Content]
 *     responses:
 *       200:
 *         description: Slayt dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Slide'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/admin/all', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select * from slider_items
       where organization_id = $1
       order by sort_order asc, id asc`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const payload = slidePayload(req.body);
    if (!payload.title) return res.status(400).json({ error: 'Slayt basligi zorunlu' });

    const result = await db.query(
      `insert into slider_items (organization_id, tag, title, sub, btn, image_url, active, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [organization.id, payload.tag, payload.title, payload.sub, payload.btn, payload.image_url, payload.active, payload.sort_order]
    );
    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'slider',
      resourceId: result.rows[0].id,
      newValue: result.rows[0],
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/slider/{id}:
 *   put:
 *     summary: Vitrin slaytini gunceller
 *     tags: [Content]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Slayt guncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Slide'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   delete:
 *     summary: Vitrin slaytini siler
 *     tags: [Content]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Slayt silindi
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.put('/:id', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const payload = slidePayload(req.body);
    if (!payload.title) return res.status(400).json({ error: 'Slayt basligi zorunlu' });

    const oldResult = await db.query(
      'select * from slider_items where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await db.query(
      `update slider_items set tag=$1, title=$2, sub=$3, btn=$4, image_url=$5,
       active=$6, sort_order=$7, updated_at=now()
       where id=$8 and organization_id=$9 returning *`,
      [payload.tag, payload.title, payload.sub, payload.btn, payload.image_url, payload.active, payload.sort_order, req.params.id, organization.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Slayt bulunamadi' });
    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'slider',
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
      'select * from slider_items where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from slider_items where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'slider',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
