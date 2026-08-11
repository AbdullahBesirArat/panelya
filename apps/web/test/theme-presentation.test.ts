import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  COLOR_FIELDS, FONT_OPTIONS, NUMERIC_BOUNDS, TRUST_ICON_OPTIONS, canPublish, clampToBounds,
  draftDiffersFromPublished, moveSection, normalizeHex, previewUrl, saveStateLabel,
  sectionLabel, sectionSummary, themeErrorMessage, toggleSection, versionLabel,
  withSections, withTokens, type SaveState,
} from "../src/features/theme/presentation";
import type {
  ThemeConfig, ThemeSection, ThemeSectionType, ThemeValidationReport,
} from "../src/lib/api/themes";

const SECTION_TYPES: ThemeSectionType[] = [
  "hero", "product-grid", "collection-blocks", "trust-features", "newsletter",
];

function section(type: ThemeSectionType, order: number, enabled = true): ThemeSection {
  const base = { id: `${type}-1`, enabled, order };
  switch (type) {
    case "hero":
      return {
        ...base, type,
        settings: {
          title: "Kapak", subtitle: "Alt", mediaId: null, ctaLabel: "Keşfet",
          ctaTarget: { type: "products" }, alignment: "center",
        },
      };
    case "product-grid":
      return {
        ...base, type,
        settings: { title: "Ürünler", source: { type: "products" }, limit: 8, columns: 4, sort: "recommended" },
      };
    case "collection-blocks":
      return { ...base, type, settings: { title: "Koleksiyonlar", blocks: [] } };
    case "trust-features":
      return {
        ...base, type,
        settings: { title: "Güven", items: [{ icon: "shield", title: "Güvenli", text: "SSL" }] },
      };
    case "newsletter":
      return { ...base, type, settings: { title: "Bülten", text: "Katıl", buttonLabel: "Gönder" } };
  }
}

function config(): ThemeConfig {
  return {
    schemaVersion: 1,
    tokens: {
      colors: {
        background: "#ffffff", surface: "#ffffff", text: "#111111", mutedText: "#666666",
        primary: "#111111", primaryContrast: "#ffffff", accent: "#c8a97e", border: "#e5e5e5",
        success: "#1a7f4b", warning: "#b7791f", danger: "#c0392b",
      },
      fonts: { heading: "serif", body: "system" },
      spacing: 16,
      radius: 8,
      container: { maxWidth: 1200, paddingX: 24 },
    },
    header: { logoMediaId: null, showSearch: true, showAccount: true, showCart: true, sticky: true },
    footer: { text: "Suvera", showPaymentIcons: true, social: [] },
    announcement: { enabled: true, text: "Kargo bedava", link: { type: "none" } },
    sections: SECTION_TYPES.map((type, index) => section(type, index)),
    seo: { titleTemplate: "%s | Suvera", defaultDescription: "", socialImageMediaId: null },
  };
}

const valid: ThemeValidationReport = { valid: true, errors: [], warnings: [] };
const invalid: ThemeValidationReport = {
  valid: false,
  errors: [{ field: "tokens.colors.primary", code: "THEME_INVALID_COLOR", message: "Geçersiz renk" }],
  warnings: [],
};

test("every save state reads differently, so the editor never hides a failure", () => {
  const states: SaveState[] = ["idle", "dirty", "saving", "saved", "conflict", "error"];
  const labels = states.map(saveStateLabel);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every((label) => label.length > 0));
  // The two states that mean "your work is not on the server" must not read like success.
  assert.notEqual(saveStateLabel("conflict"), saveStateLabel("saved"));
  assert.notEqual(saveStateLabel("error"), saveStateLabel("saved"));
});

test("THEME_VERSION_CONFLICT maps from the backend code, never from message text", () => {
  const byCode = themeErrorMessage("THEME_VERSION_CONFLICT", "boom");
  assert.match(byCode, /güncel taslağı/i);
  assert.notEqual(byCode, "boom");
  // A message that merely mentions a conflict must NOT be treated as one: only the code is
  // authoritative, otherwise a reworded backend string would silently change the UI.
  assert.equal(themeErrorMessage(null, "THEME_VERSION_CONFLICT oldu"), "THEME_VERSION_CONFLICT oldu");
  assert.equal(themeErrorMessage(undefined, ""), "İşlem tamamlanamadı.");
});

