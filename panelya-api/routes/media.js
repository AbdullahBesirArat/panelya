const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { createObjectStorage } = require('../services/objectStorage');
const { queueAssetDeletion, processCleanupJobs, responsiveMediaUrls } = require('../services/mediaAssets');

const router = express.Router();
const storage = createObjectStorage();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIANTS = new Set(['thumbnail', 'card', 'detail']);

router.get('/:assetId/:variant', async (req, res, next) => {
  const assetId = String(req.params.assetId || '').toLowerCase();
  const variantName = String(req.params.variant || '').toLowerCase();
  if (!UUID_PATTERN.test(assetId) || !VARIANTS.has(variantName)) {
    return res.status(404).json({ error: 'Gorsel bulunamadi', requestId: req.id });
  }

  try {
    const result = await db.systemQuery(
      `select mv.object_key, mv.storage_provider, mv.bucket_name, mv.content_type, mv.byte_size
       from media_variants mv
       join upload_assets ua
         on ua.id = mv.asset_id and ua.organization_id = mv.organization_id
       where mv.asset_id = $1
         and mv.variant_name = $2
         and ua.status in ('ready', 'orphan_candidate')
       limit 1`,
      [assetId, variantName]
    );
    const variant = result.rows[0];
    if (!variant) return res.status(404).json({ error: 'Gorsel bulunamadi', requestId: req.id });
    if (variant.storage_provider !== storage.provider || (variant.bucket_name || null) !== (storage.bucket || null)) {
      return res.status(503).json({ error: 'Gorsel depolama servisi kullanilamiyor', requestId: req.id });
    }

    const publicUrl = storage.publicUrl(variant.object_key);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (publicUrl) return res.redirect(302, publicUrl);

    if (req.method === 'HEAD') {
      const head = await storage.head({ objectKey: variant.object_key });
      if (!head.exists) return res.status(404).end();
      res.setHeader('Content-Type', variant.content_type);
      res.setHeader('Content-Length', String(head.byteSize || variant.byte_size));
      return res.end();
    }
    const body = await storage.get({ objectKey: variant.object_key });
    res.setHeader('Content-Type', variant.content_type);
    res.setHeader('Content-Length', String(variant.byte_size));
    res.setHeader('Content-Disposition', 'inline');
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return res.send(Buffer.from(body));
    if (typeof body?.pipe === 'function') return body.pipe(res);
    if (typeof body?.transformToByteArray === 'function') {
      return res.send(Buffer.from(await body.transformToByteArray()));
    }
    throw new Error('Object storage okunabilir bir govde dondurmedi');
  } catch (error) {
    next(error);
  }
});

router.get('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  try {
    const checksums = req.query.checksums === undefined ? null : String(req.query.checksums).split(',');
    if (checksums && (!checksums.length || checksums.length > 72 || checksums.some(value => !/^[a-f0-9]{64}$/.test(value)))) {
      return res.status(400).json({ error: 'Gorsel checksum listesi gecersiz' });
    }
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select ua.id, ua.url, ua.original_filename, ua.byte_size, ua.content_type,
              ua.width, ua.height, ua.status, ua.created_at, ua.checksum,
              coalesce(jsonb_object_agg(mv.variant_name, jsonb_build_object(
                'url', mv.url, 'width', mv.width, 'height', mv.height, 'byte_size', mv.byte_size
              )) filter (where mv.id is not null), '{}'::jsonb) as variants,
              count(distinct mr.id)::int as reference_count
       from upload_assets ua
       left join media_variants mv on mv.asset_id = ua.id and mv.organization_id = ua.organization_id
       left join media_references mr on mr.asset_id = ua.id and mr.organization_id = ua.organization_id
       where ua.organization_id = $1 and ua.storage_provider <> 'legacy'
         and ($2::text[] is null or ua.checksum = any($2::text[]))
       group by ua.id
       order by ua.created_at desc
       limit 200`,
      [organization.id, checksums]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.delete('/:assetId', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const assetId = String(req.params.assetId || '').toLowerCase();
  if (!UUID_PATTERN.test(assetId)) return res.status(400).json({ error: 'Gorsel id gecersiz' });
  const client = await db.pool.connect();
  let organization;
  try {
    await client.query('begin');
    organization = await resolveOrganization(req, client);
    await db.setTenantContext(client, organization.id);
    const outcome = await queueAssetDeletion(client, { organizationId: organization.id, assetId });
    if (outcome.outcome === 'not_found') {
      await client.query('rollback');
      return res.status(404).json({ error: 'Gorsel bulunamadi' });
    }
    if (outcome.outcome === 'in_use') {
      await client.query('rollback');
      return res.status(409).json({ error: 'Kullanilan gorsel silinemez', references: outcome.references });
    }
    await client.query('commit');
    if (outcome.outcome === 'queued') {
      await processCleanupJobs({ storage, organizationId: organization.id, assetId }).catch(() => {});
    }
    return res.status(202).json({ ok: true, status: outcome.outcome });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.responsiveMediaUrls = responsiveMediaUrls;

module.exports = router;
