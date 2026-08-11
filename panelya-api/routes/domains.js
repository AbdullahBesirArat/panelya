const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/authSession');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const { rateLimit } = require('../middleware/security');
const domains = require('../services/customDomains');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

// Verification hits DNS, so it is throttled separately from ordinary reads: a tenant
// hammering verify must not turn into an outbound DNS amplifier.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.DOMAIN_VERIFY_RATE_LIMIT || 60),
  message: 'Cok fazla dogrulama denemesi. Lutfen biraz sonra tekrar deneyin.',
});

// Tenant-scoped transaction wrapper. Every handler runs with the tenant context set, so
// RLS is in force even for the super-admin role reaching a tenant's own endpoint.
function domainRoute(run, { status = 200 } = {}) {
  return async (req, res, next) => {
    const client = await db.pool.connect();
    try {
      const organization = await resolveOrganization(req);
      await client.query('begin');
      await db.setTenantContext(client, organization.id);
      const result = await run({ req, client, organization });
      await client.query('commit');
      return res.status(result?.statusOverride || status).json(result?.body ?? result);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  };
}

router.get('/', requireAuth, requireRole(READ_ROLES), domainRoute(async ({ client, organization }) => ({
  items: await domains.listDomains(client, { organizationId: organization.id }),
})));

// Adding returns the challenge exactly once. It is not stored and not logged, so a tenant
// that loses it re-issues rather than reading it back.
router.post('/', requireAuth, requireRole(WRITE_ROLES), domainRoute(async ({ req, client, organization }) => {
  const result = await domains.addDomain(client, {
    organizationId: organization.id,
    hostname: req.body?.hostname,
    actorUserId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'DOMAIN_CLAIMED', resourceType: 'custom_domain', resourceId: String(result.domain.id),
    newValue: { hostname: result.domain.hostname },
    organizationId: organization.id,
  });
  return { statusOverride: 201, body: result };
}));

router.post('/:id/challenge', requireAuth, requireRole(WRITE_ROLES), domainRoute(async ({ req, client, organization }) => {
  const result = await domains.reissueChallenge(client, {
    organizationId: organization.id, domainId: req.params.id, actorUserId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'DOMAIN_CHALLENGE_REISSUED', resourceType: 'custom_domain', resourceId: String(req.params.id),
    organizationId: organization.id,
  });
  return result;
}));

router.post('/:id/verify', requireAuth, requireRole(WRITE_ROLES), verifyLimiter, domainRoute(async ({ req, client, organization }) => {
  const result = await domains.verifyDomain(client, {
    organizationId: organization.id, domainId: req.params.id, actorUserId: req.auth?.userId || null,
  });
  if (result.verified && !result.unchanged) {
    await auditLog(req, {
      action: 'DOMAIN_VERIFIED', resourceType: 'custom_domain', resourceId: String(req.params.id),
      newValue: { hostname: result.domain.hostname },
      organizationId: organization.id,
    });
  }
  return result;
}));

// Activation is only reachable from a verified state; the service enforces that, so an
// unverified hostname can never begin resolving.
router.post('/:id/activate', requireAuth, requireRole(WRITE_ROLES), domainRoute(async ({ req, client, organization }) => {
  const { getDomainProvider } = require('../services/domainProviders');
  const provider = getDomainProvider();
  const attached = await provider.attachDomain({ organizationId: organization.id, domainId: req.params.id });
  const domain = await domains.activateDomain(client, {
    organizationId: organization.id, domainId: req.params.id,
    sslStatus: attached.sslStatus, actorUserId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'DOMAIN_ACTIVATED', resourceType: 'custom_domain', resourceId: String(req.params.id),
    newValue: { hostname: domain.hostname, ssl_status: domain.ssl_status, provider: provider.name },
    organizationId: organization.id,
  });
  return { domain, provider: { name: provider.name, configured: provider.configured !== false } };
}));

router.post('/:id/canonical', requireAuth, requireRole(WRITE_ROLES), domainRoute(async ({ req, client, organization }) => {
  const domain = await domains.setCanonical(client, {
    organizationId: organization.id, domainId: req.params.id, actorUserId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'DOMAIN_CANONICAL_SET', resourceType: 'custom_domain', resourceId: String(req.params.id),
    newValue: { hostname: domain.hostname }, organizationId: organization.id,
  });
  return { domain };
}));

router.post('/:id/disable', requireAuth, requireRole(WRITE_ROLES), domainRoute(async ({ req, client, organization }) => {
  const domain = await domains.disableDomain(client, {
    organizationId: organization.id, domainId: req.params.id,
    reason: req.body?.reason || '', actorUserId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'DOMAIN_DISABLED', resourceType: 'custom_domain', resourceId: String(req.params.id),
    newValue: { hostname: domain.hostname }, organizationId: organization.id,
  });
  return { domain };
}));

// Releasing frees the hostname for a future claim. Separate from disabling on purpose, so
// a hand-over is always a deliberate, audited act.
// A30: releasing a domain frees the hostname for anyone else to claim (A27), so it is a
// one-way door that needs recent proof of identity.
router.delete('/:id', requireAuth, requireRole(WRITE_ROLES), requireStepUp('domain_release'), domainRoute(async ({ req, client, organization }) => {
  const result = await domains.releaseDomain(client, {
    organizationId: organization.id, domainId: req.params.id,
    reason: req.body?.reason || '', actorUserId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'DOMAIN_RELEASED', resourceType: 'custom_domain', resourceId: String(req.params.id),
    newValue: { hostname: result.hostname }, organizationId: organization.id,
  });
  return result;
}));

module.exports = router;
