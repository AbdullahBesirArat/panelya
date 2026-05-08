const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization, slugify } = require('../services/tenant');
const { assertPlanCapacity } = require('../services/planLimits');

const router = express.Router();
const managerOnly = [requireAuth, requireRole(['super_admin', 'owner', 'admin'])];

function blogPayload(body) {
  const sortOrder = Number(body.sort_order || 0);
  const title = String(body.title || '').trim().slice(0, 180);
  const publishedAt = String(body.published_at || '').trim();

  return {
    title,
    slug: slugify(body.slug || title),
    excerpt: String(body.excerpt || '').trim().slice(0, 500),
    content: String(body.content || '').trim().slice(0, 20000),
    image_url: String(body.image_url || '').trim().slice(0, 500),
    active: body.active !== false,
    sort_order: Number.isFinite(sortOrder) ? Math.max(0, Math.floor(sortOrder)) : 0,
    published_at: publishedAt || null,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const result = await db.query(
      `select *
       from blog_posts
       where organization_id = $1 and active = true
       order by sort_order asc, published_at desc nulls last, id desc
       limit 24`,
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
       from blog_posts
       where organization_id = $1
       order by sort_order asc, published_at desc nulls last, id desc`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const idOrSlug = String(req.params.idOrSlug || '').trim();
    const isNumericId = /^\d+$/.test(idOrSlug);
    const result = await db.query(
      `select *
       from blog_posts
       where organization_id = $1
         and active = true
         and ${isNumericId ? 'id = $2' : 'slug = $2'}
       limit 1`,
      [organization.id, isNumericId ? Number(idOrSlug) : idOrSlug]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Blog yazisi bulunamadi' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const payload = blogPayload(req.body);
    if (!payload.title || !payload.slug) return res.status(400).json({ error: 'Blog basligi zorunlu' });
    await assertPlanCapacity(db, organization.id, 'blog_posts');

    const result = await db.query(
      `insert into blog_posts
       (organization_id, title, slug, excerpt, content, image_url, active, sort_order, published_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,nullif($9, '')::timestamptz)
       returning *`,
      [
        organization.id,
        payload.title,
        payload.slug,
        payload.excerpt,
        payload.content,
        payload.image_url,
        payload.active,
        payload.sort_order,
        payload.published_at,
      ]
    );

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'blog_post',
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
    const payload = blogPayload(req.body);
    if (!payload.title || !payload.slug) return res.status(400).json({ error: 'Blog basligi zorunlu' });

    const oldResult = await db.query(
      'select * from blog_posts where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await db.query(
      `update blog_posts
       set title=$1, slug=$2, excerpt=$3, content=$4, image_url=$5,
           active=$6, sort_order=$7, published_at=nullif($8, '')::timestamptz, updated_at=now()
       where id=$9 and organization_id=$10
       returning *`,
      [
        payload.title,
        payload.slug,
        payload.excerpt,
        payload.content,
        payload.image_url,
        payload.active,
        payload.sort_order,
        payload.published_at,
        req.params.id,
        organization.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Blog yazisi bulunamadi' });

    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'blog_post',
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
      'select * from blog_posts where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from blog_posts where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'blog_post',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
