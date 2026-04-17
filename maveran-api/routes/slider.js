const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');

const router = express.Router();
const adminOnly = [requireAuth, requireRole(['super_admin', 'admin'])];

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
    const result = await db.query(
      'select * from slider_items where active = true order by sort_order asc, id asc'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/all', requireAuth, requireRole(['super_admin', 'admin', 'viewer']), async (req, res, next) => {
  try {
    const result = await db.query(
      'select * from slider_items order by sort_order asc, id asc'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', ...adminOnly, async (req, res, next) => {
  try {
    const payload = slidePayload(req.body);
    if (!payload.title) return res.status(400).json({ error: 'Slayt basligi zorunlu' });

    const result = await db.query(
      `insert into slider_items (tag, title, sub, btn, image_url, active, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning *`,
      [payload.tag, payload.title, payload.sub, payload.btn, payload.image_url, payload.active, payload.sort_order]
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

router.put('/:id', ...adminOnly, async (req, res, next) => {
  try {
    const payload = slidePayload(req.body);
    if (!payload.title) return res.status(400).json({ error: 'Slayt basligi zorunlu' });

    const oldResult = await db.query('select * from slider_items where id = $1', [req.params.id]);
    const result = await db.query(
      `update slider_items set tag=$1, title=$2, sub=$3, btn=$4, image_url=$5,
       active=$6, sort_order=$7, updated_at=now()
       where id=$8 returning *`,
      [payload.tag, payload.title, payload.sub, payload.btn, payload.image_url, payload.active, payload.sort_order, req.params.id]
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

router.delete('/:id', requireAuth, requireRole(['super_admin']), async (req, res, next) => {
  try {
    const oldResult = await db.query('select * from slider_items where id = $1', [req.params.id]);
    await db.query('delete from slider_items where id = $1', [req.params.id]);
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
