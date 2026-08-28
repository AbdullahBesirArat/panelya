const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const { rateLimit } = require('../middleware/security');
const themes = require('../modules/themes/service');
const { themeCssVariables, defaultThemeConfig } = require('../modules/themes/schema');
const { resolveStorefrontBaseUrl } = require('../services/tenantUrls');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
// Editing and publishing a storefront's appearance is an owner/admin action; a viewer or
// member may look but not change. The backend enforces this — hiding a button is not
// access control.
const EDIT_ROLES = ['super_admin', 'owner', 'admin'];
const PUBLISH_ROLES = ['super_admin', 'owner', 'admin'];

const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.THEME_PREVIEW_RATE_LIMIT || 120),
  message: 'Cok fazla onizleme istegi. Lutfen biraz sonra tekrar deneyin.',
});

function themeRoute(run, { status = 200 } = {}) {
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

// Current published theme (what the storefront is rendering right now).
router.get('/published', requireAuth, requireRole(READ_ROLES), themeRoute(async ({ client, organization }) => ({
  theme: await themes.resolvePublishedTheme(client, organization.id),
})));

router.get('/draft', requireAuth, requireRole(READ_ROLES), themeRoute(async ({ client, organization }) => ({
  draft: themes.publicVersion(await themes.loadDraft(client, organization.id)),
})));

router.get('/preview-origin', requireAuth, requireRole(READ_ROLES), themeRoute(async ({ client, organization }) => {
  const resolved = await resolveStorefrontBaseUrl(client, organization.id);
  return { origin: resolved.baseUrl || null, source: resolved.source };
}));

router.post('/draft', requireAuth, requireRole(EDIT_ROLES), themeRoute(async ({ req, client, organization }) => {
  const draft = await themes.createDraft(client, {
    organizationId: organization.id, actorId: req.auth?.userId || null,
  });
  await auditLog(req, {
    action: 'THEME_DRAFT_CREATED', resourceType: 'theme_version', resourceId: String(draft.id),
    organizationId: organization.id,
  });
  return { statusOverride: 201, body: { draft } };
}));

// Optimistic save: the client sends the hash it last saw as If-Match (or in the body).
router.put('/draft', requireAuth, requireRole(EDIT_ROLES), themeRoute(async ({ req, client, organization }) => {
  const expectedHash = String(req.get('if-match') || req.body?.expectedHash || '')
    .replace(/^W\//, '').replace(/"/g, '').trim() || null;
  const draft = await themes.saveDraft(client, {
    organizationId: organization.id, config: req.body?.config, expectedHash,
  });
  return { draft };
}));

// Read-only validation for the pre-publish check.
router.post('/validate', requireAuth, requireRole(READ_ROLES), themeRoute(async ({ req, client, organization }) => {
  const config = req.body?.config
    || (await themes.loadDraft(client, organization.id))?.config
    || defaultThemeConfig();
  return { report: themes.validateConfigReport(config) };
}));

router.post('/publish', requireAuth, requireRole(PUBLISH_ROLES), themeRoute(async ({ req, client, organization }) => {
  const expectedHash = String(req.get('if-match') || req.body?.expectedHash || '')
    .replace(/^W\//, '').replace(/"/g, '').trim() || null;
  const result = await themes.publishDraft(client, {
    organizationId: organization.id,
    actorId: req.auth?.userId || null,
    reason: req.body?.reason || '',
    expectedHash,
  });
  await auditLog(req, {
    action: 'THEME_PUBLISHED', resourceType: 'theme_version', resourceId: String(result.version.id),
    oldValue: { previous_version_id: result.previousVersionId },
    newValue: { version_number: result.version.version_number, hash: result.version.validation_hash },
    organizationId: organization.id,
  });
  return result;
}));

router.post('/rollback', requireAuth, requireRole(PUBLISH_ROLES), themeRoute(async ({ req, client, organization }) => {
  const result = await themes.rollbackToVersion(client, {
    organizationId: organization.id,
    versionId: req.body?.versionId,
    actorId: req.auth?.userId || null,
    reason: req.body?.reason || '',
  });
  await auditLog(req, {
    action: 'THEME_ROLLED_BACK', resourceType: 'theme_version', resourceId: String(result.version.id),
    newValue: { restored_from: result.restoredFrom, version_number: result.version.version_number },
    organizationId: organization.id,
  });
  return result;
}));

router.get('/versions', requireAuth, requireRole(READ_ROLES), themeRoute(async ({ req, client, organization }) => ({
  items: await themes.listVersions(client, { organizationId: organization.id, limit: req.query.limit }),
  publications: await themes.listPublications(client, { organizationId: organization.id, limit: req.query.limit }),
})));

router.get('/versions/:id', requireAuth, requireRole(READ_ROLES), themeRoute(async ({ req, client, organization }) => ({
  version: themes.publicVersion(await themes.loadVersion(client, organization.id, req.params.id)),
})));

// Issues a short-lived preview grant. The raw token is returned once, here, and is never
// stored or logged; only its sha256 is persisted.
router.post('/preview-token', requireAuth, requireRole(EDIT_ROLES), previewLimiter,
  themeRoute(async ({ req, client, organization }) => {
    const draft = req.body?.versionId
      ? await themes.loadVersion(client, organization.id, req.body.versionId)
      : await themes.loadDraft(client, organization.id);
    if (!draft) throw Object.assign(new Error('Onizlenecek surum yok'), { status: 404, code: 'THEME_DRAFT_NOT_FOUND' });
    const token = await themes.createPreviewToken(client, {
      organizationId: organization.id, versionId: draft.id, actorId: req.auth?.userId || null,
    });
    await auditLog(req, {
      action: 'THEME_PREVIEW_TOKEN_ISSUED', resourceType: 'theme_version', resourceId: String(draft.id),
      organizationId: organization.id,
    });
    return { statusOverride: 201, body: token };
  }));

module.exports = router;
module.exports.themeCssVariables = themeCssVariables;
