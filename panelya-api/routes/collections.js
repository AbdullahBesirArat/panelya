const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization, slugify } = require('../services/tenant');
const { assertPlanCapacity } = require('../services/planLimits');
const {
  listCollectionProducts,
  normalizeMemberIds,
  replaceCollectionProducts,
} = require('../services/collectionMemberships');
const { syncMediaReferences } = require('../services/mediaAssets');
const { rateLimit } = require('../middleware/security');
const {
  listPublicCollections,
  listPreviewCollections,
} = require('../services/collectionReads');

const router = express.Router();
const managerOnly = [requireAuth, requireRole(['super_admin', 'owner', 'admin'])];
const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.THEME_PREVIEW_RATE_LIMIT || 120),
  message: 'Cok fazla onizleme istegi. Lutfen biraz sonra tekrar deneyin.',
});

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
    const collections = await listPublicCollections(db, { organizationId: organization.id });
    res.json(collections);
  } catch (err) {
    next(err);
  }
});

// A valid theme-preview session may read the inactive collections explicitly selected by
// that same tenant's draft. The public route above remains active-only and query flags do
// not participate in this authorization decision.
router.get('/preview', previewLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const token = String(req.get('x-theme-preview-token') || '').trim();
    if (!token) {
      await client.query('rollback');
      return res.status(400).json({ error: 'Onizleme anahtari zorunlu', code: 'THEME_PREVIEW_TOKEN_REQUIRED' });
    }
    const collections = await listPreviewCollections(client, {
      organizationId: organization.id,
      token,
    });
    await client.query('commit');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.json(collections);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    return next(err);
  } finally {
    client.release();
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
    await syncMediaReferences(db, {
      organizationId: organization.id,
      resourceType: 'collection',
      resourceId: result.rows[0].id,
      values: payload.image_url,
      altText: payload.title,
    });

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
    await syncMediaReferences(db, {
      organizationId: organization.id,
      resourceType: 'collection',
      resourceId: req.params.id,
      values: payload.image_url,
      altText: payload.title,
    });

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

router.get('/:id/products', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const collectionResult = await db.query(
      'select id, slug, title from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const collection = collectionResult.rows[0];
    if (!collection) return res.status(404).json({ error: 'Koleksiyon bulunamadi' });

    const products = await listCollectionProducts(db, {
      organizationId: organization.id,
      collectionId: collection.id,
    });

    res.json({
      collection: { id: collection.id, slug: collection.slug, title: collection.title },
      products: products.rows.map((product) => ({
        id: product.id,
        name: product.name,
        status: product.status,
        tags: product.tags || '',
        is_member: Boolean(product.is_member),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/products', ...managerOnly, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    await db.setTenantContext(client, organization.id);
    const collectionResult = await client.query(
      'select id, slug, title from collections where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const collection = collectionResult.rows[0];
    if (!collection) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Koleksiyon bulunamadi' });
    }

    const memberIds = normalizeMemberIds(req.body && req.body.memberIds);
    const result = await replaceCollectionProducts(client, {
      organizationId: organization.id,
      collectionId: collection.id,
      memberIds,
    });
    await client.query('commit');

    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'collection',
      resourceId: collection.id,
      newValue: { memberCount: result.memberCount },
    });

    res.json({ updated: result.memberCount, memberCount: result.memberCount });
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    next(err);
  } finally {
    client.release();
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
    await syncMediaReferences(db, {
      organizationId: organization.id,
      resourceType: 'collection',
      resourceId: req.params.id,
      values: [],
    });
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
