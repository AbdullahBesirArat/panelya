import { authenticatedRequest } from "./core";

export type ImportType = "product_upsert" | "stock_update" | "price_update";
export type ImportStatus = "uploaded" | "previewed" | "queued" | "processing" | "completed" | "completed_with_errors" | "failed" | "cancelled";

export type ImportRowError = { code: string; message: string; column?: string | null };
export type ImportRow = {
  id: string;
  row_number: number;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "succeeded" | "error" | "cancelled";
  errors: ImportRowError[];
  resulting_entity_id: string | null;
  attempts: number;
  processed_at: string | null;
};

export type ImportJob = {
  id: string;
  type: ImportType;
  status: ImportStatus;
  original_filename: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  error_rows: number;
  warnings: ImportRowError[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  rows?: ImportRow[];
};

export type ImportConfig = {
  columnMapping?: Record<string, string>;
  categoryMapping?: Record<string, string>;
  collectionMapping?: Record<string, string>;
};

export function fetchImportJobs() {
  return authenticatedRequest<ImportJob[]>("/imports");
}

export function fetchImportJob(id: string) {
  return authenticatedRequest<ImportJob>(`/imports/${id}`);
}

export function previewImport(file: File, images: File | null, type: ImportType, config: ImportConfig) {
  const body = new FormData();
  body.set("file", file);
  if (images) body.set("images", images);
  body.set("type", type);
  body.set("config", JSON.stringify(config));
  body.set("idempotency_key", `admin-import:${crypto.randomUUID()}`);
  return authenticatedRequest<ImportJob>("/imports/preview", { method: "POST", body });
}

export function applyImport(id: string) {
  return authenticatedRequest<ImportJob>(`/imports/${id}/apply`, { method: "POST", body: JSON.stringify({}) });
}

export function retryImport(id: string) {
  return authenticatedRequest<ImportJob>(`/imports/${id}/retry`, { method: "POST", body: JSON.stringify({}) });
}

export function cancelImport(id: string) {
  return authenticatedRequest<ImportJob>(`/imports/${id}/cancel`, { method: "POST", body: JSON.stringify({}) });
}
