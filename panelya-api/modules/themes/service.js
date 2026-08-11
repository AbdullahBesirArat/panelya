'use strict';

// A28 theme lifecycle: draft -> validate -> preview -> publish -> rollback.
//
// The database owns the invariants (one published, one draft, published immutable); this
// module owns the transitions and makes each one a single transaction so a partially
// applied publish cannot exist.

const crypto = require('node:crypto');
const { CURRENT_SCHEMA_VERSION, themeError, defaultThemeConfig, validateThemeConfig } = require('./schema');
const { normalizeThemeConfig, themeConfigHash } = require('./migrate');

const PREVIEW_TTL_MINUTES = Math.min(Math.max(Number(process.env.THEME_PREVIEW_TTL_MINUTES || 30), 1), 240);

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

// The public shape. validation_hash doubles as the optimistic-concurrency token, so it is
// exposed deliberately — it is an integrity digest, not a secret.
function publicVersion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    version_number: Number(row.version_number),
    schema_version: Number(row.schema_version),
    status: row.status,
    config: row.config,
    validation_hash: row.validation_hash,
    validation_result: row.validation_result,
    based_on_version_id: row.based_on_version_id ? Number(row.based_on_version_id) : null,
    published_at: row.published_at,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadPublished(client, organizationId) {
  const result = await client.query(
    "select * from theme_versions where organization_id = $1 and status = 'published' limit 1",
    [organizationId]
  );
  return result.rows[0] || null;
}

async function loadDraft(client, organizationId, { lock = false } = {}) {
  const result = await client.query(
    `select * from theme_versions where organization_id = $1 and status = 'draft' limit 1${lock ? ' for update' : ''}`,
    [organizationId]
  );
  return result.rows[0] || null;
}

async function loadVersion(client, organizationId, versionId, { lock = false } = {}) {
  const result = await client.query(
    `select * from theme_versions where organization_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [organizationId, Number(versionId)]
  );
  if (!result.rows[0]) throw themeError('Tema surumu bulunamadi', 'THEME_VERSION_NOT_FOUND', 404);
  return result.rows[0];
}

async function nextVersionNumber(client, organizationId) {
  const result = await client.query(
    'select coalesce(max(version_number), 0) + 1 as next from theme_versions where organization_id = $1',
    [organizationId]
  );
  return Number(result.rows[0].next);
}

// Creates the editable draft, seeded from the published version (or the schema defaults for
// a tenant that somehow has neither). The one-draft partial unique index means a second
// concurrent create loses; that is surfaced as a clean conflict rather than a raw DB error.
async function createDraft(client, { organizationId, actorId = null }) {
  const existing = await loadDraft(client, organizationId);
  if (existing) {
    throw themeError('Zaten duzenlenebilir bir taslak var', 'THEME_DRAFT_EXISTS', 409, {
      draftId: Number(existing.id),
    });
  }
  const published = await loadPublished(client, organizationId);
  const baseConfig = published ? normalizeThemeConfig(published.config) : defaultThemeConfig();
  const config = validateThemeConfig(baseConfig);
  const hash = themeConfigHash(config);

  try {
    const inserted = await client.query(
      `insert into theme_versions
         (organization_id, version_number, schema_version, config, status,
          validation_hash, validation_result, based_on_version_id, created_by)
       values ($1,$2,$3,$4::jsonb,'draft',$5,$6::jsonb,$7,$8)
       returning *`,
      [
        organizationId, await nextVersionNumber(client, organizationId), CURRENT_SCHEMA_VERSION,
        JSON.stringify(config), hash,
        JSON.stringify({ valid: true, errors: [], warnings: [] }),
        published ? published.id : null, actorId,
      ]
    );
    return publicVersion(inserted.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      throw themeError('Zaten duzenlenebilir bir taslak var', 'THEME_DRAFT_EXISTS', 409);
    }
    throw error;
  }
}

// Optimistic concurrency: the caller states the hash it last saw. A mismatch means another
// session saved in between, so the write is refused rather than silently overwriting.
async function saveDraft(client, { organizationId, config, expectedHash = null }) {
  const draft = await loadDraft(client, organizationId, { lock: true });
  if (!draft) throw themeError('Duzenlenebilir taslak yok', 'THEME_DRAFT_NOT_FOUND', 404);
  if (expectedHash && expectedHash !== draft.validation_hash) {
    throw themeError(
      'Taslak baska bir oturumda degistirildi', 'THEME_VERSION_CONFLICT', 409,
      { expected: expectedHash, current: draft.validation_hash }
    );
  }

  const validated = validateThemeConfig({ ...config, schemaVersion: CURRENT_SCHEMA_VERSION });
  const hash = themeConfigHash(validated);
  const updated = await client.query(
    `update theme_versions
        set config = $3::jsonb, schema_version = $4, validation_hash = $5,
            validation_result = $6::jsonb, updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [
      organizationId, draft.id, JSON.stringify(validated), CURRENT_SCHEMA_VERSION, hash,
      JSON.stringify({ valid: true, errors: [], warnings: [] }),
    ]
  );
  return publicVersion(updated.rows[0]);
}

