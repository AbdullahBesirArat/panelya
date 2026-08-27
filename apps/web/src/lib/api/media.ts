import { authenticatedRequest } from "./core";

// The admin browser must never hold the upstream API origin. Asset URLs used to be
// built by prepending it client-side, and its client-side fallback was
// `http://localhost:3000`, so every production preview became a refused connection
// (plus a mixed-content warning on the HTTPS dashboard). Media now travels the same
// same-origin BFF that already carries the rest of the dashboard's API traffic.
const BFF_BASE = "/api/bff";

// Upstream `/api/<rest>` is `/api/bff/<rest>` here. Legacy catalogue rows still carry
// API-root `/uploads/<file>` paths, which live outside the `/api` prefix; the BFF
// forwards that one extra shape so those previews stay same-origin too.
export function toBffAssetPath(value: string): string {
  if (value.startsWith("/api/")) return `${BFF_BASE}/${value.slice("/api/".length)}`;
  if (value.startsWith("/uploads/")) return `${BFF_BASE}${value}`;
  if (value.startsWith("uploads/")) return `${BFF_BASE}/${value}`;
  return "";
}

export function resolveApiAssetUrl(url: string | null | undefined) {
  const value = String(url || "").trim();
  if (!value) return "";
  // Object-storage and CDN URLs are already absolute and public: never rewrite them.
  if (/^https?:\/\//i.test(value)) return value;

  const proxied = toBffAssetPath(value);
  if (proxied) return proxied;
  // Anything else is either already a same-origin path or a bare legacy filename.
  return value.startsWith("/") ? value : `${BFF_BASE}/uploads/${value}`;
}

export type MediaAsset = {
  id: string;
  url: string;
  original_filename: string;
  byte_size: number;
  content_type: string;
  width: number | null;
  height: number | null;
  status: string;
  created_at: string;
  variants: Record<string, { url: string; width: number; height: number; byte_size: number }>;
  reference_count: number;
};

export async function fetchMediaAssets() {
  return authenticatedRequest<MediaAsset[]>("/media");
}

export async function uploadProductImages(files: File[]) {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));

  return authenticatedRequest<{ files: Array<{ url: string }> }>("/upload", {
    method: "POST",
    body: formData,
  });
}
