import { authenticatedRequest } from "./core";

export type GiftWrapOption = {
  id: number;
  title: string;
  description: string;
  fee: number;
  currency: string;
  media_id: string | null;
  is_active: boolean;
  sort_order: number;
};

export type GiftWrapOptionInput = {
  title: string;
  description?: string;
  fee: number;
  media_id?: string | null;
  is_active?: boolean;
  sort_order?: number;
};

export function fetchGiftWrapOptions() {
  return authenticatedRequest<{ items: GiftWrapOption[] }>("/operations/gift-wrap");
}

export function createGiftWrapOption(input: GiftWrapOptionInput) {
  return authenticatedRequest<{ option: GiftWrapOption }>("/operations/gift-wrap", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateGiftWrapOption(id: number, input: GiftWrapOptionInput) {
  return authenticatedRequest<{ option: GiftWrapOption }>(`/operations/gift-wrap/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

// Deactivating is the safe way to retire a wrap: live carts drop it on their next
// reprice and historical orders keep their own snapshot.
export function setGiftWrapOptionActive(id: number, isActive: boolean) {
  return authenticatedRequest<{ option: GiftWrapOption }>(`/operations/gift-wrap/${id}/active`, {
    method: "POST",
    body: JSON.stringify({ is_active: isActive }),
  });
}

export function deleteGiftWrapOption(id: number) {
  return authenticatedRequest<{ ok: boolean }>(`/operations/gift-wrap/${id}`, { method: "DELETE" });
}
