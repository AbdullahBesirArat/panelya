import { authenticatedRequest, buildQuery } from "./core";
import type { ApiCategory, ApiProduct, ProductStatus, ProductVariant } from "./types";

export type ProductWriteInput = {
  name: string;
  categoryId?: string;
  price: number;
  salePrice?: number | null;
  stock: number;
  status: ProductStatus;
  colors?: string[];
  sizes?: string[];
  variants?: ProductVariant[];
  images?: string[];
  details?: {
    short_description?: string;
    story?: string;
    measurements?: string;
    delivery_note?: string;
    fabric_info?: string;
  };
  tags?: string;
  description?: string;
  product_story?: string;
  autoGenerateSku?: boolean;
};

export async function fetchCategories() {
  return authenticatedRequest<ApiCategory[]>("/categories");
}

export async function createCategory(payload: { name: string; slug?: string; imageUrl?: string }) {
  return authenticatedRequest<ApiCategory>("/categories", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      slug: payload.slug,
      image_url: payload.imageUrl || "",
    }),
  });
}

export async function updateCategory(id: string, payload: { name: string; slug?: string; imageUrl?: string }) {
  return authenticatedRequest<ApiCategory>(`/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      slug: payload.slug,
      image_url: payload.imageUrl || "",
    }),
  });
}

export async function deleteCategory(id: string) {
  return authenticatedRequest<void>(`/categories/${id}`, {
    method: "DELETE",
  });
}

export async function fetchCategoryFeaturedProducts(categoryId: string) {
  return authenticatedRequest<Array<{ id: string; name: string; status: string; featured_in_category: boolean }>>(
    `/categories/${categoryId}/featured-products`
  );
}

export async function setCategoryFeaturedProducts(categoryId: string, ids: string[]) {
  return authenticatedRequest<{ ok: boolean; featuredCount: number }>(`/categories/${categoryId}/featured-products`, {
    method: "PUT",
    body: JSON.stringify({ ids: ids.map(Number) }),
  });
}

export async function fetchProducts(filters: {
  q?: string;
  categoryId?: string;
  status?: ProductStatus | "";
  limit?: number;
  offset?: number;
} = {}, signal?: AbortSignal) {
  return authenticatedRequest<ApiProduct[]>(
    `/products${buildQuery({
      q: filters.q,
      category_id: filters.categoryId,
      status: filters.status,
      limit: filters.limit,
      offset: filters.offset,
    })}`,
    { signal },
  );
}

export async function createProduct(payload: ProductWriteInput) {
  return authenticatedRequest<ApiProduct>("/products", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      category_id: payload.categoryId || null,
      price: payload.price,
      sale_price: payload.salePrice ?? null,
      stock: payload.stock,
      status: payload.status,
      colors: payload.colors ?? [],
      sizes: payload.sizes ?? [],
      variants: payload.variants ?? [],
      images: payload.images ?? [],
      details: payload.details ?? {},
      tags: payload.tags ?? "",
      description: payload.description ?? "",
      product_story: payload.product_story ?? "",
      auto_generate_sku: payload.autoGenerateSku === true,
    }),
  });
}

export async function updateProduct(id: string, payload: ProductWriteInput) {
  return authenticatedRequest<ApiProduct>(`/products/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      category_id: payload.categoryId || null,
      price: payload.price,
      sale_price: payload.salePrice ?? null,
      stock: payload.stock,
      status: payload.status,
      colors: payload.colors ?? [],
      sizes: payload.sizes ?? [],
      variants: payload.variants ?? [],
      images: payload.images ?? [],
      details: payload.details ?? {},
      tags: payload.tags ?? "",
      description: payload.description ?? "",
      product_story: payload.product_story ?? "",
      auto_generate_sku: payload.autoGenerateSku === true,
    }),
  });
}

export async function bulkUpdateProducts(payload: {
  ids: string[];
  action: "status" | "category" | "delete";
  status?: ProductStatus;
  categoryId?: string;
}) {
  return authenticatedRequest<{
    ok: boolean;
    action: string;
    affectedCount: number;
    products: Array<Pick<ApiProduct, "id" | "name" | "status" | "category_id">>;
  }>("/products/bulk", {
    method: "POST",
    body: JSON.stringify({
      ids: payload.ids,
      action: payload.action,
      status: payload.status,
      category_id: payload.categoryId || null,
    }),
  });
}

export async function deleteProduct(id: string) {
  return authenticatedRequest<void>(`/products/${id}`, {
    method: "DELETE",
  });
}
