import { authenticatedRequest } from "./core";
import type { ApiCoupon, ApiCouponRedemption, PromotionPricing } from "./types";

export type CouponWriteInput = {
  code: string;
  name: string;
  internalDescription?: string;
  discountType: ApiCoupon["discount_type"];
  value: number;
  minimumSubtotal?: number;
  maximumDiscount?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  totalUsageLimit?: number | null;
  perCustomerLimit?: number | null;
  firstOrderOnly?: boolean;
  status: ApiCoupon["status"];
  stackingPolicy: ApiCoupon["stacking_policy"];
  priority?: number;
  includeProductIds?: number[];
  excludeProductIds?: number[];
  includeCategoryIds?: number[];
  excludeCategoryIds?: number[];
  includeCollectionIds?: number[];
  excludeCollectionIds?: number[];
};

export function fetchCoupons() {
  return authenticatedRequest<ApiCoupon[]>("/coupons/admin/all");
}

export function createCoupon(payload: CouponWriteInput) {
  return authenticatedRequest<ApiCoupon>("/coupons", { method: "POST", body: JSON.stringify(payload) });
}

export function updateCoupon(id: string, payload: CouponWriteInput) {
  return authenticatedRequest<ApiCoupon>(`/coupons/${id}`, { method: "PUT", body: JSON.stringify(payload) });
}

export function deactivateCoupon(id: string) {
  return authenticatedRequest<void>(`/coupons/${id}`, { method: "DELETE" });
}

export function fetchCouponRedemptions(id: string) {
  return authenticatedRequest<ApiCouponRedemption[]>(`/coupons/${id}/redemptions`);
}

export function previewCoupon(payload: {
  code: string;
  items: Array<{ product_id: number; variant_id?: number | null; quantity: number }>;
}) {
  return authenticatedRequest<{ pricing: PromotionPricing }>("/coupons/preview", {
    method: "POST",
    body: JSON.stringify({ couponCode: payload.code, items: payload.items }),
  });
}
