const express = require('express');
const db = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const customDomains = require('../services/customDomains');
const { domainProviderCapabilities } = require('../services/domainProviders');

const router = express.Router();

const opsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PLATFORM_WRITE_RATE_LIMIT || 120),
  message: 'Cok fazla alan adi islemi. Lutfen biraz sonra tekrar deneyin.',
});
router.use(requireSuperAdmin, opsLimiter);

// Deliberately NOT selected: verification_token_hash. A super-admin has no operational
// need for it, it cannot be turned back into the raw challenge anyway, and leaving it out
// means it can never leak through this surface.
const OVERVIEW_COLUMNS = `
  d.id, d.organization_id, d.hostname, d.status, d.verification_method,
  d.verification_record_name, d.verified_at, d.last_checked_at, d.last_error_code,
  d.is_canonical, d.redirect_to_canonical, d.ssl_status, d.ssl_checked_at,
  d.provider, d.released_at, d.created_at, d.updated_at,
  o.slug as organization_slug, o.name as organization_name
`;

function requireReason(body) {
  const reason = String(body?.reason || '').trim();
  if (reason.length < 5) {
    throw Object.assign(new Error('Gerekce zorunlu (en az 5 karakter)'), {
      status: 400, code: 'REASON_REQUIRED',
    });
  }
  return reason.slice(0, 500);
}

// Platform-wide domain overview. Cross-tenant reach exists only behind requireSuperAdmin,
// and runs on the system pool because it is legitimately cross-tenant.
router.get('/', async (req, res, next) => {
  try {
    const filters = [];
    const params = [];
    const push = (clause, value) => { params.push(value); filters.push(clause.replace('$?', `$${params.length}`)); };

    if (req.query.organizationId) push('d.organization_id = $?', String(req.query.organizationId));
    if (req.query.organizationSlug) push('o.slug = $?', String(req.query.organizationSlug));
    if (req.query.hostname) push('d.hostname ilike $?', `%${String(req.query.hostname).toLowerCase()}%`);
    if (req.query.status) push('d.status = $?', String(req.query.status));
    if (req.query.sslStatus) push('d.ssl_status = $?', String(req.query.sslStatus));
    if (req.query.provider) push('d.provider = $?', String(req.query.provider));
    if (req.query.canonical === 'true') filters.push('d.is_canonical');
    if (req.query.failed === 'true') filters.push("(d.status = 'failed' or d.last_error_code is not null)");

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
    const result = await db.getSystemPool().query(
      `select ${OVERVIEW_COLUMNS}
         from custom_domains d
         join organizations o on o.id = d.organization_id
        ${filters.length ? `where ${filters.join(' and ')}` : ''}
        order by d.updated_at desc, d.id desc
        limit ${limit}`,
      params
    );
    res.json({ items: result.rows, provider: domainProviderCapabilities() });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const pool = db.getSystemPool();
    const domain = await pool.query(
      `select ${OVERVIEW_COLUMNS}
         from custom_domains d
         join organizations o on o.id = d.organization_id
        where d.id = $1 limit 1`,
      [Number(req.params.id)]
    );
    if (!domain.rows[0]) return res.status(404).json({ error: 'Alan adi bulunamadi', code: 'DOMAIN_NOT_FOUND' });
    // History carries reasons and actors, never secrets.
    const history = await pool.query(
      `select event_type, actor_type, actor_user_id, reason, occurred_at
         from custom_domain_events
        where hostname = $1 order by occurred_at desc limit 50`,
      [domain.rows[0].hostname]
    );
    res.json({ domain: domain.rows[0], history: history.rows, provider: domainProviderCapabilities() });
  } catch (error) { next(error); }
});

// Force-disable. This stops the domain resolving and drops its canonical flag, but it
// deliberately does NOT release the hostname to anyone else and does NOT bypass ownership
// verification — there is no "force verify" here on purpose: a super-admin must never be
// able to hand a tenant a domain they cannot prove they own.
router.post('/:id/force-disable', async (req, res, next) => {
  const client = await db.getSystemPool().connect();
  try {
    const reason = requireReason(req.body);
    await client.query('begin');
    const existing = await client.query(
      'select id, organization_id, hostname, status from custom_domains where id = $1 for update',
      [Number(req.params.id)]
    );
    if (!existing.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Alan adi bulunamadi', code: 'DOMAIN_NOT_FOUND' });
    }
    const row = existing.rows[0];
    const domain = await customDomains.disableDomain(client, {
      organizationId: row.organization_id,
      domainId: row.id,
      reason,
      actorUserId: req.auth?.userId || null,
      actorType: 'super_admin',
    });
    await client.query('commit');
    await auditLog(req, {
      action: 'DOMAIN_FORCE_DISABLED', resourceType: 'custom_domain', resourceId: String(row.id),
      oldValue: { status: row.status },
      newValue: { hostname: row.hostname, status: domain.status, reason },
      organizationId: row.organization_id,
    });
    res.json({ domain });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// Re-reads the provider's view of the domain/certificate. With no configured provider this
// honestly reports not_configured rather than inventing an active certificate.
router.post('/:id/refresh-status', async (req, res, next) => {
  const client = await db.getSystemPool().connect();
  try {
    const reason = requireReason(req.body);
    const { getDomainProvider } = require('../services/domainProviders');
    const provider = getDomainProvider();
    await client.query('begin');
    const existing = await client.query(
      'select id, organization_id, hostname from custom_domains where id = $1 for update',
      [Number(req.params.id)]
    );
    if (!existing.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Alan adi bulunamadi', code: 'DOMAIN_NOT_FOUND' });
    }
    const certificate = await provider.getCertificateStatus({ domainId: existing.rows[0].id });
    const updated = await client.query(
      `update custom_domains set ssl_status = $2, ssl_checked_at = now(), updated_at = now()
        where id = $1 returning *`,
      [existing.rows[0].id, certificate.sslStatus]
    );
    await client.query('commit');
    await auditLog(req, {
      action: 'DOMAIN_STATUS_REFRESHED', resourceType: 'custom_domain',
      resourceId: String(existing.rows[0].id),
      newValue: { ssl_status: certificate.sslStatus, provider: provider.name, reason },
      organizationId: existing.rows[0].organization_id,
    });
    res.json({
      domain: customDomains.publicDomain(updated.rows[0]),
      provider: { name: provider.name, configured: provider.configured !== false },
    });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
