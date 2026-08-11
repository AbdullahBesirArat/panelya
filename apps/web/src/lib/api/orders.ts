import { authenticatedRequest, buildQuery } from "./core";
import type {
  ApiOrder,
  ApiOrderDetail,
  ApiOrderNote,
  ApiOrderTag,
  FulfillmentStatus,
  OrderLifecycleStatus,
  OrderOperationsMetadata,
  PaymentStatus,
} from "./types";

export type OrderStateDomain = "order" | "payment" | "fulfillment";
export type OrderStateValue =
  OrderLifecycleStatus | PaymentStatus | FulfillmentStatus;

export async function fetchOrders(
  filters: {
    q?: string;
    orderStatus?: OrderLifecycleStatus | "";
    paymentStatus?: PaymentStatus | "";
    fulfillmentStatus?: FulfillmentStatus | "";
    assignedTo?: string;
    tagId?: string;
    limit?: number;
    offset?: number;
  } = {},
  signal?: AbortSignal,
) {
  return authenticatedRequest<ApiOrder[]>(
    `/orders${buildQuery({
      q: filters.q,
      orderStatus: filters.orderStatus,
      paymentStatus: filters.paymentStatus,
      fulfillmentStatus: filters.fulfillmentStatus,
      assignedTo: filters.assignedTo,
      tagId: filters.tagId,
      limit: filters.limit,
      offset: filters.offset,
    })}`,
    { signal },
  );
}

export async function fetchOrderDetail(id: string) {
  return authenticatedRequest<ApiOrderDetail>(`/orders/${id}`);
}

export async function fetchOrderOperationsMetadata() {
  return authenticatedRequest<OrderOperationsMetadata>(
    "/orders/operations/metadata",
  );
}

export async function transitionOrder(
  id: string,
  payload: {
    domain: OrderStateDomain;
    status: OrderStateValue;
    version: number;
    publicMessage?: string;
  },
) {
  return authenticatedRequest<ApiOrder>(`/orders/${id}/transitions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function previewBulkOrderTransition(payload: {
  orderIds: string[];
  domain: OrderStateDomain;
  status: OrderStateValue;
}) {
  return authenticatedRequest<{
    total: number;
    validCount: number;
    results: Array<{
      id: string;
      orderCode?: string;
      version?: number;
      fromStatus?: string;
      toStatus?: string;
      valid: boolean;
      code?: string;
      error?: string;
    }>;
  }>("/orders/bulk-status/preview", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function applyBulkOrderTransition(payload: {
  orders: Array<{ id: string; version: number }>;
  domain: OrderStateDomain;
  status: OrderStateValue;
}) {
  return authenticatedRequest<{
    total: number;
    successCount: number;
    failureCount: number;
    results: Array<{
      id: string;
      ok: boolean;
      order?: ApiOrder;
      code?: string;
      error?: string;
    }>;
  }>("/orders/bulk-status", { method: "POST", body: JSON.stringify(payload) });
}

export async function createOrderNote(
  id: string,
  payload: { visibility: "internal" | "customer"; content: string },
) {
  return authenticatedRequest<ApiOrderNote>(`/orders/${id}/notes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteOrderNote(id: string, noteId: string) {
  return authenticatedRequest<{ ok: boolean; id: string }>(
    `/orders/${id}/notes/${noteId}`,
    { method: "DELETE" },
  );
}

export async function createOrderTag(payload: { name: string; color: string }) {
  return authenticatedRequest<ApiOrderTag>("/orders/operations/tags", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function replaceOrderTags(id: string, tagIds: string[]) {
  return authenticatedRequest<ApiOrderTag[]>(`/orders/${id}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tagIds }),
  });
}

export async function updateOrderAssignment(
  id: string,
  assignedUserId: string | null,
) {
  return authenticatedRequest<{ assignment: ApiOrder["assignment"] }>(
    `/orders/${id}/assignment`,
    {
      method: "PUT",
      body: JSON.stringify({ assignedUserId }),
    },
  );
}

export async function updateOrderShipping(
  id: string,
  payload: {
    version: number;
    shippingCompany?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    shippedAt?: string | null;
  },
) {
  return authenticatedRequest<ApiOrder>(`/orders/${id}/shipping`, {
    method: "PUT",
    body: JSON.stringify({
      version: payload.version,
      shipping_company: payload.shippingCompany || "",
      tracking_number: payload.trackingNumber || "",
      tracking_url: payload.trackingUrl || "",
      shipped_at: payload.shippedAt || null,
    }),
  });
}
