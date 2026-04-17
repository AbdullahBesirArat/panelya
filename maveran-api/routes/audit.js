const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, requireRole(['super_admin']), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const resourceType = String(req.query.resource_type || '').trim();
    const adminId = Number(req.query.admin_id || 0);
    const params = [];
    const filters = [];

    if (resourceType) {
      params.push(resourceType.slice(0, 80));
      filters.push(`a.resource_type = $${params.length}`);
    }

    if (Number.isInteger(adminId) && adminId > 0) {
      params.push(adminId);
      filters.push(`a.admin_id = $${params.length}`);
    }

    params.push(limit, offset);
    const whereClause = filters.length ? `where ${filters.join(' and ')}` : '';
    const result = await db.query(
      `select a.*, admins.username
       from audit_logs a
       left join admins on admins.id = a.admin_id
       ${whereClause}
       order by a.timestamp desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
