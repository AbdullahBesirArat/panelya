const express = require('express');
const db = require('../db');
const { resolveOrganization } = require('../services/tenant');
const { rateLimit } = require('../middleware/security');
const themes = require('../modules/themes/service');
const { themeCssVariables } = require('../modules/themes/schema');
const { renderThemeCss } = require('../modules/themes/css');

const router = express.Router();

const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.THEME_PREVIEW_RATE_LIMIT || 120),
  message: 'Cok fazla onizleme istegi. Lutfen biraz sonra tekrar deneyin.',
});

// Resolves the storefront's media URLs for the ids the theme references, so the client
// never sees (or supplies) a raw URL.
async function resolveMedia(client, organizationId, config) {
  const ids = new Set();
  const collect = (value) => { if (value) ids.add(value); };
  collect(config.header.logoMediaId);
  collect(config.seo.socialImageMediaId);
  for (const section of config.sections) {
    collect(section.settings.mediaId);
    collect(section.settings.mobileMediaId);
    for (const slide of section.settings.slides || []) {
      collect(slide.mediaId);
      collect(slide.mobileMediaId);
    }
    for (const block of section.settings.blocks || []) collect(block.mediaId);
  }
  if (!ids.size) return {};
  const result = await client.query(
    "select id, url from upload_assets where organization_id = $1 and id = any($2::uuid[]) and status <> 'deleted'",
    [organizationId, [...ids]]
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.url]));
}

function themePayload(theme, media) {
  return {
    version_id: theme.versionId,
    version_number: theme.versionNumber ?? null,
    hash: theme.hash ?? null,
    schema_version: theme.config.schemaVersion,
    tokens: theme.config.tokens,
    // Server-rendered CSS custom properties. Every value came out of a validator that makes
    // ';', '{', '}' and 'url(' impossible, so this list cannot carry a CSS injection.
    css_variables: themeCssVariables(theme.config),
    header: theme.config.header,
    footer: theme.config.footer,
    announcement: theme.config.announcement,
    sections: theme.config.sections.filter((section) => section.enabled),
    seo: theme.config.seo,
    media,
  };
}

// Public: the PUBLISHED theme only. A draft is unreachable from this route by construction —
// resolvePublishedTheme filters on status = 'published'.
router.get('/', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const theme = await themes.resolvePublishedTheme(client, organization.id);
    if (!theme) {
      await client.query('commit');
      return res.json({ theme: null });
    }
    const media = await resolveMedia(client, organization.id, theme.config);
    await client.query('commit');
    // Cached per tenant AND per published version hash, so a publish naturally invalidates
    // it and one tenant's theme can never be served to another.
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('ETag', `"${organization.id}:${theme.hash || theme.versionId}"`);
    res.setHeader('Vary', 'X-Organization-Slug, X-Forwarded-Host');
    return res.json({ theme: themePayload(theme, media) });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

// The published stylesheet. This is how a theme reaches the page under
// `style-src 'self'` + `style-src-attr 'none'`: a real same-origin CSS file, never an
// inline style or an injected <style> block.
router.get('/theme.css', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const theme = await themes.resolvePublishedTheme(client, organization.id);
    await client.query('commit');

    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!theme) {
      // No published theme: emit nothing rather than a broken sheet, so the storefront
      // keeps its existing static appearance.
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.send('/* no published theme */\n');
    }
    // Cached per tenant AND per published version hash, so a publish or rollback changes
    // the ETag and one tenant's stylesheet can never be served to another.
    const etag = `"${organization.id}:${theme.hash || theme.versionId}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'X-Organization-Slug, X-Forwarded-Host');
    res.setHeader('Cache-Control', 'public, max-age=60');
    if (req.get('if-none-match') === etag) return res.status(304).end();
    return res.send(renderThemeCss(theme.config));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

// The DRAFT stylesheet. It has to be a GET so a plain <link rel="stylesheet"> can load it
// under `style-src 'self'` — a POST response cannot become a stylesheet without an inline
// <style>, which the CSP forbids. The token therefore does NOT travel in the URL: the
// storefront proxy exchanges it for an HttpOnly, host-only session cookie and replays it
// here as a header, so it never reaches a URL, a referrer, or an access log.
router.get('/preview.css', previewLimiter, async (req, res, next) => {
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
    const preview = await themes.resolvePreviewToken(client, { organizationId: organization.id, token });
    await client.query('commit');
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A draft stylesheet must never be cached or shared.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.send(renderThemeCss(preview.config));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

// Preview: exchanges a short-lived token for a DRAFT theme. Deliberately a separate route
// so the public path above can never be coaxed into serving a draft.
router.post('/preview', previewLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const token = String(req.body?.token || '').trim();
    if (!token) {
      await client.query('rollback');
      return res.status(400).json({ error: 'Onizleme anahtari zorunlu', code: 'THEME_PREVIEW_TOKEN_REQUIRED' });
    }
    // The token is bound to one tenant and one version; a token from another tenant simply
    // does not match here, and every failure mode returns the same generic error.
    const preview = await themes.resolvePreviewToken(client, { organizationId: organization.id, token });
    const media = await resolveMedia(client, organization.id, preview.config);
    await client.query('commit');

    // A draft must never be cached, indexed, or leaked through a referrer.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.json({
      theme: themePayload({ versionId: preview.versionId, config: preview.config }, media),
      preview: true,
      // The storefront proxy moves this into an HttpOnly session cookie and deletes it from
      // the body, exactly as it does for the guest-cart token. It is echoed only after the
      // token has already proved valid for this tenant, so this leaks nothing new.
      preview_session_token: token,
    });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.resolveMedia = resolveMedia;
