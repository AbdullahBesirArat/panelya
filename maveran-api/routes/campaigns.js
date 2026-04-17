const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');

const router = express.Router();
const adminOnly = [requireAuth, requireRole(['super_admin', 'admin'])];

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
    const result = await db.query(
      `select * from campaigns
       where active = true and (end_date is null or end_date >= current_date)
       order by end_date nulls last, id desc`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/all', requireAuth, requireRole(['super_admin', 'admin', 'viewer']), async (req, res, next) => {
  try {
    const result = await db.query('select * from campaigns order by id desc');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', ...adminOnly, async (req, res, next) => {
  try {
    const payload = campaignPayload(req.body);
    if (!payload.name || !payload.type) return res.status(400).json({ error: 'Kampanya adi ve tipi zorunlu' });

    const result = await db.query(
      `insert into campaigns (name, type, value, end_date, active)
       values ($1,$2,$3,$4,$5)
       returning *`,
      [payload.name, payload.type, payload.value, payload.end_date, payload.active]
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

router.put('/:id', ...adminOnly, async (req, res, next) => {
  try {
    const payload = campaignPayload(req.body);
    if (!payload.name || !payload.type) return res.status(400).json({ error: 'Kampanya adi ve tipi zorunlu' });

    const oldResult = await db.query('select * from campaigns where id = $1', [req.params.id]);
    const result = await db.query(
      `update campaigns set name=$1, type=$2, value=$3, end_date=$4, active=$5, updated_at=now()
       where id=$6 returning *`,
      [payload.name, payload.type, payload.value, payload.end_date, payload.active, req.params.id]
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

router.delete('/:id', requireAuth, requireRole(['super_admin']), async (req, res, next) => {
  try {
    const oldResult = await db.query('select * from campaigns where id = $1', [req.params.id]);
    await db.query('delete from campaigns where id = $1', [req.params.id]);
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
