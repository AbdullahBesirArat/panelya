import { authenticatedRequest, keepSessionAlive } from "./core";

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

export type UploadedMediaAsset = {
  id: string;
  url: string;
  urls: Record<string, string>;
  byteSize: number;
  width: number;
  height: number;
};

export const MAX_MEDIA_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MEDIA_UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateMediaUpload(file: Pick<File, "name" | "size" | "type">) {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if (!ALLOWED_MEDIA_TYPES.has(file.type) || ![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
    return "Yalnızca JPEG, PNG veya WebP görsel yükleyebilirsiniz.";
  }
  if (!file.size || file.size > MAX_MEDIA_UPLOAD_BYTES) {
    return "Görsel en fazla 5 MB olabilir.";
  }
  return null;
}

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

/**
 * Uploads through the same-origin BFF. XMLHttpRequest is intentional here: it is the
 * browser primitive that exposes upload progress while still sending the HttpOnly session
 * cookie automatically. No bearer token or upstream API origin is ever available to this
 * client module.
 */
export async function uploadMediaAsset(file: File, onProgress?: (percent: number) => void) {
  const validationError = validateMediaUpload(file);
  if (validationError) throw new Error(validationError);
  await keepSessionAlive();

  return new Promise<UploadedMediaAsset>((resolve, reject) => {
    const formData = new FormData();
    formData.append("images", file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/bff/upload");
    request.withCredentials = true;
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error("Görsel yüklenemedi. Ağ bağlantısını kontrol edip tekrar deneyin."));
    request.onload = () => {
      const payload = request.response && typeof request.response === "object"
        ? request.response as { files?: UploadedMediaAsset[]; error?: string }
        : {};
      if (request.status < 200 || request.status >= 300 || !payload.files?.[0]?.id) {
        reject(new Error(payload.error || "Görsel yüklenemedi."));
        return;
      }
      onProgress?.(100);
      resolve(payload.files[0]);
    };
    request.send(formData);
  });
}
