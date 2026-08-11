import { authenticatedRequest } from "./core";

export type SizeGuideColumn = { key: string; label: string };
export type SizeGuideRow = { label: string; cells: Record<string, string> };

export type SizeGuide = {
  id: number;
  name: string;
  description: string;
  measurement_unit: "cm" | "inch";
  columns: SizeGuideColumn[];
  rows: SizeGuideRow[];
  category_id: number | null;
  status: "draft" | "active";
  version: number;
  sort_order: number;
};

export type SizeGuideInput = {
  name: string;
  description?: string;
  measurement_unit?: "cm" | "inch";
  columns: SizeGuideColumn[];
  rows: SizeGuideRow[];
  category_id?: number | null;
  status?: "draft" | "active";
  sort_order?: number;
};

export function fetchSizeGuides() {
  return authenticatedRequest<{ items: SizeGuide[] }>("/operations/size-guides");
}

export function createSizeGuide(input: SizeGuideInput) {
  return authenticatedRequest<{ guide: SizeGuide }>("/operations/size-guides", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSizeGuide(id: number, input: SizeGuideInput) {
  return authenticatedRequest<{ guide: SizeGuide }>(`/operations/size-guides/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteSizeGuide(id: number) {
  return authenticatedRequest<{ ok: boolean }>(`/operations/size-guides/${id}`, { method: "DELETE" });
}

export function fetchProductSizeGuide(productId: number | string) {
  return authenticatedRequest<{ size_guide_id: number | null }>(`/operations/size-guides/product/${productId}`);
}

export function assignProductSizeGuide(productId: number | string, sizeGuideId: number | null) {
  return authenticatedRequest<{ assigned: number | null }>(`/operations/size-guides/product/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ size_guide_id: sizeGuideId }),
  });
}
