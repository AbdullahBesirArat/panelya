'use strict';

// A28 canonical theme schema.
//
// This module is the security boundary of the whole theme feature. A tenant supplies theme
// settings; those settings end up as CSS custom properties and as text on a public page.
// So the rule here is: NOTHING is passed through. Every value is parsed into a closed set
// of shapes (enums, bounded numbers, canonical hex colours, media ids, internal links) and
// anything that does not fit is rejected, never sanitised-and-kept.
//
// Deliberately absent, and deliberately not addable later without revisiting this comment:
// customHtml, customJs, rawCss, script, style, className, href. There is no field in this
// schema whose value reaches the page as markup or as a stylesheet fragment.

const CURRENT_SCHEMA_VERSION = 2;

function themeError(message, code, status = 400, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

// --- primitive validators --------------------------------------------------------------

// Canonical 6-digit lowercase hex. Nothing else is accepted: not rgb(), not hsl(), not
// named colours, and above all not anything that could carry a CSS function call. A colour
// is written into `--token: VALUE;`, so the value must be incapable of closing that
// declaration or opening a new one.
const HEX_COLOR = /^#[0-9a-f]{6}$/;

function parseColor(value, field) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  const expanded = /^#[0-9a-f]{3}$/.test(raw)
    ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
    : raw;
  if (!HEX_COLOR.test(expanded)) {
    throw themeError(`Renk degeri gecersiz: ${field}`, 'THEME_INVALID_COLOR', 400, { field, value: raw.slice(0, 40) });
  }
  return expanded;
}

// Fonts are chosen from a server-owned allowlist, never supplied as a family string. A
// free-text family would let a tenant write `x; } body { background: url(...)` or pull a
// remote font, so the tenant only ever picks a key and the server owns the CSS stack.
const FONT_STACKS = Object.freeze({
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "'Jost', system-ui, -apple-system, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
});
const FONT_KEYS = Object.freeze(Object.keys(FONT_STACKS));

function parseFont(value, field) {
  const key = String(value == null ? '' : value).trim();
  if (!FONT_KEYS.includes(key)) {
    throw themeError(`Yazi tipi gecersiz: ${field}`, 'THEME_INVALID_FONT', 400, { field, allowed: FONT_KEYS });
  }
  return key;
}

function parseIntInRange(value, { field, min, max, fallback }) {
  if (value == null || value === '') {
    if (fallback != null) return fallback;
    throw themeError(`Deger zorunlu: ${field}`, 'THEME_VALUE_REQUIRED', 400, { field });
  }
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw themeError(`Deger araligi disinda: ${field}`, 'THEME_VALUE_OUT_OF_RANGE', 400, { field, min, max });
  }
  return number;
}

function parseEnum(value, allowed, field) {
  const key = String(value == null ? '' : value).trim();
  if (!allowed.includes(key)) {
    throw themeError(`Deger gecersiz: ${field}`, 'THEME_INVALID_ENUM', 400, { field, allowed });
  }
  return key;
}

function parseBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

// Plain text only. Control characters and angle brackets are removed rather than escaped:
// the storefront renders these with textContent, and stripping here means even a renderer
// mistake downstream cannot produce markup from theme content.
function parseText(value, { field, max, required = false }) {
  const raw = String(value == null ? '' : value);
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    if (char === '<' || char === '>') continue;
    out += char;
  }
  out = out.replace(/\s+/g, ' ').trim().slice(0, max);
  if (required && !out) {
    throw themeError(`Metin zorunlu: ${field}`, 'THEME_TEXT_REQUIRED', 400, { field });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Images are referenced by media id only. A raw URL would be an open door to
// javascript:/data:/file: and to third-party requests the CSP is meant to prevent; the
// server resolves an id to a URL it already trusts.
function parseMediaId(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw themeError(`Gorsel zorunlu: ${field}`, 'THEME_MEDIA_REQUIRED', 400, { field });
    return null;
  }
  const id = String(value).trim().toLowerCase();
  if (!UUID.test(id)) {
    throw themeError(`Gorsel referansi gecersiz: ${field}`, 'THEME_INVALID_MEDIA', 400, { field });
  }
  return id;
}

// Links are internal references, never hrefs. The storefront builds the actual URL, so a
// tenant cannot point a call-to-action at an external or javascript: target.
const LINK_TARGETS = Object.freeze(['none', 'products', 'collection', 'category', 'product', 'page']);
const LINK_PAGES = Object.freeze(['anasayfa', 'urunler', 'hakkimizda', 'iletisim', 'blog', 'sepet']);

