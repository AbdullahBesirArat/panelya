import { authenticatedRequest } from "./core";

// Types mirror the actual responses of panelya-api/routes/themes.js and the schema in
// panelya-api/modules/themes/schema.js.
//
// The schema is an allowlist by design: there is no field for raw HTML, raw CSS, a script,
// a font family, or an external URL, and the API rejects unknown keys outright. Keeping
// these types closed (no index signature, no `unknown` escape hatch) is what stops the
// editor from ever offering a control the backend would refuse.

export type ThemeFontStack = "system" | "serif" | "sans" | "mono";
export type ThemeAlignment = "left" | "center" | "right";
export type ThemeGridSort = "recommended" | "newest" | "price_asc" | "price_desc";
export type ThemeTrustIcon =
  | "shield" | "truck" | "refresh" | "lock" | "star" | "gift" | "headset";
export type ThemeSectionType =
  | "hero" | "product-grid" | "collection-blocks" | "trust-features" | "newsletter";

/** Internal reference only — a theme can never point at an arbitrary href. */
export type ThemeLink =
  | { type: "none" }
  | { type: "products" }
  | { type: "collection"; id: number }
  | { type: "category"; id: number }
  | { type: "product"; id: number }
  | { type: "page"; id: string };

export type ThemeColors = {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  primary: string;
  primaryContrast: string;
  accent: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
};

export type ThemeColorKey = keyof ThemeColors;

export type ThemeTokens = {
  colors: ThemeColors;
  fonts: { heading: ThemeFontStack; body: ThemeFontStack };
  spacing: number;
  radius: number;
  container: { maxWidth: number; paddingX: number };
};

export type ThemeSectionSettings = {
  hero: {
    title: string;
    subtitle: string;
    mediaId: string | null;
    ctaLabel: string;
    ctaTarget: ThemeLink;
    alignment: ThemeAlignment;
  };
  "product-grid": {
    title: string;
    source: ThemeLink;
    limit: number;
    columns: number;
    sort: ThemeGridSort;
  };
  "collection-blocks": {
    title: string;
    blocks: Array<{ title: string; mediaId: string | null; target: ThemeLink }>;
  };
  "trust-features": {
    title: string;
    items: Array<{ icon: ThemeTrustIcon; title: string; text: string }>;
  };
  newsletter: { title: string; text: string; buttonLabel: string };
};

export type ThemeSection = {
  [T in ThemeSectionType]: {
    id: string;
    type: T;
    enabled: boolean;
    order: number;
    settings: ThemeSectionSettings[T];
  };
}[ThemeSectionType];

export type ThemeConfig = {
  schemaVersion: number;
  tokens: ThemeTokens;
  header: {
    logoMediaId: string | null;
    showSearch: boolean;
    showAccount: boolean;
    showCart: boolean;
    sticky: boolean;
  };
  footer: {
    text: string;
    showPaymentIcons: boolean;
    social: Array<{ platform: string; handle: string }>;
  };
  announcement: { enabled: boolean; text: string; link: ThemeLink };
  sections: ThemeSection[];
  /** Content metadata only — the canonical host is resolved by A27, never by a theme. */
  seo: { titleTemplate: string; defaultDescription: string; socialImageMediaId: string | null };
};

export type ThemeVersionStatus = "draft" | "published" | "archived";

export type ThemeVersion = {
  id: number;
  version_number: number;
  schema_version: number;
  status: ThemeVersionStatus;
  config: ThemeConfig;
  /** Canonical hash of the config; doubles as the optimistic-concurrency token. */
  validation_hash: string;
  validation_result: ThemeValidationReport | null;
  based_on_version_id: number | null;
  created_at: string;
  updated_at: string;
  published_at?: string | null;
};

export type ThemeIssue = { field: string; code: string; message: string };

/** Errors block publishing; warnings are advisory and never do. */
export type ThemeValidationReport = {
  valid: boolean;
  errors: ThemeIssue[];
  warnings: ThemeIssue[];
};

export type PublishedTheme = {
  versionId: number;
  versionNumber: number;
  hash: string;
  config: ThemeConfig;
} | null;

export type ThemePublication = {
  id: number;
  theme_version_id: number;
  previous_theme_version_id: number | null;
  /** Set when this publication undid an earlier one; `action` says which kind it is. */
  rollback_of_publication_id: number | null;
  action: "publish" | "rollback";
  reason: string | null;
  config_hash: string | null;
  published_at: string;
  published_by: string | null;
};

export function fetchPublishedTheme() {
  return authenticatedRequest<{ theme: PublishedTheme }>("/themes/published");
}

export function fetchThemeDraft() {
  return authenticatedRequest<{ draft: ThemeVersion | null }>("/themes/draft");
}

/** Forks the published theme into an editable draft. Idempotent per organization. */
export function createThemeDraft() {
  return authenticatedRequest<{ draft: ThemeVersion }>("/themes/draft", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/**
 * Optimistic save. `expectedHash` is the hash the editor last saw; the backend answers
 * 409 THEME_VERSION_CONFLICT when someone else saved in between, rather than overwriting.
 */
export function saveThemeDraft(config: ThemeConfig, expectedHash: string | null) {
  return authenticatedRequest<{ draft: ThemeVersion }>("/themes/draft", {
    method: "PUT",
    headers: expectedHash ? { "If-Match": expectedHash } : undefined,
    body: JSON.stringify({ config, expectedHash }),
  });
}

export function validateThemeConfig(config?: ThemeConfig) {
  return authenticatedRequest<{ report: ThemeValidationReport }>("/themes/validate", {
    method: "POST",
    body: JSON.stringify(config ? { config } : {}),
  });
}

export function publishThemeDraft(expectedHash: string | null, reason: string) {
  return authenticatedRequest<{
    version: ThemeVersion;
    previousVersionId: number | null;
  }>("/themes/publish", {
    method: "POST",
    headers: expectedHash ? { "If-Match": expectedHash } : undefined,
    body: JSON.stringify({ expectedHash, reason }),
  });
}

/**
 * Rolling back clones the chosen snapshot into a NEW published version. The historical row
 * is never rewritten, so history stays an append-only record of what was live and when.
 */
export function rollbackTheme(versionId: number, reason: string) {
  return authenticatedRequest<{
    version: ThemeVersion;
    restoredFrom: number;
  }>("/themes/rollback", {
    method: "POST",
    body: JSON.stringify({ versionId, reason }),
  });
}

export function fetchThemeVersions(limit?: number) {
  const query = Number.isFinite(limit) ? `?limit=${Number(limit)}` : "";
  return authenticatedRequest<{ items: ThemeVersion[]; publications: ThemePublication[] }>(
    `/themes/versions${query}`
  );
}

export function fetchThemeVersion(versionId: number) {
  return authenticatedRequest<{ version: ThemeVersion }>(`/themes/versions/${versionId}`);
}

/**
 * A short-lived preview grant. The raw token is returned exactly once and only its sha256
 * is stored, so it must be handed straight to the preview frame and never kept.
 */
export function createThemePreviewToken(versionId?: number) {
  return authenticatedRequest<{ token: string; expiresInMinutes: number; versionId: number }>(
    "/themes/preview-token",
    { method: "POST", body: JSON.stringify(versionId ? { versionId } : {}) }
  );
}
