'use strict';

// A29 tenant admin routes for API keys and webhooks.
//
// These sit on the internal, session-authenticated API and use the SAME canonical service
// as /v1, so a key created from the dashboard and one created over the API are identical in
// every respect that matters.
//
// Managing integration credentials is an owner/admin action. A member or viewer may not see
// a prefix list and may certainly not mint a credential, and that is enforced here rather
// than by hiding a button.

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/authSession');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const { rateLimit } = require('../middleware/security');
const service = require('../modules/integrations/service');
const outbox = require('../modules/integrations/outbox');
const { SCOPES, SCOPE_LABELS } = require('../modules/integrations/scopes');
const { EVENT_TYPES } = require('../modules/integrations/events');

const router = express.Router();

const MANAGE_ROLES = ['super_admin', 'owner', 'admin'];
const READ_ROLES = ['super_admin', 'owner', 'admin'];

// Minting credentials and sending test deliveries are both things worth limiting, the
// second because it makes the platform issue an outbound request on demand.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.INTEGRATION_WRITE_RATE_LIMIT || 120),
  message: 'Cok fazla entegrasyon istegi. Lutfen biraz sonra tekrar deneyin.',
});

function integrationRoute(run, { status = 200 } = {}) {
  return async (req, res, next) => {
    const client = await db.pool.connect();
    try {
      const organization = await resolveOrganization(req);
      await client.query('begin');
      await db.setTenantContext(client, organization.id);
      const result = await run({ req, res, client, organization });
      await client.query('commit');
      if (res.headersSent) return undefined;
      return res.status(result?.statusOverride || status).json(result?.body ?? result);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  };
}

// The catalogue the admin UI renders. Served rather than duplicated in the frontend, so the
// options a tenant sees are always the ones the backend will accept.
router.get('/meta', requireAuth, requireRole(READ_ROLES), (req, res) => res.json({
  scopes: SCOPES.map((scope) => ({ value: scope, label: SCOPE_LABELS[scope] || scope })),
  events: EVENT_TYPES.filter((eventType) => eventType !== 'webhook.test'),
}));

// ---------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------

router.get('/api-keys', requireAuth, requireRole(READ_ROLES), integrationRoute(async ({ client, organization }) => ({
  items: await service.listApiKeys(client, { organizationId: organization.id }),
})));

// A30: this response contains a secret in cleartext, exactly once. That makes it a
// credential-issuing operation and therefore step-up gated. The gate runs BEFORE the
// handler, so a refused attempt never mints a key that nobody received.
router.post('/api-keys', requireAuth, requireRole(MANAGE_ROLES), writeLimiter, requireStepUp('integration_secret'),
  integrationRoute(async ({ req, res, client, organization }) => {
    const created = await service.createApiKey(client, {
      organizationId: organization.id,
      name: req.body?.name,
      scopes: req.body?.scopes,
      ipAllowlist: req.body?.ipAllowlist,
      expiresAt: req.body?.expiresAt,
      actorId: req.auth?.userId || null,
    });
    await auditLog(req, {
      action: 'API_KEY_CREATED',
      resourceType: 'api_key',
      resourceId: String(created.key.id),
      // The prefix identifies the key in an audit trail; the secret is never written here.
      newValue: { prefix: created.key.prefix, scopes: created.key.scopes },
      organizationId: organization.id,
    });
    res.set('Cache-Control', 'no-store');
    return { statusOverride: 201, body: { key: created.key, token: created.token } };
  }));

router.post('/api-keys/:id/rotate', requireAuth, requireRole(MANAGE_ROLES), writeLimiter, requireStepUp('integration_secret'),
  integrationRoute(async ({ req, res, client, organization }) => {
    const rotated = await service.rotateApiKey(client, {
      organizationId: organization.id,
      keyId: Number(req.params.id),
      overlapMinutes: req.body?.overlapMinutes,
      actorId: req.auth?.userId || null,
    });
    await auditLog(req, {
      action: 'API_KEY_ROTATED',
      resourceType: 'api_key',
      resourceId: String(rotated.key.id),
      oldValue: { prefix: rotated.previous.prefix, overlap_until: rotated.previous.overlap_until },
      newValue: { prefix: rotated.key.prefix },
      organizationId: organization.id,
    });
    res.set('Cache-Control', 'no-store');
    return {
      key: rotated.key,
      token: rotated.token,
      previous: rotated.previous,
      overlapMinutes: rotated.overlapMinutes,
    };
  }));

router.post('/api-keys/:id/revoke', requireAuth, requireRole(MANAGE_ROLES), writeLimiter,
  integrationRoute(async ({ req, client, organization }) => {
    const revoked = await service.revokeApiKey(client, {
      organizationId: organization.id,
      keyId: Number(req.params.id),
      actorId: req.auth?.userId || null,
    });
    if (!revoked.alreadyRevoked) {
      await auditLog(req, {
        action: 'API_KEY_REVOKED',
        resourceType: 'api_key',
        resourceId: String(revoked.key.id),
        newValue: { prefix: revoked.key.prefix },
        organizationId: organization.id,
      });
    }
    return { key: revoked.key };
  }));

// ---------------------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------------------

router.get('/webhooks', requireAuth, requireRole(READ_ROLES), integrationRoute(async ({ client, organization }) => ({
  items: await service.listWebhookEndpoints(client, { organizationId: organization.id }),
})));

router.post('/webhooks', requireAuth, requireRole(MANAGE_ROLES), writeLimiter, requireStepUp('integration_secret'),
  integrationRoute(async ({ req, res, client, organization }) => {
    const created = await service.createWebhookEndpoint(client, {
      organizationId: organization.id,
      name: req.body?.name,
      url: req.body?.url,
      events: req.body?.events,
      actorId: req.auth?.userId || null,
    });
    await auditLog(req, {
      action: 'WEBHOOK_CREATED',
      resourceType: 'webhook_endpoint',
      resourceId: String(created.endpoint.id),
      newValue: { url: created.endpoint.url, events: created.endpoint.events },
      organizationId: organization.id,
    });
    res.set('Cache-Control', 'no-store');
    return { statusOverride: 201, body: { endpoint: created.endpoint, secret: created.secret } };
  }));

router.put('/webhooks/:id', requireAuth, requireRole(MANAGE_ROLES),
  integrationRoute(async ({ req, client, organization }) => {
    const updated = await service.updateWebhookEndpoint(client, {
      organizationId: organization.id,
      endpointId: Number(req.params.id),
      name: req.body?.name,
      url: req.body?.url,
      events: req.body?.events,
    });
    await auditLog(req, {
      action: 'WEBHOOK_UPDATED',
      resourceType: 'webhook_endpoint',
      resourceId: String(updated.id),
      newValue: { url: updated.url, events: updated.events },
      organizationId: organization.id,
    });
    return { endpoint: updated };
  }));

router.post('/webhooks/:id/status', requireAuth, requireRole(MANAGE_ROLES),
  integrationRoute(async ({ req, client, organization }) => {
    const status = String(req.body?.status || '');
    const endpoint = await service.setEndpointStatus(client, {
      organizationId: organization.id,
      endpointId: Number(req.params.id),
      status,
      reason: req.body?.reason,
    });
    await auditLog(req, {
      action: status === 'active' ? 'WEBHOOK_ENABLED' : 'WEBHOOK_DISABLED',
      resourceType: 'webhook_endpoint',
      resourceId: String(endpoint.id),
      newValue: { status: endpoint.status },
      organizationId: organization.id,
    });
    return { endpoint };
  }));

router.post('/webhooks/:id/rotate-secret', requireAuth, requireRole(MANAGE_ROLES), writeLimiter, requireStepUp('integration_secret'),
  integrationRoute(async ({ req, res, client, organization }) => {
    const rotated = await service.rotateWebhookSecret(client, {
      organizationId: organization.id,
      endpointId: Number(req.params.id),
    });
    await auditLog(req, {
      action: 'WEBHOOK_SECRET_ROTATED',
      resourceType: 'webhook_endpoint',
      resourceId: String(req.params.id),
      newValue: { secret_version: rotated.version },
      organizationId: organization.id,
    });
    res.set('Cache-Control', 'no-store');
    return { secret: rotated.secret, version: rotated.version };
  }));

/**
 * "Send a test". It enqueues a real delivery for a real (test-typed) event rather than
 * making an HTTP call from this handler: the point of a test is to exercise the actual
 * signing, SSRF and retry path, and a direct call from a request handler would exercise
 * none of it.
 */
router.post('/webhooks/:id/test', requireAuth, requireRole(MANAGE_ROLES), writeLimiter,
  integrationRoute(async ({ req, client, organization }) => {
    const enqueued = await outbox.enqueueTestDelivery(client, {
      organizationId: organization.id,
      endpointId: Number(req.params.id),
    });
    await auditLog(req, {
      action: 'WEBHOOK_TEST_SENT',
      resourceType: 'webhook_endpoint',
      resourceId: String(req.params.id),
      newValue: { delivery_id: Number(enqueued.delivery.id) },
      organizationId: organization.id,
    });
    return { statusOverride: 202, body: { delivery: service.publicDelivery(enqueued.delivery) } };
  }));

// ---------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------

router.get('/deliveries', requireAuth, requireRole(READ_ROLES), integrationRoute(async ({ req, client, organization }) => ({
  items: await service.listDeliveries(client, {
    organizationId: organization.id,
    endpointId: req.query.endpointId ? Number(req.query.endpointId) : null,
    status: req.query.status ? String(req.query.status) : null,
    limit: req.query.limit,
  }),
})));

router.post('/deliveries/:id/retry', requireAuth, requireRole(MANAGE_ROLES),
  integrationRoute(async ({ req, client, organization }) => {
    const delivery = await service.retryDelivery(client, {
      organizationId: organization.id,
      deliveryId: Number(req.params.id),
    });
    await auditLog(req, {
      action: 'WEBHOOK_DELIVERY_RETRIED',
      resourceType: 'webhook_delivery',
      resourceId: String(delivery.id),
      newValue: { attempt: delivery.attempt, reason: String(req.body?.reason || '').slice(0, 200) },
      organizationId: organization.id,
    });
    return { delivery };
  }));

module.exports = router;