test("each theme error code the API can return has its own message", () => {
  const codes = [
    "THEME_VALIDATION_FAILED", "THEME_UNKNOWN_FIELD", "THEME_SCHEMA_VERSION_TOO_NEW",
    "THEME_DRAFT_NOT_FOUND", "THEME_PREVIEW_INVALID", "THEME_NOTHING_TO_PUBLISH", "REASON_REQUIRED",
  ];
  const messages = codes.map((code) => themeErrorMessage(code, "fallback"));
  assert.equal(new Set(messages).size, messages.length);
  assert.ok(messages.every((message) => message !== "fallback"));
});

test("publishing is gated by validation errors, not by warnings", () => {
  assert.equal(canPublish(valid), true);
  assert.equal(canPublish(invalid), false);
  assert.equal(canPublish(null), false, "an unvalidated draft is not publishable");
  assert.equal(canPublish(undefined), false);
  assert.equal(
    canPublish({ valid: true, errors: [], warnings: [{ field: "seo", code: "W", message: "kısa" }] }),
    true,
    "a warning is advisory"
  );
  // A report that claims valid while carrying errors is refused rather than trusted.
  assert.equal(canPublish({ valid: true, errors: invalid.errors, warnings: [] }), false);
});

test("the editor only knows the font stacks the API accepts", () => {
  assert.deepEqual(FONT_OPTIONS.map((option) => option.value), ["system", "serif", "sans", "mono"]);
  assert.deepEqual(
    TRUST_ICON_OPTIONS.map((option) => option.value),
    ["shield", "truck", "refresh", "lock", "star", "gift", "headset"]
  );
  assert.equal(new Set(FONT_OPTIONS.map((o) => o.label)).size, FONT_OPTIONS.length);
});

test("colour input is normalised to canonical hex and anything else is refused", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("  #C8A97E "), "#c8a97e");
  assert.equal(normalizeHex("#c8a97e"), "#c8a97e");
  // The values that would matter if they ever reached a stylesheet.
  assert.equal(normalizeHex("red"), null);
  assert.equal(normalizeHex("rgb(0,0,0)"), null);
  assert.equal(normalizeHex("#fff; } body { display:none"), null);
  assert.equal(normalizeHex("url(javascript:alert(1))"), null);
  assert.equal(normalizeHex(""), null);
});

test("numeric tokens are clamped to the schema bounds before they leave the editor", () => {
  assert.equal(clampToBounds(1, NUMERIC_BOUNDS.spacing), NUMERIC_BOUNDS.spacing.min);
  assert.equal(clampToBounds(999, NUMERIC_BOUNDS.radius), NUMERIC_BOUNDS.radius.max);
  assert.equal(clampToBounds(12.4, NUMERIC_BOUNDS.spacing), 12);
  assert.equal(clampToBounds(Number.NaN, NUMERIC_BOUNDS.limit), NUMERIC_BOUNDS.limit.min);
  assert.equal(clampToBounds(Number.POSITIVE_INFINITY, NUMERIC_BOUNDS.columns), NUMERIC_BOUNDS.columns.min);
  assert.equal(clampToBounds(3, NUMERIC_BOUNDS.columns), 3);
});

test("every colour field and section type is labelled for the editor", () => {
  assert.equal(COLOR_FIELDS.length, Object.keys(config().tokens.colors).length);
  for (const field of COLOR_FIELDS) assert.ok(field.label.length > 0);
  for (const type of SECTION_TYPES) {
    assert.ok(sectionLabel(type).length > 0);
    assert.notEqual(sectionLabel(type), type, `${type} needs a human label`);
  }
});

test("moving a section reorders it and renumbers order densely", () => {
  const sections = config().sections;
  const moved = moveSection(sections, 0, 1);
  assert.deepEqual(moved.map((item) => item.type), [
    "product-grid", "hero", "collection-blocks", "trust-features", "newsletter",
  ]);
  assert.deepEqual(moved.map((item) => item.order), [0, 1, 2, 3, 4]);
  // Out-of-range moves return the input untouched so the disabled buttons and the data agree.
  assert.equal(moveSection(sections, 0, -1), sections);
  assert.equal(moveSection(sections, sections.length - 1, 1), sections);
  assert.notEqual(moved, sections, "the input array is never mutated");
  assert.deepEqual(sections.map((item) => item.type), SECTION_TYPES);
});

