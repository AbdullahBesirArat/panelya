// Server-side Backend-For-Frontend configuration and pure helpers.
// The admin browser only ever talks to the same-origin BFF; auth tokens live in
// HttpOnly cookies and never reach client JavaScript / Web Storage.

export const ACCESS_COOKIE = "pnl_at";
export const REFRESH_COOKIE = "pnl_rt";
export const ADMIN_RESTORE_COOKIE = "pnl_ar";

export const BFF_BASE_PATH = "/api/bff";

// Access-cookie lifetime is only a ceiling; the upstream access token is itself
// short-lived and re-issued through the refresh flow.
export const ACCESS_COOKIE_MAX_AGE = 60 * 60; // 1h
export const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30d
export const RESTORE_COOKIE_MAX_AGE = 60 * 30; // impersonation window

export function shouldUseSecureCookies(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv === "production";
}

export function upstreamApiOrigin(): string {
  const raw =
    process.env.PANELYA_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "http://localhost:3000/api";
  return raw.replace(/\/+$/, "");
}

// Legacy catalogue rows still carry API-root `/uploads/<file>` image paths, which are
// mounted beside `/api`, not under it. Exactly that one shape is proxied — a single
// safe filename, read-only — so the dashboard can render those previews without ever
// putting the upstream origin in the browser. Nothing else at the API root is reachable.
const LEGACY_UPLOAD_PATH = /^uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isLegacyUploadPath(method: string, joinedPath: string): boolean {
  if (!["GET", "HEAD"].includes(String(method || "").toUpperCase())) return false;
  if (joinedPath.includes("..")) return false;
  return LEGACY_UPLOAD_PATH.test(joinedPath);
}

// The API root, i.e. the upstream base without its `/api` prefix.
export function upstreamAssetOrigin(): string {
  return upstreamApiOrigin().replace(/\/api$/, "");
}

// CSRF defence: only accept state-changing requests that are provably same-site.
export function isSameOriginRequest(method: string, headers: Headers, selfOrigin: string): boolean {
  const m = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(m)) return true;

  const secFetchSite = (headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (secFetchSite && !["same-origin", "same-site", "none"].includes(secFetchSite)) return false;

  const origin = (headers.get("origin") || "").trim();
  if (origin && origin !== selfOrigin) return false;

  const referer = (headers.get("referer") || "").trim();
  if (referer) {
    try {
      if (new URL(referer).origin !== selfOrigin) return false;
    } catch {
      return false;
    }
  }

  if (secFetchSite || origin || referer) return true;

  // No browser provenance headers: reject the state-changing request.
  return false;
}

// Remove auth tokens from any body echoed back to the browser.
export function stripTokens<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const next: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete next.accessToken;
  delete next.refreshToken;
  return next as T;
}

// True when the upstream path is the super-admin impersonation entry point.
export function isImpersonationStart(joinedPath: string): boolean {
  return /^platform\/stores\/[^/]+\/impersonate$/.test(joinedPath);
}

export function isLogoutPath(joinedPath: string): boolean {
  return joinedPath === "auth/session/logout" || joinedPath === "auth/admin/session/logout";
}

export function needsRefreshCookieInjection(joinedPath: string): boolean {
  return joinedPath === "auth/session/refresh" || isLogoutPath(joinedPath);
}
