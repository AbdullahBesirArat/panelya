const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization, slugify } = require('../services/tenant');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select id, name, slug
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
    if (!name || !slug) return res.status(400).json({ error: 'Kategori adi zorunlu' });

    const result = await db.query(
      `insert into categories (organization_id, name, slug)
       values ($1, $2, $3)
       returning id, name, slug`,
      [organization.id, name, slug]
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
