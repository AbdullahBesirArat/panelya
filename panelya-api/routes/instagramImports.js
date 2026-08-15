const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const { consumeOAuthState } = require('../modules/instagram/oauthState');
const service = require('../modules/instagram/service');
const { scheduleInstagramWorker } = require('../modules/instagram/worker');

const router = express.Router();
router.use(requireAuth, requireRole(['owner', 'admin']));
const oauthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Instagram baglanti istek limiti asildi' });
const syncLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: 'Instagram senkronizasyon istek limiti asildi' });
const analysisLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Instagram analiz istek limiti asildi' });
const applyLimit = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Instagram urun olusturma istek limiti asildi' });

async function withOrganization(req, fn) {
  const client = await db.pool.connect();
  try {
    const organization = await resolveOrganization(req, client);
    await client.query('begin');
    await db.setTenantContext(client, organization.id);
    const result = await fn(client, organization);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
  finally { client.release(); }
}

router.get('/connections', async (req, res, next) => {
  try { res.json(await withOrganization(req, (client, org) => service.listConnections(client, org.id))); }
  catch (error) { next(error); }
});

router.post('/oauth/start', oauthLimit, async (req, res, next) => {
  try {
    const result = await withOrganization(req, (client, org) => service.beginOAuth(client, {
      organizationId: org.id, actorId: req.auth.userId,
    }));
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.get('/oauth/callback', oauthLimit, async (req, res, next) => {
  try {
    // Consume in its own committed transaction. A provider outage or invalid code must
    // never roll this state back into a replayable value.
    await withOrganization(req, (client, org) => consumeOAuthState(client, {
      organizationId: org.id, actorId: req.auth.userId, state: req.query.state,
    }));
    const connection = await withOrganization(req, async (client, org) => {
      const result = await service.completeOAuth(client, {
        organizationId: org.id, actorId: req.auth.userId, state: req.query.state,
        code: req.query.code, stateAlreadyConsumed: true,
      });
      await auditLog(req, { action: 'instagram.connection.create', resourceType: 'instagram_connection', resourceId: result.id,
        newValue: result, organizationId: org.id, store: client });
      return result;
    });
    void connection;
    res.redirect(303, '/products?tab=instagram&instagram=connected');
  } catch (error) { next(error); }
});

router.post('/connections/:id/refresh', oauthLimit, async (req, res, next) => {
  try { res.json(await withOrganization(req, (client, org) => service.refreshConnection(client, { organizationId: org.id, connectionId: req.params.id }))); }
  catch (error) { next(error); }
});

router.patch('/connections/:id/defaults', async (req, res, next) => {
  try {
    const result = await withOrganization(req, async (client, org) => {
      const stock = Math.max(0, Math.min(Number(req.body.default_stock) || 5, 1000000));
      const updated = await client.query(
        `update instagram_connections set defaults=$1::jsonb,updated_at=now()
         where organization_id=$2 and id=$3 returning *`,
        [JSON.stringify({ default_stock: Math.trunc(stock), product_status: 'draft' }), org.id, req.params.id]
      );
      if (!updated.rows[0]) throw Object.assign(new Error('Instagram baglantisi bulunamadi'), { status: 404 });
      return service.connectionMetadata(updated.rows[0]);
    });
    res.json(result);
  } catch (error) { next(error); }
});

router.delete('/connections/:id', oauthLimit, async (req, res, next) => {
  try {
    const result = await withOrganization(req, async (client, org) => {
      const disconnected = await service.disconnect(client, { organizationId: org.id, connectionId: req.params.id });
      await auditLog(req, { action: 'instagram.connection.disconnect', resourceType: 'instagram_connection', resourceId: req.params.id,
        newValue: disconnected, organizationId: org.id, store: client });
      return disconnected;
    });
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/connections/:id/sync', syncLimit, async (req, res, next) => {
  try {
    const result = await withOrganization(req, async (client, org) => {
      const synced = await service.syncConnection(client, {
        organizationId: org.id, connectionId: req.params.id, mode: req.body.mode === 'full' ? 'full' : 'incremental',
        maxPages: req.body.max_pages,
      });
      await auditLog(req, { action: 'instagram.sync', resourceType: 'instagram_connection', resourceId: req.params.id,
        newValue: synced, organizationId: org.id, store: client });
      return synced;
    });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/media', async (req, res, next) => {
  try { res.json(await withOrganization(req, (client, org) => service.listMedia(client, org.id, req.query))); }
  catch (error) { next(error); }
});

router.post('/media/:id/analyze', analysisLimit, async (req, res, next) => {
  try {
    const draft = await withOrganization(req, (client, org) => service.queueAnalysis(client, {
      organizationId: org.id, mediaItemId: req.params.id, force: req.body.force === true,
    }));
    scheduleInstagramWorker();
    res.status(202).json(draft);
  } catch (error) { next(error); }
});

router.post('/media/analyze-bulk', analysisLimit, async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(Boolean))].slice(0, 50);
    const drafts = await withOrganization(req, async (client, org) => {
      const queued = [];
      for (const id of ids) queued.push(await service.queueAnalysis(client, { organizationId: org.id, mediaItemId: id, force: req.body.force === true }));
      return queued;
    });
    scheduleInstagramWorker();
    res.status(202).json(drafts);
  } catch (error) { next(error); }
});

router.get('/drafts/:id', async (req, res, next) => {
  try { res.json(await withOrganization(req, (client, org) => service.getDraft(client, org.id, req.params.id))); }
  catch (error) { next(error); }
});

router.patch('/drafts/:id', async (req, res, next) => {
  try { res.json(await withOrganization(req, (client, org) => service.updateDraft(client, {
    organizationId: org.id, draftId: req.params.id, actorId: req.auth.userId, patch: req.body,
  }))); } catch (error) { next(error); }
});

router.post('/drafts/:id/skip', async (req, res, next) => {
  try { await withOrganization(req, (client, org) => service.setDraftDisposition(client, { organizationId: org.id, draftId: req.params.id, disposition: 'skip' })); res.status(204).end(); }
  catch (error) { next(error); }
});

router.post('/drafts/skip-bulk', async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(Boolean))].slice(0, 50);
    await withOrganization(req, async (client, org) => {
      for (const id of ids) await service.setDraftDisposition(client, { organizationId: org.id, draftId: id, disposition: 'skip' });
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.delete('/drafts/:id', async (req, res, next) => {
  try { await withOrganization(req, (client, org) => service.setDraftDisposition(client, { organizationId: org.id, draftId: req.params.id, disposition: 'discard' })); res.status(204).end(); }
  catch (error) { next(error); }
});

router.post('/drafts/:id/apply', applyLimit, async (req, res, next) => {
  try {
    const product = await withOrganization(req, async (client, org) => {
      const applied = await service.applyDraft(client, { organization: org, draftId: req.params.id,
        actorId: req.auth.userId, idempotencyKey: req.get('idempotency-key') });
      await auditLog(req, { action: 'instagram.draft.apply', resourceType: 'product', resourceId: applied.id,
        newValue: { source: 'instagram_ai', draft_id: req.params.id }, organizationId: org.id, store: client });
      return applied;
    });
    res.status(product.idempotent ? 200 : 201).json(product);
  } catch (error) { next(error); }
});

router.post('/drafts/apply-bulk', applyLimit, async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(Boolean))].slice(0, 20);
    const products = await withOrganization(req, async (client, org) => {
      const output = [];
      for (const id of ids) output.push(await service.applyDraft(client, { organization: org, draftId: id,
        actorId: req.auth.userId, idempotencyKey: `instagram-bulk:${String(req.get('idempotency-key') || '')}:${id}` }));
      return output;
    });
    res.status(201).json(products);
  } catch (error) { next(error); }
});

module.exports = router;