function parseLink(value, field) {
  const input = value && typeof value === 'object' ? value : { type: 'none' };
  const type = parseEnum(input.type ?? 'none', LINK_TARGETS, `${field}.type`);
  if (type === 'none') return { type: 'none' };
  if (type === 'products') return { type: 'products' };
  if (type === 'page') {
    return { type: 'page', page: parseEnum(input.page, LINK_PAGES, `${field}.page`) };
  }
  // collection / category / product are numeric internal ids resolved by the storefront.
  const id = parseIntInRange(input.id, { field: `${field}.id`, min: 1, max: 2147483647 });
  return { type, id };
}

// --- tokens ------------------------------------------------------------------------------

const COLOR_TOKENS = Object.freeze([
  'background', 'surface', 'text', 'mutedText', 'primary', 'primaryContrast',
  'accent', 'border', 'success', 'warning', 'danger',
]);

const DEFAULT_TOKENS = Object.freeze({
  colors: Object.freeze({
    // These are the storefront's existing palette values, not an invented default. The
    // stylesheet aliases them onto the variables the pages already read, so a tenant that
    // has never opened the editor renders byte-identically to the pre-A28 site.
    background: '#f7f5f1', surface: '#ffffff', text: '#1a1a1a', mutedText: '#4a4a4a',
    primary: '#3d6b38', primaryContrast: '#ffffff', accent: '#b46a45', border: '#ddd7cd',
    success: '#2f7a3d', warning: '#a8761b', danger: '#b3261e',
  }),
  fonts: Object.freeze({ heading: 'serif', body: 'sans' }),
  spacing: 16,
  radius: 4,
  container: Object.freeze({ maxWidth: 1200, paddingX: 24 }),
});

function parseTokens(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const colorsIn = source.colors && typeof source.colors === 'object' ? source.colors : {};
  const colors = {};
  for (const token of COLOR_TOKENS) {
    colors[token] = parseColor(
      colorsIn[token] ?? DEFAULT_TOKENS.colors[token],
      `tokens.colors.${token}`
    );
  }
  const fontsIn = source.fonts && typeof source.fonts === 'object' ? source.fonts : {};
  const containerIn = source.container && typeof source.container === 'object' ? source.container : {};
  return {
    colors,
    fonts: {
      heading: parseFont(fontsIn.heading ?? DEFAULT_TOKENS.fonts.heading, 'tokens.fonts.heading'),
      body: parseFont(fontsIn.body ?? DEFAULT_TOKENS.fonts.body, 'tokens.fonts.body'),
    },
    spacing: parseIntInRange(source.spacing, { field: 'tokens.spacing', min: 4, max: 48, fallback: DEFAULT_TOKENS.spacing }),
    radius: parseIntInRange(source.radius, { field: 'tokens.radius', min: 0, max: 32, fallback: DEFAULT_TOKENS.radius }),
    container: {
      maxWidth: parseIntInRange(containerIn.maxWidth, { field: 'tokens.container.maxWidth', min: 640, max: 2000, fallback: DEFAULT_TOKENS.container.maxWidth }),
      paddingX: parseIntInRange(containerIn.paddingX, { field: 'tokens.container.paddingX', min: 0, max: 96, fallback: DEFAULT_TOKENS.container.paddingX }),
    },
  };
}

// --- sections -----------------------------------------------------------------------------

const SECTION_TYPES = Object.freeze([
  'hero', 'product-grid', 'product-carousel', 'collection-blocks', 'collection-showcase',
  'category-slider', 'editorial', 'promo-banner', 'trust-features', 'newsletter',
]);
const TRUST_ICONS = Object.freeze(['shield', 'truck', 'refresh', 'lock', 'star', 'gift', 'headset']);
const ALIGNMENTS = Object.freeze(['left', 'center', 'right']);
const GRID_SORTS = Object.freeze(['recommended', 'newest', 'price_asc', 'price_desc']);