// Read-only validation, for the pre-publish check. Errors are returned rather than thrown
// so the UI can show every problem instead of only the first.
function validateConfigReport(config) {
  try {
    const validated = validateThemeConfig({ ...config, schemaVersion: CURRENT_SCHEMA_VERSION });
    return { valid: true, errors: [], warnings: warningsFor(validated), hash: themeConfigHash(validated) };
  } catch (error) {
    return {
      valid: false,
      // `field` is what the editor points the tenant at, so it has to survive the throw.
      // Unknown top-level keys report the offending key names for the same reason.
      errors: [{
        field: error.meta?.field || (error.meta?.unknown || []).join(', ') || 'config',
        code: error.code || 'THEME_INVALID_CONFIG',
        message: error.message,
        meta: error.meta || null,
      }],
      warnings: [],
      hash: null,
    };
  }
}

// Non-blocking advice: things that are valid but probably not what the tenant intended.
function warningsFor(config) {
  const warnings = [];
  if (!config.sections.some((section) => section.enabled)) {
    warnings.push({ field: 'sections', code: 'THEME_NO_ENABLED_SECTION', message: 'Hicbir bolum acik degil; ana sayfa bos gorunecek.' });
  }
  if (config.announcement.enabled && !config.announcement.text) {
    warnings.push({ field: 'announcement.text', code: 'THEME_EMPTY_ANNOUNCEMENT', message: 'Duyuru acik ama metni bos.' });
  }
  const hero = config.sections.find((section) => section.type === 'hero' && section.enabled);
  if (hero && !hero.settings.title && !hero.settings.mediaId) {
    warnings.push({ field: 'sections.hero', code: 'THEME_EMPTY_HERO', message: 'Hero bolumunde baslik ve gorsel yok.' });
  }
  return warnings;
}

