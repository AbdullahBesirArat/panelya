import { authenticatedRequest } from "./core";

export type CartStatus = "active" | "abandoned" | "converted" | "expired" | "merged" | "cancelled";

export type CartSummary = {
  id: string;
  status: CartStatus;
  version: number;
  item_count: number;
  subtotal: number;
  discount_total: number;
  grand_total: number;
  currency: string;
  coupon_code: string | null;
  is_customer: boolean;
  contact_email: string | null;
  customer_email: string | null;
  customer_name: string | null;
  recovery_consent: boolean;
  recovery_sent_count: number;
  last_activity_at: string;
  abandoned_at: string | null;
  recovered_at: string | null;
  converted_order_id: number | null;
  created_at: string;
};

export type CartMetrics = {
  active: number;
  abandoned: number;
  converted: number;
  recovered: number;
  abandoned_value: number;
};

export type CartItemRow = {
  product_id: number;
  variant_id: number;
  quantity: number;
  unit_price_snapshot: number;
  line_total_snapshot: number;
  product_name_snapshot: string;
  sku_snapshot: string;
  color_snapshot: string;
  size_snapshot: string;
};

export type CartEventRow = { event_type: string; metadata: Record<string, unknown>; occurred_at: string };
export type CartRecoveryRow = {
  id: number; channel: string; status: string; attempts: number;
  sent_at: string | null; suppressed_reason: string | null; recovery_expires_at: string | null; created_at: string;
};

export type CartDetail = {
  cart: CartSummary & { recovery_consent: boolean };
  items: CartItemRow[];
  events: CartEventRow[];
  recovery: CartRecoveryRow[];
};

export type CartFilters = { status?: string; owner?: string; search?: string };

function query(filters: CartFilters) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.search) params.set("search", filters.search);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function fetchCarts(filters: CartFilters = {}, signal?: AbortSignal) {
  return authenticatedRequest<CartSummary[]>(`/operations/carts${query(filters)}`, { signal });
}

export function fetchCartMetrics() {
  return authenticatedRequest<CartMetrics>("/operations/carts/metrics");
}

export function fetchCart(id: string) {
  return authenticatedRequest<CartDetail>(`/operations/carts/${id}`);
}

export function cancelCart(id: string, reason: string) {
  return authenticatedRequest<{ id: string; status: CartStatus }>(`/operations/carts/${id}/cancel`, {
    method: "POST", body: JSON.stringify({ reason }),
  });
}

export function suppressReminders(id: string) {
  return authenticatedRequest<{ suppressed: number }>(`/operations/carts/${id}/suppress`, {
    method: "POST", body: JSON.stringify({}),
  });
}

export function generateRecoveryLink(id: string) {
  return authenticatedRequest<{ recovery_token: string; expires_in_hours: number }>(
    `/operations/carts/${id}/recovery-link`,
    { method: "POST", body: JSON.stringify({}) }
  );
}