function parseIdList(value, field, max = 12) {
  const values = Array.isArray(value) ? value.slice(0, max) : [];
  const unique = [];
  for (let index = 0; index < values.length; index += 1) {
    const id = parseIntInRange(values[index], { field: `${field}[${index}]`, min: 1, max: 2147483647 });
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

function parseContentHeading(settings, path) {
  return {
    title: parseText(settings.title, { field: `${path}.title`, max: 120 }),
    description: parseText(settings.description, { field: `${path}.description`, max: 240 }),
  };
}

const SECTION_VALIDATORS = Object.freeze({
  hero(settings, path) {
    return {
      title: parseText(settings.title, { field: `${path}.title`, max: 120 }),
      subtitle: parseText(settings.subtitle, { field: `${path}.subtitle`, max: 240 }),
      mediaId: parseMediaId(settings.mediaId, `${path}.mediaId`),
      ctaLabel: parseText(settings.ctaLabel, { field: `${path}.ctaLabel`, max: 40 }),
      ctaTarget: parseLink(settings.ctaTarget, `${path}.ctaTarget`),
      alignment: parseEnum(settings.alignment ?? 'center', ALIGNMENTS, `${path}.alignment`),
    };
  },
  'product-grid'(settings, path) {
    return {
      title: parseText(settings.title, { field: `${path}.title`, max: 120 }),
      source: parseLink(settings.source ?? { type: 'products' }, `${path}.source`),
      limit: parseIntInRange(settings.limit, { field: `${path}.limit`, min: 2, max: 24, fallback: 8 }),
      columns: parseIntInRange(settings.columns, { field: `${path}.columns`, min: 2, max: 5, fallback: 4 }),
      sort: parseEnum(settings.sort ?? 'recommended', GRID_SORTS, `${path}.sort`),
    };
  },
  'product-carousel'(settings, path) {
    return {
      ...parseContentHeading(settings, path),
      source: parseLink(settings.source ?? { type: 'products' }, `${path}.source`),
      limit: parseIntInRange(settings.limit, { field: `${path}.limit`, min: 2, max: 16, fallback: 8 }),
      sort: parseEnum(settings.sort ?? 'newest', GRID_SORTS, `${path}.sort`),
      ctaLabel: parseText(settings.ctaLabel, { field: `${path}.ctaLabel`, max: 40 }),
    };
  },
  'collection-blocks'(settings, path) {
    const blocksIn = Array.isArray(settings.blocks) ? settings.blocks.slice(0, 6) : [];
    const blocks = blocksIn.map((block, index) => ({
      title: parseText(block?.title, { field: `${path}.blocks[${index}].title`, max: 80 }),
      mediaId: parseMediaId(block?.mediaId, `${path}.blocks[${index}].mediaId`),
      target: parseLink(block?.target, `${path}.blocks[${index}].target`),
    }));
    return {
      title: parseText(settings.title, { field: `${path}.title`, max: 120 }),
      blocks,
    };
  },
  'collection-showcase'(settings, path) {
    return {
      ...parseContentHeading(settings, path),
      collectionIds: parseIdList(settings.collectionIds, `${path}.collectionIds`, 8),
      limit: parseIntInRange(settings.limit, { field: `${path}.limit`, min: 1, max: 8, fallback: 4 }),
    };
  },
  'category-slider'(settings, path) {
    return {
      ...parseContentHeading(settings, path),
      categoryIds: parseIdList(settings.categoryIds, `${path}.categoryIds`, 12),
      limit: parseIntInRange(settings.limit, { field: `${path}.limit`, min: 2, max: 12, fallback: 8 }),
    };
  },
  editorial(settings, path) {
    return {
      eyebrow: parseText(settings.eyebrow, { field: `${path}.eyebrow`, max: 60 }),
      ...parseContentHeading(settings, path),
      mediaId: parseMediaId(settings.mediaId, `${path}.mediaId`),
      ctaLabel: parseText(settings.ctaLabel, { field: `${path}.ctaLabel`, max: 40 }),
      ctaTarget: parseLink(settings.ctaTarget, `${path}.ctaTarget`),
      alignment: parseEnum(settings.alignment ?? 'left', ALIGNMENTS, `${path}.alignment`),
    };
  },
  'promo-banner'(settings, path) {
    return {
      ...parseContentHeading(settings, path),
      mediaId: parseMediaId(settings.mediaId, `${path}.mediaId`),
      ctaLabel: parseText(settings.ctaLabel, { field: `${path}.ctaLabel`, max: 40 }),
      ctaTarget: parseLink(settings.ctaTarget, `${path}.ctaTarget`),
    };
  },
  'trust-features'(settings, path) {
    const itemsIn = Array.isArray(settings.items) ? settings.items.slice(0, 6) : [];
    return {
      title: parseText(settings.title, { field: `${path}.title`, max: 120 }),
      items: itemsIn.map((item, index) => ({
        icon: parseEnum(item?.icon ?? 'shield', TRUST_ICONS, `${path}.items[${index}].icon`),
        title: parseText(item?.title, { field: `${path}.items[${index}].title`, max: 60, required: true }),
        text: parseText(item?.text, { field: `${path}.items[${index}].text`, max: 160 }),
      })),
    };
  },
  newsletter(settings, path) {
    return {
      title: parseText(settings.title, { field: `${path}.title`, max: 120 }),
      text: parseText(settings.text, { field: `${path}.text`, max: 240 }),
      buttonLabel: parseText(settings.buttonLabel, { field: `${path}.buttonLabel`, max: 40 }),
    };
  },
});

const SECTION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function parseSections(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > 20) {
    throw themeError('Cok fazla bolum', 'THEME_TOO_MANY_SECTIONS', 400, { max: 20 });
  }
  const seen = new Set();
  const sections = list.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = String(source.id ?? '').trim().toLowerCase();
    if (!SECTION_ID.test(id)) {
      throw themeError(`Bolum kimligi gecersiz: sections[${index}]`, 'THEME_INVALID_SECTION_ID', 400, { index });
    }
    if (seen.has(id)) {
      throw themeError(`Bolum kimligi tekrar ediyor: ${id}`, 'THEME_DUPLICATE_SECTION_ID', 400, { id });
    }
    seen.add(id);
    const type = parseEnum(source.type, SECTION_TYPES, `sections[${index}].type`);
    const settingsIn = source.settings && typeof source.settings === 'object' ? source.settings : {};
    return {
      id,
      type,
      enabled: parseBoolean(source.enabled, true),
      order: parseIntInRange(source.order, { field: `sections[${index}].order`, min: 0, max: 999, fallback: index }),
      settings: SECTION_VALIDATORS[type](settingsIn, `sections[${index}].settings`),
    };
  });
  // Order is normalised to a dense 0..n-1 sequence so two sections can never claim the same
  // slot and the storefront never has to guess.
  return sections
    .slice()
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
    .map((section, index) => ({ ...section, order: index }));
}