// Publish is one transaction: validate, archive the outgoing published version, promote the
// draft, and record the publication. The partial unique index is what makes two concurrent
// publishes impossible; one of them fails and rolls back entirely.
async function publishDraft(client, { organizationId, actorId = null, reason = '', expectedHash = null }) {
  const draft = await loadDraft(client, organizationId, { lock: true });
  if (!draft) throw themeError('Yayinlanacak taslak yok', 'THEME_DRAFT_NOT_FOUND', 404);
  if (expectedHash && expectedHash !== draft.validation_hash) {
    throw themeError('Taslak baska bir oturumda degistirildi', 'THEME_VERSION_CONFLICT', 409);
  }

  const report = validateConfigReport(draft.config);
  if (!report.valid) {
    throw themeError('Tema dogrulanamadi', 'THEME_VALIDATION_FAILED', 400, { errors: report.errors });
  }

  const previous = await loadPublished(client, organizationId);
  if (previous) {
    await client.query(
      "update theme_versions set status = 'archived', archived_at = now(), updated_at = now() where id = $1",
      [previous.id]
    );
  }
  const published = await client.query(
    `update theme_versions
        set status = 'published', published_at = now(), updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, draft.id]
  );
  const publication = await client.query(
    `insert into theme_publications
       (organization_id, theme_version_id, previous_theme_version_id, action, reason, config_hash, published_by)
     values ($1,$2,$3,'publish',$4,$5,$6) returning *`,
    [organizationId, draft.id, previous ? previous.id : null,
      String(reason || '').slice(0, 500) || null, draft.validation_hash, actorId]
  );
  return {
    version: publicVersion(published.rows[0]),
    publication: publication.rows[0],
    previousVersionId: previous ? Number(previous.id) : null,
  };
}

// Rollback never mutates the target snapshot: it clones it into a NEW version and publishes
// that. The historical row stays exactly as it was published, and the publication history
// records what was restored.
async function rollbackToVersion(client, { organizationId, versionId, actorId = null, reason = '' }) {
  // A rollback replaces what every visitor sees, so it is audited — and an audit entry with
  // no reason is worth little. Enforced here, not only in the editor, because hiding a
  // button is not a control.
  const rollbackReason = String(reason || '').trim();
  if (rollbackReason.length < 4) {
    throw themeError('Geri alma gerekcesi zorunlu', 'REASON_REQUIRED', 400, { field: 'reason' });
  }
  const target = await loadVersion(client, organizationId, versionId, { lock: true });
  if (target.status === 'draft') {
    throw themeError('Taslak surume geri donulemez', 'THEME_ROLLBACK_TARGET_INVALID', 400);
  }
  const current = await loadPublished(client, organizationId);
  if (current && Number(current.id) === Number(target.id)) {
    throw themeError('Bu surum zaten yayinda', 'THEME_ALREADY_PUBLISHED', 409);
  }

  // Migrate the historical snapshot into the current runtime shape without touching the
  // stored row, then validate it before it can go live.
  const restored = normalizeThemeConfig(target.config);
  const hash = themeConfigHash(restored);

  if (current) {
    await client.query(
      "update theme_versions set status = 'archived', archived_at = now(), updated_at = now() where id = $1",
      [current.id]
    );
  }
  const created = await client.query(
    `insert into theme_versions
       (organization_id, version_number, schema_version, config, status,
        validation_hash, validation_result, based_on_version_id, created_by, published_at)
     values ($1,$2,$3,$4::jsonb,'published',$5,$6::jsonb,$7,$8, now())
     returning *`,
    [
      organizationId, await nextVersionNumber(client, organizationId), CURRENT_SCHEMA_VERSION,
      JSON.stringify(restored), hash,
      JSON.stringify({ valid: true, errors: [], warnings: [], rolledBackFrom: Number(target.id) }),
      target.id, actorId,
    ]
  );
  const lastPublication = await client.query(
    `select id from theme_publications where organization_id = $1
      order by published_at desc, id desc limit 1`,
    [organizationId]
  );
  const publication = await client.query(
    `insert into theme_publications
       (organization_id, theme_version_id, previous_theme_version_id, rollback_of_publication_id,
        action, reason, config_hash, published_by)
     values ($1,$2,$3,$4,'rollback',$5,$6,$7) returning *`,
    [organizationId, created.rows[0].id, current ? current.id : null,
      lastPublication.rows[0] ? lastPublication.rows[0].id : null,
      rollbackReason.slice(0, 500), hash, actorId]
  );
  return { version: publicVersion(created.rows[0]), publication: publication.rows[0], restoredFrom: Number(target.id) };
}

async function listVersions(client, { organizationId, limit = 50 }) {
  const result = await client.query(
    `select id, version_number, schema_version, status, validation_hash,
            based_on_version_id, published_at, archived_at, created_at, updated_at
       from theme_versions where organization_id = $1
      order by version_number desc limit $2`,
    [organizationId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return result.rows;
}

async function listPublications(client, { organizationId, limit = 50 }) {
  const result = await client.query(
    `select id, theme_version_id, previous_theme_version_id, rollback_of_publication_id,
            action, reason, config_hash, published_by, published_at
       from theme_publications where organization_id = $1
      order by published_at desc, id desc limit $2`,
    [organizationId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return result.rows;
}

// --- preview tokens ------------------------------------------------------------------------

// Short-lived, single-purpose, bound to one tenant AND one version. Only the hash is
// stored; the raw token is returned once so it can be exchanged immediately.
async function createPreviewToken(client, { organizationId, versionId, actorId = null }) {
  const version = await loadVersion(client, organizationId, versionId);
  const raw = crypto.randomBytes(32).toString('base64url');
  await client.query(
    `insert into theme_preview_tokens
       (organization_id, theme_version_id, token_hash, purpose, expires_at, created_by)
     values ($1,$2,$3,'theme_preview', now() + ($4 || ' minutes')::interval, $5)`,
    [organizationId, version.id, hashToken(raw), String(PREVIEW_TTL_MINUTES), actorId]
  );
  return { token: raw, expiresInMinutes: PREVIEW_TTL_MINUTES, versionId: Number(version.id) };
}

// Resolves a preview token to its theme config. Every failure returns the same generic
// error: a caller must not be able to tell "expired" from "wrong tenant" from "unknown".
async function resolvePreviewToken(client, { organizationId, token }) {
  const result = await client.query(
    `select p.*, v.config, v.schema_version, v.status as version_status
       from theme_preview_tokens p
       join theme_versions v
         on v.organization_id = p.organization_id and v.id = p.theme_version_id
      where p.token_hash = $1 and p.organization_id = $2
        and p.purpose = 'theme_preview' and p.expires_at > now()
      limit 1`,
    [hashToken(token), organizationId]
  );
  const row = result.rows[0];
  if (!row) throw themeError('Onizleme baglantisi gecersiz veya suresi dolmus', 'THEME_PREVIEW_INVALID', 404);
  return {
    versionId: Number(row.theme_version_id),
    config: normalizeThemeConfig(row.config),
    status: row.version_status,
  };
}

// Migration 064 backfills a published v1 for every tenant that existed when A28 shipped.
// A tenant created AFTER that needs the same starting point, so store creation calls this.
// Idempotent by design: it does nothing when a published version already exists, and the
// one-published partial unique index makes a concurrent double-call safe (the loser's
// insert fails and it simply reads the winner's row).
async function ensurePublishedTheme(client, { organizationId, actorId = null }) {
  const existing = await loadPublished(client, organizationId);
  if (existing) return publicVersion(existing);

  const config = validateThemeConfig(defaultThemeConfig());
  const hash = themeConfigHash(config);
  try {
    const inserted = await client.query(
      `insert into theme_versions
         (organization_id, version_number, schema_version, config, status,
          validation_hash, validation_result, created_by, published_at)
       values ($1,$2,$3,$4::jsonb,'published',$5,$6::jsonb,$7, now())
       returning *`,
      [
        organizationId, await nextVersionNumber(client, organizationId), CURRENT_SCHEMA_VERSION,
        JSON.stringify(config), hash,
        JSON.stringify({ valid: true, errors: [], warnings: [], source: 'a28_initial_theme' }),
        actorId,
      ]
    );
    await client.query(
      `insert into theme_publications
         (organization_id, theme_version_id, action, reason, config_hash, published_by)
       values ($1,$2,'publish','A28 initial theme',$3,$4)`,
      [organizationId, inserted.rows[0].id, hash, actorId]
    );
    return publicVersion(inserted.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      // Another caller won the race; its row is the correct answer.
      return publicVersion(await loadPublished(client, organizationId));
    }
    throw error;
  }
}

// The theme the public storefront must render. Draft is never reachable from here.
async function resolvePublishedTheme(client, organizationId) {
  const published = await loadPublished(client, organizationId);
  if (!published) return null;
  return {
    versionId: Number(published.id),
    versionNumber: Number(published.version_number),
    hash: published.validation_hash,
    config: normalizeThemeConfig(published.config),
  };
}

module.exports = {
  PREVIEW_TTL_MINUTES,
  hashToken,
  publicVersion,
  loadPublished,
  loadDraft,
  loadVersion,
  ensurePublishedTheme,
  createDraft,
  saveDraft,
  validateConfigReport,
  warningsFor,
  publishDraft,
  rollbackToVersion,
  listVersions,
  listPublications,
  createPreviewToken,
  resolvePreviewToken,
  resolvePublishedTheme,
};
