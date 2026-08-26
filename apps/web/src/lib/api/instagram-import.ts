import { authenticatedRequest, buildQuery } from "./core";
import { toBffAssetPath } from "./media";
import { getApiErrorCode } from "./types";

export type InstagramConnection = {
  id: string; username: string | null; account_type: "Business" | "Media_Creator" | null;
  status: "active" | "expired" | "disconnected" | "error"; token_expires_at: string | null;
  last_synced_at: string | null; defaults: { default_stock?: number; product_status?: "draft" };
};

export type InstagramMediaItem = {
  id: string; external_media_id: string; permalink: string | null; caption: string | null;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM"; provider_timestamp: string | null;
  visual_analysis_limited: boolean; source_changed: boolean; status: string;
  classification: string | null; classification_confidence: number | null;
  resulting_product_id: string | null; draft_id: string | null; draft_status: string | null;
  product_name: string | null; price: string | null; price_explicit: boolean; warnings: string[];
  error_code: string | null;
};

export type InstagramDraftImage = {
  id: string; position: number; detail_url: string; card_url: string; thumbnail_url: string;
  binding_type: "general" | "color"; bound_color: string | null; confidence: number | null;
};

export type InstagramDraft = {
  id: string; status: string; product_name: string | null; price: string | null; sale_price: string | null;
  category_id: string | null; colors: string[]; sizes: string[]; fabric_info: string | null;
  measurements: string[]; short_description: string | null; description: string | null;
  product_story: string | null; tags: string[]; warnings: string[]; default_stock: number;
  variant_stock: Record<string, number>; caption: string | null; permalink: string | null;
  media_type: string; images: InstagramDraftImage[]; resulting_product_id: string | null;
};

export type InstagramDraftPatch = Partial<Pick<InstagramDraft,
  "product_name" | "price" | "sale_price" | "category_id" | "colors" | "sizes" |
  "fabric_info" | "measurements" | "short_description" | "description" | "product_story" |
  "tags" | "default_stock" | "variant_stock"
>> & { image_bindings?: Array<{ image_id: string; bound_color: string | null }> };

export const fetchInstagramConnections = () => authenticatedRequest<InstagramConnection[]>("/instagram-imports/connections");
export const startInstagramOAuth = () => authenticatedRequest<{ authorization_url: string; expires_at: string }>("/instagram-imports/oauth/start", { method: "POST", body: "{}" });
export const syncInstagram = (id: string, mode: "full" | "incremental") => authenticatedRequest<{ discovered: number; changed: number; pages: number }>(`/instagram-imports/connections/${id}/sync`, { method: "POST", body: JSON.stringify({ mode }) });
export const disconnectInstagram = (id: string) => authenticatedRequest<InstagramConnection>(`/instagram-imports/connections/${id}`, { method: "DELETE" });
export const fetchInstagramMedia = (status = "", signal?: AbortSignal) => authenticatedRequest<InstagramMediaItem[]>(`/instagram-imports/media${buildQuery({ status })}`, { signal });
export const analyzeInstagramMedia = (id: string, force = false) => authenticatedRequest(`/instagram-imports/media/${id}/analyze`, { method: "POST", body: JSON.stringify({ force }) });
export const analyzeInstagramMediaBulk = (ids: string[]) => authenticatedRequest(`/instagram-imports/media/analyze-bulk`, { method: "POST", body: JSON.stringify({ ids }) });
export const fetchInstagramDraft = (id: string, signal?: AbortSignal) => authenticatedRequest<InstagramDraft>(`/instagram-imports/drafts/${id}`, { signal });
export const updateInstagramDraft = (id: string, patch: InstagramDraftPatch) => authenticatedRequest<InstagramDraft>(`/instagram-imports/drafts/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const applyInstagramDraft = (id: string) => authenticatedRequest<{ id: string }>(`/instagram-imports/drafts/${id}/apply`, { method: "POST", headers: { "idempotency-key": `instagram-ui:${crypto.randomUUID()}` }, body: "{}" });
export const applyInstagramDraftsBulk = (ids: string[]) => authenticatedRequest<Array<{ id: string }>>(`/instagram-imports/drafts/apply-bulk`, { method: "POST", headers: { "idempotency-key": `instagram-ui-bulk:${crypto.randomUUID()}` }, body: JSON.stringify({ ids }) });
export const skipInstagramDraft = (id: string) => authenticatedRequest<void>(`/instagram-imports/drafts/${id}/skip`, { method: "POST", body: "{}" });
export const skipInstagramDraftsBulk = (ids: string[]) => authenticatedRequest<void>(`/instagram-imports/drafts/skip-bulk`, { method: "POST", body: JSON.stringify({ ids }) });
export const discardInstagramDraft = (id: string) => authenticatedRequest<void>(`/instagram-imports/drafts/${id}`, { method: "DELETE" });

// Draft previews share the catalogue's proxy mapping so the two cannot drift apart;
// anything the proxy does not own (an absolute permalink) is handed back untouched.
export function dashboardMediaUrl(url: string) {
  return toBffAssetPath(url) || url;
}

export function instagramImportErrorMessage(error: unknown) {
  const code = getApiErrorCode(error);
  if (["INSTAGRAM_NOT_CONFIGURED", "INSTAGRAM_TOKEN_ENCRYPTION_NOT_CONFIGURED"].includes(code || "")) {
    return "Instagram bağlantısı production ortamında henüz yapılandırılmamış.";
  }
  if (code === "AI_CATALOG_NOT_CONFIGURED") {
    return "AI katalog analizi production ortamında henüz yapılandırılmamış.";
  }
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function instagramDraftErrorMessage(code: string | null) {
  if (code === "AI_CATALOG_NOT_CONFIGURED") {
    return "AI katalog analizi production ortamında henüz yapılandırılmamış.";
  }
  return code;
}