// --- header / footer / announcement / seo -------------------------------------------------

const SOCIAL_KEYS = Object.freeze(['instagram', 'facebook', 'x', 'youtube', 'tiktok', 'pinterest']);
// Social links are a handle plus a server-owned base URL, so a tenant cannot inject an
// arbitrary destination through the "social link" field.
const SOCIAL_HANDLE = /^[A-Za-z0-9._-]{1,40}$/;

function parseSocial(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of SOCIAL_KEYS) {
    const handle = String(source[key] ?? '').trim().replace(/^@/, '');
    if (!handle) continue;
    if (!SOCIAL_HANDLE.test(handle)) {
      throw themeError(`Sosyal medya kullanici adi gecersiz: ${key}`, 'THEME_INVALID_SOCIAL', 400, { field: key });
    }
    out[key] = handle;
  }
  return out;
}

function parseHeader(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    logoMediaId: parseMediaId(source.logoMediaId, 'header.logoMediaId'),
    showSearch: parseBoolean(source.showSearch, true),
    showAccount: parseBoolean(source.showAccount, true),
    showCart: parseBoolean(source.showCart, true),
    sticky: parseBoolean(source.sticky, true),
  };
}

function parseFooter(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    text: parseText(source.text, { field: 'footer.text', max: 300 }),
    showPaymentIcons: parseBoolean(source.showPaymentIcons, true),
    social: parseSocial(source.social),
  };
}

function parseAnnouncement(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: parseBoolean(source.enabled, false),
    text: parseText(source.text, { field: 'announcement.text', max: 160 }),
    link: parseLink(source.link, 'announcement.link'),
  };
}

// SEO carries content defaults only. It deliberately has NO canonical host field: the
// canonical domain is resolved by A27 from verified custom domains, and letting a theme
// override it would hand a tenant a way to point canonical/og:url at any host.
function parseSeo(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    titleTemplate: parseText(source.titleTemplate, { field: 'seo.titleTemplate', max: 80 }),
    defaultDescription: parseText(source.defaultDescription, { field: 'seo.defaultDescription', max: 300 }),
    socialImageMediaId: parseMediaId(source.socialImageMediaId, 'seo.socialImageMediaId'),
  };
}

