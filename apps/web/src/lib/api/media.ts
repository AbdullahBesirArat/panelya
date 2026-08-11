import { API_BASE, authenticatedRequest } from "./core";

export function resolveApiAssetUrl(
  url: string | null | undefined,
  apiBase = API_BASE,
) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  const assetBase = apiBase.replace(/\/api\/?$/, "").replace(/\/$/, "");
  if (value.startsWith("/uploads/")) return `${assetBase}${value}`;
  if (value.startsWith("uploads/")) return `${assetBase}/${value}`;
  if (value.startsWith("/")) return `${assetBase}${value}`;
  return `${assetBase}/uploads/${value}`;
}

export async function uploadProductImages(files: File[]) {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));

  return authenticatedRequest<{ files: Array<{ url: string }> }>("/upload", {
    method: "POST",
    body: formData,
  });
}
