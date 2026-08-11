import { authenticatedRequest, publicRequest } from "./core";
import type { ApiBlogPost, ApiCampaign, ApiCollection, ApiSlide, ProductStatus } from "./types";

export async function fetchSlides() {
  return authenticatedRequest<ApiSlide[]>("/slider/admin/all");
}

export async function createSlide(payload: {
  tag?: string;
  title: string;
  sub?: string;
  btn?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiSlide>("/slider", {
    method: "POST",
    body: JSON.stringify({
      tag: payload.tag || "",
      title: payload.title,
      sub: payload.sub || "",
      btn: payload.btn || "Kesfet",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function updateSlide(id: string, payload: {
  tag?: string;
  title: string;
  sub?: string;
  btn?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiSlide>(`/slider/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      tag: payload.tag || "",
      title: payload.title,
      sub: payload.sub || "",
      btn: payload.btn || "Kesfet",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function deleteSlide(id: string) {
  return authenticatedRequest<void>(`/slider/${id}`, {
    method: "DELETE",
  });
}

export async function fetchCampaigns() {
  return authenticatedRequest<ApiCampaign[]>("/campaigns/admin/all");
}

export async function createCampaign(payload: {
  name: string;
  type: string;
  value: number;
  endDate?: string | null;
  active: boolean;
}) {
  return authenticatedRequest<ApiCampaign>("/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      type: payload.type,
      value: payload.value,
      end_date: payload.endDate || null,
      active: payload.active,
    }),
  });
}

export async function updateCampaign(id: string, payload: {
  name: string;
  type: string;
  value: number;
  endDate?: string | null;
  active: boolean;
}) {
  return authenticatedRequest<ApiCampaign>(`/campaigns/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      type: payload.type,
      value: payload.value,
      end_date: payload.endDate || null,
      active: payload.active,
    }),
  });
}

export async function deleteCampaign(id: string) {
  return authenticatedRequest<void>(`/campaigns/${id}`, {
    method: "DELETE",
  });
}

export async function fetchCollections() {
  return authenticatedRequest<ApiCollection[]>("/collections/admin/all");
}

export type CollectionProductMembership = {
  id: number;
  name: string;
  status: ProductStatus;
  tags: string;
  is_member: boolean;
};

export type CollectionProductsResponse = {
  collection: { id: number; slug: string; title: string };
  products: CollectionProductMembership[];
};

export async function fetchCollectionProducts(collectionId: number | string) {
  return authenticatedRequest<CollectionProductsResponse>(`/collections/${collectionId}/products`);
}

export async function updateCollectionProducts(collectionId: number | string, memberIds: Array<number | string>) {
  return authenticatedRequest<{ updated: number; memberCount: number }>(
    `/collections/${collectionId}/products`,
    {
      method: "PUT",
      body: JSON.stringify({ memberIds: memberIds.map((value) => Number(value)) }),
    }
  );
}

export async function createCollection(payload: {
  title: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  linkUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiCollection>("/collections", {
    method: "POST",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      description: payload.description || "",
      image_url: payload.imageUrl || "",
      link_url: payload.linkUrl || "urunler",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function updateCollection(id: string, payload: {
  title: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  linkUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiCollection>(`/collections/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      description: payload.description || "",
      image_url: payload.imageUrl || "",
      link_url: payload.linkUrl || "urunler",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function deleteCollection(id: string) {
  return authenticatedRequest<void>(`/collections/${id}`, {
    method: "DELETE",
  });
}

export async function fetchBlogPosts() {
  return authenticatedRequest<ApiBlogPost[]>("/blog/admin/all");
}

export async function fetchBlogPost(idOrSlug: string) {
  return publicRequest<ApiBlogPost>(`/blog/${encodeURIComponent(idOrSlug)}`);
}

export async function createBlogPost(payload: {
  title: string;
  slug?: string;
  excerpt?: string;
  content?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
  publishedAt?: string | null;
}) {
  return authenticatedRequest<ApiBlogPost>("/blog", {
    method: "POST",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      excerpt: payload.excerpt || "",
      content: payload.content || "",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
      published_at: payload.publishedAt || null,
    }),
  });
}

export async function updateBlogPost(id: string, payload: {
  title: string;
  slug?: string;
  excerpt?: string;
  content?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
  publishedAt?: string | null;
}) {
  return authenticatedRequest<ApiBlogPost>(`/blog/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      excerpt: payload.excerpt || "",
      content: payload.content || "",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
      published_at: payload.publishedAt || null,
    }),
  });
}

export async function deleteBlogPost(id: string) {
  return authenticatedRequest<void>(`/blog/${id}`, {
    method: "DELETE",
  });
}