// --- top level -----------------------------------------------------------------------------

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion', 'tokens', 'header', 'footer', 'announcement', 'sections', 'seo',
]);

// Unknown top-level keys are REJECTED rather than dropped. Silently discarding them would
// let a `customHtml` or `rawCss` key sit in a payload looking accepted, and would hide a
// client/server schema drift instead of surfacing it.
function assertNoUnknownKeys(config) {
  const unknown = Object.keys(config || {}).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  if (unknown.length) {
    throw themeError(
      `Bilinmeyen tema alani: ${unknown.join(', ')}`,
      'THEME_UNKNOWN_FIELD', 400, { unknown }
    );
  }
}

function defaultThemeConfig() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tokens: parseTokens({}),
    header: parseHeader({}),
    footer: parseFooter({}),
    announcement: parseAnnouncement({}),
    sections: parseSections([
      { id: 'hero', type: 'hero', enabled: true, order: 0, settings: {} },
      { id: 'categories', type: 'category-slider', enabled: true, order: 1, settings: {} },
      { id: 'featured', type: 'product-carousel', enabled: true, order: 2, settings: {} },
      { id: 'collections', type: 'collection-showcase', enabled: true, order: 3, settings: {} },
      { id: 'trust', type: 'trust-features', enabled: true, order: 4, settings: {} },
    ]),
    seo: parseSeo({}),
  };
}

// The single entry point every write goes through. Returns a NEW canonical object; the
// input is never mutated and never partially trusted.
function validateThemeConfig(input) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!config) throw themeError('Tema yapilandirmasi gecersiz', 'THEME_INVALID_CONFIG', 400);
  assertNoUnknownKeys(config);

  const schemaVersion = Number(config.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw themeError('Tema schema surumu gecersiz', 'THEME_INVALID_SCHEMA_VERSION', 400);
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    // A future version cannot be understood, so accepting it would mean storing something
    // this server cannot safely render.
    throw themeError(
      'Tema schema surumu bu sunucudan yeni', 'THEME_SCHEMA_VERSION_TOO_NEW', 400,
      { schemaVersion, current: CURRENT_SCHEMA_VERSION }
    );
  }
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw themeError(
      'Tema once guncel schema surumune tasinmali', 'THEME_SCHEMA_MIGRATION_REQUIRED', 400,
      { schemaVersion, current: CURRENT_SCHEMA_VERSION }
    );
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tokens: parseTokens(config.tokens),
    header: parseHeader(config.header),
    footer: parseFooter(config.footer),
    announcement: parseAnnouncement(config.announcement),
    sections: parseSections(config.sections),
    seo: parseSeo(config.seo),
  };
}

// Renders the validated tokens as CSS custom properties. Every value here has already been
// through a parser that makes ';', '{', '}', 'url(' and friends impossible, so this cannot
// emit anything but a list of safe declarations.
function themeCssVariables(config) {
  const tokens = config.tokens;
  const declarations = [];
  for (const token of COLOR_TOKENS) {
    declarations.push([`--theme-${kebab(token)}`, tokens.colors[token]]);
  }
  declarations.push(['--theme-font-heading', FONT_STACKS[tokens.fonts.heading]]);
  declarations.push(['--theme-font-body', FONT_STACKS[tokens.fonts.body]]);
  declarations.push(['--theme-spacing', `${tokens.spacing}px`]);
  declarations.push(['--theme-radius', `${tokens.radius}px`]);
  declarations.push(['--theme-container-max', `${tokens.container.maxWidth}px`]);
  declarations.push(['--theme-container-padding', `${tokens.container.paddingX}px`]);
  return declarations;
}

function kebab(value) {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  COLOR_TOKENS,
  SECTION_TYPES,
  SECTION_VALIDATORS,
  FONT_KEYS,
  FONT_STACKS,
  TRUST_ICONS,
  LINK_TARGETS,
  LINK_PAGES,
  TOP_LEVEL_KEYS,
  DEFAULT_TOKENS,
  themeError,
  parseColor,
  parseFont,
  parseText,
  parseMediaId,
  parseLink,
  parseIdList,
  parseTokens,
  parseSections,
  defaultThemeConfig,
  validateThemeConfig,
  themeCssVariables,
};