test("toggling a section flips exactly one entry", () => {
  const sections = config().sections;
  const toggled = toggleSection(sections, 2);
  assert.equal(toggled[2].enabled, false);
  assert.deepEqual(toggled.filter((item) => !item.enabled).map((item) => item.type), ["collection-blocks"]);
  assert.equal(toggleSection(sections, 99), sections);
});

test("section summaries describe the section without leaking raw markup", () => {
  const sections = config().sections;
  assert.equal(sectionSummary(sections[0]), "Kapak");
  assert.equal(sectionSummary(sections[1]), "8 ürün · 4 sütun");
  assert.equal(sectionSummary(sections[2]), "0 blok");
  assert.equal(sectionSummary(sections[3]), "1 madde");
  assert.equal(sectionSummary(sections[4]), "Bülten");
});

test("a draft is only 'changed' when its canonical hash differs from what is live", () => {
  assert.equal(draftDiffersFromPublished("a", "a"), false);
  assert.equal(draftDiffersFromPublished("a", "b"), true);
  assert.equal(draftDiffersFromPublished("a", null), true, "nothing published yet is a change");
  assert.equal(draftDiffersFromPublished(null, "b"), false, "no draft is nothing to publish");
});

test("version history rows name the version and its current status", () => {
  assert.equal(versionLabel({ version_number: 4, status: "published" }), "v4 (yayında)");
  assert.equal(versionLabel({ version_number: 3, status: "archived" }), "v3 (arşiv)");
  assert.equal(versionLabel({ version_number: 5, status: "draft" }), "v5 (taslak)");
});

test("the preview URL carries the token in the fragment, never the query", () => {
  const url = previewUrl("https://shop.example/", "tok en+/=");
  assert.ok(url.startsWith("https://shop.example/?theme_preview=1#"));
  const [beforeHash, fragment] = url.split("#");
  assert.ok(!beforeHash.includes("tok"), "a query token would reach the server and the logs");
  assert.equal(fragment, `preview_token=${encodeURIComponent("tok en+/=")}`);
  // Trailing slashes must not produce a double slash that changes the origin.
  assert.equal(previewUrl("https://shop.example///", "t").split("?")[0], "https://shop.example/");
});

test("config updates replace the whole object so no partial config is ever sent", () => {
  const base = config();
  const tokens = { ...base.tokens, radius: 12 };
  const next = withTokens(base, tokens);
  assert.equal(next.tokens.radius, 12);
  assert.equal(next.sections, base.sections);
  assert.equal(base.tokens.radius, 8, "the input config is not mutated");
  assert.deepEqual(Object.keys(next).sort(), Object.keys(base).sort());

  const reordered = withSections(base, moveSection(base.sections, 0, 1));
  assert.equal(reordered.tokens, base.tokens);
  assert.equal(reordered.sections[0].type, "product-grid");
});

test("the editor offers no control that could carry raw CSS, HTML or a URL", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "components", "sections", "theme-section.tsx"),
    "utf8"
  );
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /<textarea/i, "a free-text area is how arbitrary CSS gets in");
  // The only inline style is the admin sizing its own preview frame; no theme value is ever
  // written into a style attribute.
  const inlineStyles = source.match(/style=\{\{[^}]*\}\}/g) ?? [];
  assert.equal(inlineStyles.length, 1);
  assert.match(inlineStyles[0], /previewWidth/);
  assert.doesNotMatch(source, /setProperty\(/);
  // Publishing is a server decision; the client may only add a gate, never remove one.
  assert.match(source, /publishAllowed/);
  assert.match(source, /THEME_VERSION_CONFLICT/);
});

test("the preview token is held in render state only and never persisted", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "components", "sections", "theme-section.tsx"),
    "utf8"
  );
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /sessionStorage/);
  assert.doesNotMatch(source, /document\.cookie/);
  assert.doesNotMatch(source, /console\.(log|info|warn|error)/);
});

test("the theme section is reachable from the admin navigation", () => {
  const root = path.join(__dirname, "..", "src");
  const navigation = fs.readFileSync(path.join(root, "lib", "demo-data.ts"), "utf8");
  const content = fs.readFileSync(path.join(root, "components", "operations-content.tsx"), "utf8");
  assert.match(navigation, /\{ key: "theme", label: "[^"]+" \}/);
  assert.match(navigation, /^ {2}theme: \{$/m, "a section without sectionMeta renders no page header");
  assert.match(content, /case "theme":/);
  assert.match(content, /<ThemeSection currentRole=\{currentRole\} organizationSlug=\{activeOrganizationSlug\} \/>/);
});
