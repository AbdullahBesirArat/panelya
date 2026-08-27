import type {
  ThemeColorKey, ThemeConfig, ThemeFontStack, ThemeSection, ThemeSectionType,
  ThemeTrustIcon, ThemeValidationReport, ThemeVersion,
} from "@/lib/api/themes";

// Pure presentation + editing helpers so the theme editor can be unit-tested without
// rendering. Nothing here validates: the server owns validation, and duplicating its rules
// in the browser would only create two sources of truth that drift. What these helpers do
// guarantee is that the editor cannot *construct* something outside the schema — the
// option lists below are the same closed sets the API accepts.

export const COLOR_FIELDS: ReadonlyArray<{ key: ThemeColorKey; label: string }> = [
  { key: "background", label: "Arka plan" },
  { key: "surface", label: "Yüzey" },
  { key: "text", label: "Metin" },
  { key: "mutedText", label: "İkincil metin" },
  { key: "primary", label: "Birincil" },
  { key: "primaryContrast", label: "Birincil üzeri" },
  { key: "accent", label: "Vurgu" },
  { key: "border", label: "Kenarlık" },
  { key: "success", label: "Başarı" },
  { key: "warning", label: "Uyarı" },
  { key: "danger", label: "Hata" },
];

export const FONT_OPTIONS: ReadonlyArray<{ value: ThemeFontStack; label: string }> = [
  { value: "system", label: "Sistem" },
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans" },
  { value: "mono", label: "Mono" },
];

export const TRUST_ICON_OPTIONS: ReadonlyArray<{ value: ThemeTrustIcon; label: string }> = [
  { value: "shield", label: "Kalkan" },
  { value: "truck", label: "Kargo" },
  { value: "refresh", label: "İade" },
  { value: "lock", label: "Güvenlik" },
  { value: "star", label: "Yıldız" },
  { value: "gift", label: "Hediye" },
  { value: "headset", label: "Destek" },
];

const SECTION_LABELS: Record<ThemeSectionType, string> = {
  hero: "Kapak alanı",
  "product-grid": "Ürün ızgarası",
  "product-carousel": "Yatay ürün vitrini",
  "collection-blocks": "Koleksiyon blokları",
  "collection-showcase": "Koleksiyon vitrini",
  "category-slider": "Kategori kaydırıcısı",
  editorial: "Editoryal blok",
  "promo-banner": "Kampanya bannerı",
  "trust-features": "Güven şeritleri",
  newsletter: "Bülten",
};

export const SECTION_OPTIONS: ReadonlyArray<{ value: ThemeSectionType; label: string }> = [
  { value: "hero", label: SECTION_LABELS.hero },
  { value: "category-slider", label: SECTION_LABELS["category-slider"] },
  { value: "collection-showcase", label: SECTION_LABELS["collection-showcase"] },
  { value: "product-carousel", label: SECTION_LABELS["product-carousel"] },
  { value: "product-grid", label: SECTION_LABELS["product-grid"] },
  { value: "editorial", label: SECTION_LABELS.editorial },
  { value: "promo-banner", label: SECTION_LABELS["promo-banner"] },
  { value: "trust-features", label: SECTION_LABELS["trust-features"] },
  { value: "newsletter", label: SECTION_LABELS.newsletter },
];

export function sectionLabel(type: ThemeSectionType) {
  return SECTION_LABELS[type] || type;
}

/** Colours are canonical 6-digit lowercase hex; anything else is refused by the API. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * Normalises what a colour input can produce (`#ABC`, `#AABBCC`, uppercase) into the
 * canonical form. Returns null when it is not a colour at all, so the editor can show the
 * field as invalid instead of sending something the API will reject.
 */
export function normalizeHex(value: string): string | null {
  const trimmed = String(value || "").trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return HEX_COLOR.test(trimmed) ? trimmed : null;
}

export const NUMERIC_BOUNDS = {
  spacing: { min: 4, max: 48 },
  radius: { min: 0, max: 32 },
  maxWidth: { min: 640, max: 2000 },
  paddingX: { min: 0, max: 96 },
  limit: { min: 2, max: 24 },
  columns: { min: 2, max: 5 },
} as const;

export function createSection(type: ThemeSectionType, order: number): ThemeSection {
  const id = `${type}-${Date.now().toString(36)}-${order}`.slice(0, 40);
  const base = { id, enabled: true, order };
  switch (type) {
    case "hero":
      return {
        ...base,
        type,
        settings: {
          eyebrow: "", title: "", accentText: "", subtitle: "", mediaId: null,
          mobileMediaId: null, ctaLabel: "", ctaTarget: { type: "products" },
          secondaryCtaLabel: "", secondaryCtaTarget: { type: "none" }, alignment: "left",
        },
      };
    case "product-grid":
      return { ...base, type, settings: { title: "", source: { type: "products" }, limit: 8, columns: 4, sort: "recommended" } };
    case "product-carousel":
      return { ...base, type, settings: { title: "", description: "", source: { type: "products" }, limit: 8, sort: "newest", ctaLabel: "" } };
    case "collection-blocks":
      return { ...base, type, settings: { title: "", blocks: [] } };
    case "collection-showcase":
      return { ...base, type, settings: { title: "", description: "", collectionIds: [], limit: 4 } };
    case "category-slider":
      return { ...base, type, settings: { title: "", description: "", categoryIds: [], limit: 8 } };
    case "editorial":
      return { ...base, type, settings: { eyebrow: "", title: "", description: "", mediaId: null, ctaLabel: "", ctaTarget: { type: "products" }, alignment: "left" } };
    case "promo-banner":
      return { ...base, type, settings: { title: "", description: "", mediaId: null, ctaLabel: "", ctaTarget: { type: "products" } } };
    case "trust-features":
      return { ...base, type, settings: { title: "", items: [] } };
    case "newsletter":
      return { ...base, type, settings: { title: "", text: "", buttonLabel: "" } };
  }
}

