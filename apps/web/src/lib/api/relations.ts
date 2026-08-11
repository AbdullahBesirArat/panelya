import { authenticatedRequest } from "./core";

export type RelationType = "related" | "complementary" | "upsell";
export type ProductRelations = { related: number[]; complementary: number[]; upsell: number[] };

export function fetchProductRelations(productId: string | number) {
  return authenticatedRequest<ProductRelations>(`/operations/relations/${productId}`);
}

export function setProductRelations(productId: string | number, relationType: RelationType, targetProductIds: number[]) {
  return authenticatedRequest<{ source_product_id: number; relation_type: RelationType; target_product_ids: number[] }>(
    `/operations/relations/${productId}`,
    { method: "PUT", body: JSON.stringify({ relation_type: relationType, target_product_ids: targetProductIds }) }
  );
}
