const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization, slugify } = require('../services/tenant');
const { assertPlanCapacity } = require('../services/planLimits');

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
    link_url: String(body.link_url || 'urunler').trim().slice(0, 500),
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
    await assertPlanCapacity(db, organization.id, 'collections');

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

function parseTagList(value) {
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function serializeTagList(list) {
  const seen = new Set();
  const result = [];
  for (const tag of list) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result.join(',').slice(0, 500);
}

router.get('/:id/products', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const collectionResult = await db.query(
      'select id, slug, title from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const collection = collectionResult.rows[0];
    if (!collection) return res.status(404).json({ error: 'Koleksiyon bulunamadi' });

    const products = await db.query(
      `select id, name, status, tags
       from products
       where organization_id = $1
       order by name asc, id asc`,
      [organization.id]
    );

    const slug = String(collection.slug || '').toLowerCase();
    res.json({
      collection: { id: collection.id, slug: collection.slug, title: collection.title },
      products: products.rows.map((product) => ({
        id: product.id,
        name: product.name,
        status: product.status,
        tags: product.tags || '',
        is_member: parseTagList(product.tags).some((tag) => tag.toLowerCase() === slug),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/products', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const collectionResult = await db.query(
      'select id, slug, title from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const collection = collectionResult.rows[0];
    if (!collection) return res.status(404).json({ error: 'Koleksiyon bulunamadi' });
    const slug = String(collection.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Koleksiyon slug tanimsiz' });

    const memberIds = Array.isArray(req.body && req.body.memberIds) ? req.body.memberIds : [];
    const memberSet = new Set(
      memberIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    );

    const products = await db.query(
      'select id, tags from products where organization_id = $1',
      [organization.id]
    );

    const slugKey = slug.toLowerCase();
    const updates = [];
    for (const product of products.rows) {
      const current = parseTagList(product.tags);
      const hasMember = current.some((tag) => tag.toLowerCase() === slugKey);
      const shouldBeMember = memberSet.has(Number(product.id));
      if (hasMember === shouldBeMember) continue;

      let nextTags;
      if (shouldBeMember) {
        nextTags = serializeTagList([...current, slug]);
      } else {
        nextTags = serializeTagList(current.filter((tag) => tag.toLowerCase() !== slugKey));
      }
      updates.push({ id: product.id, tags: nextTags });
    }

    for (const update of updates) {
      await db.query(
        'update products set tags = $1, updated_at = now() where id = $2 and organization_id = $3',
        [update.tags, update.id, organization.id]
      );
    }

    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'collection',
      resourceId: collection.id,
      newValue: { slug, memberCount: memberSet.size, changed: updates.length },
    });

    res.json({ updated: updates.length, memberCount: memberSet.size });
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