export function clampToBounds(value: number, bounds: { min: number; max: number }) {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/**
 * Moves a section one place up or down and renumbers `order` densely, which is exactly what
 * the server does on save. Returns the input untouched when the move is not possible, so
 * the caller can keep the button disabled state and the data in agreement.
 */
export function moveSection(sections: ThemeSection[], index: number, direction: -1 | 1): ThemeSection[] {
  const target = index + direction;
  if (index < 0 || index >= sections.length || target < 0 || target >= sections.length) return sections;
  const next = sections.slice();
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next.map((section, order) => ({ ...section, order }));
}

export function toggleSection(sections: ThemeSection[], index: number): ThemeSection[] {
  if (index < 0 || index >= sections.length) return sections;
  return sections.map((section, position) =>
    (position === index ? { ...section, enabled: !section.enabled } : section));
}

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

const SAVE_LABELS: Record<SaveState, string> = {
  idle: "Değişiklik yok",
  dirty: "Kaydedilmemiş değişiklik",
  saving: "Kaydediliyor…",
  saved: "Taslak kaydedildi",
  conflict: "Taslak başka bir yerde değişti",
  error: "Kaydedilemedi",
};

export function saveStateLabel(state: SaveState) {
  return SAVE_LABELS[state];
}

const ERROR_MESSAGES: Record<string, string> = {
  THEME_VERSION_CONFLICT:
    "Bu taslak siz düzenlerken başka bir yerde kaydedilmiş. Değişikliklerinizi kaybetmemek için güncel taslağı yükleyip tekrar uygulayın.",
  THEME_VALIDATION_FAILED: "Tema doğrulamadan geçmedi. Aşağıdaki alanları düzeltin.",
  THEME_UNKNOWN_FIELD: "Tema yapılandırmasında tanınmayan bir alan var.",
  THEME_SCHEMA_VERSION_TOO_NEW: "Bu tema daha yeni bir şema sürümüyle kaydedilmiş. Paneli güncelleyin.",
  THEME_DRAFT_NOT_FOUND: "Düzenlenecek taslak yok. Önce yayındaki temadan taslak oluşturun.",
  THEME_PREVIEW_INVALID: "Önizleme bağlantısı geçersiz veya süresi dolmuş. Yeniden önizleme açın.",
  THEME_NOTHING_TO_PUBLISH: "Yayınlanacak değişiklik yok.",
  REASON_REQUIRED: "Bu işlem için gerekçe zorunludur.",
};

export function themeErrorMessage(code: string | null | undefined, fallback: string) {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback || "İşlem tamamlanamadı.";
}

/** Publishing is blocked by errors only; warnings are advisory. */
export function canPublish(report: ThemeValidationReport | null | undefined) {
  if (!report) return false;
  return report.valid && report.errors.length === 0;
}

export function versionLabel(version: Pick<ThemeVersion, "version_number" | "status">) {
  const status = version.status === "published"
    ? "yayında"
    : version.status === "draft" ? "taslak" : "arşiv";
  return `v${version.version_number} (${status})`;
}

/**
 * True when the draft differs from what is live. Compares the server-canonical hashes when
 * both are known, so it never claims "no changes" because of key ordering.
 */
export function draftDiffersFromPublished(draftHash: string | null, publishedHash: string | null) {
  if (!draftHash) return false;
  if (!publishedHash) return true;
  return draftHash !== publishedHash;
}

export function sectionSummary(section: ThemeSection): string {
  switch (section.type) {
    case "hero":
      return section.settings.title || "Başlıksız kapak";
    case "product-grid":
      return `${section.settings.limit} ürün · ${section.settings.columns} sütun`;
    case "product-carousel":
      return `${section.settings.limit} ürün · yatay akış`;
    case "collection-blocks":
      return `${section.settings.blocks.length} blok`;
    case "collection-showcase":
      return `${section.settings.collectionIds.length || "Otomatik"} koleksiyon`;
    case "category-slider":
      return `${section.settings.categoryIds.length || "Otomatik"} kategori`;
    case "editorial":
    case "promo-banner":
      return section.settings.title || "Başlıksız içerik";
    case "trust-features":
      return `${section.settings.items.length} madde`;
    case "newsletter":
      return section.settings.title || "Bülten";
    default:
      return "";
  }
}

/**
 * Builds the preview URL for the storefront frame. The raw token goes in the FRAGMENT:
 * fragments are never sent to a server, never logged, and never appear in a Referer. The
 * storefront reads it once, exchanges it, and scrubs it from the address bar.
 */
export function previewUrl(storefrontOrigin: string, token: string) {
  const base = String(storefrontOrigin || "").replace(/\/+$/, "");
  return `${base}/?theme_preview=1#preview_token=${encodeURIComponent(token)}`;
}

/** The editor never sends a partial config: this returns a full copy with one field changed. */
export function withTokens(config: ThemeConfig, tokens: ThemeConfig["tokens"]): ThemeConfig {
  return { ...config, tokens };
}

export function withSections(config: ThemeConfig, sections: ThemeSection[]): ThemeConfig {
  return { ...config, sections };
}
