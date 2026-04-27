const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization, slugify } = require('../services/tenant');

const router = express.Router();
const managerOnly = [requireAuth, requireRole(['super_admin', 'owner', 'admin'])];

function collectionPayload(body) {
  const sortOrder = Number(body.sort_order || 0);
  const title = String(body.title || '').trim().slice(0, 180);
  return {
    title,
    slug: slugify(body.slug || title),
    description: String(body.description || '').trim().slice(0, 320),
    image_url: String(body.image_url || '').trim().slice(0, 500),
    link_url: String(body.link_url || 'urunler.html').trim().slice(0, 500),
    active: body.active !== false,
    sort_order: Number.isFinite(sortOrder) ? Math.max(0, Math.floor(sortOrder)) : 0,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const result = await db.query(
      `select *
       from collections
       where organization_id = $1 and active = true
       order by sort_order asc, id asc`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/all', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select *
       from collections
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
    const payload = collectionPayload(req.body);
    if (!payload.title || !payload.slug) return res.status(400).json({ error: 'Koleksiyon basligi zorunlu' });

    const result = await db.query(
      `insert into collections (organization_id, title, slug, description, image_url, link_url, active, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        organization.id,
        payload.title,
        payload.slug,
        payload.description,
        payload.image_url,
        payload.link_url,
        payload.active,
        payload.sort_order,
      ]
    );

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'collection',
      resourceId: result.rows[0].id,
      newValue: result.rows[0],
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const payload = collectionPayload(req.body);
    if (!payload.title || !payload.slug) return res.status(400).json({ error: 'Koleksiyon basligi zorunlu' });

    const oldResult = await db.query(
      'select * from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await db.query(
      `update collections
       set title=$1, slug=$2, description=$3, image_url=$4, link_url=$5,
           active=$6, sort_order=$7, updated_at=now()
       where id=$8 and organization_id=$9
       returning *`,
      [
        payload.title,
        payload.slug,
        payload.description,
        payload.image_url,
        payload.link_url,
        payload.active,
        payload.sort_order,
        req.params.id,
        organization.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Koleksiyon bulunamadi' });

    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'collection',
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
      'select * from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'collection',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
