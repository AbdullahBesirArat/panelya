-- A28 (2/2): give every existing organization a published v1 theme.
--
-- Kept separate from 063 on purpose: 063 is structure, this is data. If the backfill ever
-- needs to be re-derived, it can be rolled back and re-applied without touching the tables.
--
-- The v1 config is the SCHEMA DEFAULT, not an invention: this platform had no versioned
-- theme before A28, so the defaults are exactly what every storefront was already
-- rendering (shared.css supplies these same values as its var() fallbacks). The one piece
-- of real legacy theme data — store_settings.custom_colors — is deliberately NOT mapped
-- here: it is an untyped free-form array with no documented meaning, and guessing which
-- entry is "primary" would silently change how a live store looks. It stays in
-- store_settings, and a tenant can adopt those colours explicitly in the editor.
--
-- Because the v1 config equals the current rendered defaults, no tenant's appearance
-- changes when this migration runs. The integration suite asserts exactly that.

-- The migrator role is deliberately not a member of panelya_rls_bypass, and both tables
-- are FORCE RLS, so a plain insert here is refused by the tenant policy. Unforcing RLS for
-- the table owner inside this transaction is the narrow, explicit way to seed rows for
-- every tenant; FORCE is restored below, before the transaction commits.
alter table theme_versions no force row level security;
alter table theme_publications no force row level security;

insert into theme_versions (
  organization_id, version_number, schema_version, config, status,
  validation_hash, validation_result, published_at
)
select
  o.id,
  1,
  1,
  jsonb_build_object(
    'schemaVersion', 1,
    'tokens', jsonb_build_object(
      'colors', jsonb_build_object(
        'background', '#f7f5f1', 'surface', '#ffffff', 'text', '#1a1a1a',
        'mutedText', '#4a4a4a', 'primary', '#3d6b38', 'primaryContrast', '#ffffff',
        'accent', '#b46a45', 'border', '#ddd7cd', 'success', '#2f7a3d',
        'warning', '#a8761b', 'danger', '#b3261e'
      ),
      'fonts', jsonb_build_object('heading', 'serif', 'body', 'sans'),
      'spacing', 16,
      'radius', 4,
      'container', jsonb_build_object('maxWidth', 1200, 'paddingX', 24)
    ),
    'header', jsonb_build_object(
      'logoMediaId', null, 'showSearch', true, 'showAccount', true,
      'showCart', true, 'sticky', true
    ),
    'footer', jsonb_build_object('text', '', 'showPaymentIcons', true, 'social', jsonb_build_object()),
    'announcement', jsonb_build_object('enabled', false, 'text', '', 'link', jsonb_build_object('type', 'none')),
    'sections', jsonb_build_array(
      jsonb_build_object('id', 'hero', 'type', 'hero', 'enabled', true, 'order', 0,
        'settings', jsonb_build_object('title', '', 'subtitle', '', 'mediaId', null,
          'ctaLabel', '', 'ctaTarget', jsonb_build_object('type', 'none'), 'alignment', 'center')),
      jsonb_build_object('id', 'featured', 'type', 'product-grid', 'enabled', true, 'order', 1,
        'settings', jsonb_build_object('title', '', 'source', jsonb_build_object('type', 'products'),
          'limit', 8, 'columns', 4, 'sort', 'recommended')),
      jsonb_build_object('id', 'trust', 'type', 'trust-features', 'enabled', true, 'order', 2,
        'settings', jsonb_build_object('title', '', 'items', jsonb_build_array()))
    ),
    'seo', jsonb_build_object('titleTemplate', '', 'defaultDescription', '', 'socialImageMediaId', null)
  ),
  'published',
  null,
  jsonb_build_object('source', 'a28_legacy_backfill', 'valid', true),
  now()
from organizations o
where not exists (
  select 1 from theme_versions tv where tv.organization_id = o.id
);

-- Record the backfill as a real publication so history is complete from day one rather
-- than starting with an unexplained live version.
insert into theme_publications (organization_id, theme_version_id, action, reason, published_at)
select tv.organization_id, tv.id, 'publish', 'A28 legacy backfill', tv.published_at
  from theme_versions tv
 where tv.version_number = 1
   and tv.status = 'published'
   and not exists (
     select 1 from theme_publications tp where tp.theme_version_id = tv.id
   );

alter table theme_versions force row level security;
alter table theme_publications force row level security;
