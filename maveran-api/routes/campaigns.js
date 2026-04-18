const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();
const managerOnly = [requireAuth, requireRole(['super_admin', 'owner', 'admin'])];

/**
 * @swagger
 * /api/campaigns:
 *   get:
 *     summary: Aktif kampanyalari listeler
 *     tags: [Content]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: organizationSlug
 *         schema: { type: string, example: mavera }
 *     responses:
 *       200:
 *         description: Aktif kampanya dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Campaign'
 *   post:
 *     summary: Yeni kampanya olusturur
 *     tags: [Content]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name: { type: string, example: Showcase Launch }
 *               type: { type: string, example: percentage }
 *               value: { type: number, example: 15 }
 *               end_date: { type: string, format: date, nullable: true }
 *               active: { type: boolean, example: true }
 *     responses:
 *       201:
 *         description: Kampanya olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Campaign'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
function campaignPayload(body) {
  const value = Number(body.value || 0);
  return {
    name: String(body.name || '').trim().slice(0, 160),
    type: String(body.type || '').trim().slice(0, 80),
    value: Number.isFinite(value) ? Math.max(0, Math.min(value, 999999)) : 0,
    end_date: body.end_date || null,
    active: body.active !== false,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select * from campaigns
       where organization_id = $1
         and active = true
         and (end_date is null or end_date >= current_date)
       order by end_date nulls last, id desc`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/campaigns/admin/all:
 *   get:
 *     summary: Tum kampanyalari yonetim icin listeler
 *     tags: [Content]
 *     responses:
 *       200:
 *         description: Kampanya dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Campaign'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/admin/all', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      'select * from campaigns where organization_id = $1 order by id desc',
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
    const payload = campaignPayload(req.body);
    if (!payload.name || !payload.type) return res.status(400).json({ error: 'Kampanya adi ve tipi zorunlu' });

    const result = await db.query(
      `insert into campaigns (organization_id, name, type, value, end_date, active)
       values ($1,$2,$3,$4,$5,$6)
       returning *`,
      [organization.id, payload.name, payload.type, payload.value, payload.end_date, payload.active]
    );

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'campaign',
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
 * /api/campaigns/{id}:
 *   put:
 *     summary: Kampanyayi gunceller
 *     tags: [Content]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Kampanya guncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Campaign'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   delete:
 *     summary: Kampanyayi siler
 *     tags: [Content]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Kampanya silindi
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
    const payload = campaignPayload(req.body);
    if (!payload.name || !payload.type) return res.status(400).json({ error: 'Kampanya adi ve tipi zorunlu' });

    const oldResult = await db.query(
      'select * from campaigns where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await db.query(
      `update campaigns set name=$1, type=$2, value=$3, end_date=$4, active=$5, updated_at=now()
       where id=$6 and organization_id=$7 returning *`,
      [payload.name, payload.type, payload.value, payload.end_date, payload.active, req.params.id, organization.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Kampanya bulunamadi' });
    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'campaign',
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
      'select * from campaigns where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from campaigns where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'campaign',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
