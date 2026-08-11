import { authenticatedRequest, buildQuery } from "./core";

export type ReturnRequestType = "return" | "exchange" | "cancellation";
export type ReturnRequestStatus =
  | "requested" | "approved" | "rejected" | "awaiting_shipment"
  | "in_transit" | "received" | "inspected" | "resolved" | "cancelled";

export type ApiReturnItem = {
  id: string;
  order_item_id: string;
  quantity: number;
  reason_code: string;
  item_condition: string | null;
  requested_resolution: "refund" | "exchange" | "store_credit";
  received_quantity: number;
  restock_quantity: number;
  replacement_variant_id: string | null;
  product_name: string;
  selected_color: string;
  selected_size: string;
  sku: string;
  unit_price: number;
  product_id: string;
  variant_id: string | null;
};

export type ApiReturnRequest = {
  id: string;
  order_id: string;
  order_code: string;
  order_total: number;
  request_type: ReturnRequestType;
  status: ReturnRequestStatus;
  reason_code: string;
  customer_note: string;
  internal_note: string;
  customer_name?: string;
  customer_email?: string;
  item_count?: number;
  requested_at: string;
  return_deadline: string | null;
  return_shipping_code: string | null;
  return_instructions: string | null;
  rejection_reason: string | null;
  resolution: string | null;
  replacement_order_id: string | null;
  items: ApiReturnItem[];
  refunds: Array<{
    id: string;
    provider: string;
    amount: number;
    currency: string;
    status: string;
    provider_ref: string | null;
    reason: string;
    requested_at: string;
    processed_at: string | null;
  }>;
  events: Array<{
    id: string;
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    actor_type: string;
    public_message: string | null;
    created_at: string;
  }>;
};

export async function fetchReturns(filters: { status?: string; type?: string } = {}) {
  return authenticatedRequest<ApiReturnRequest[]>(`/returns${buildQuery(filters)}`);
}

export async function fetchReturnDetail(id: string) {
  return authenticatedRequest<ApiReturnRequest>(`/returns/${id}`);
}

export async function decideReturn(id: string, payload: {
  status: "approved" | "rejected";
  rejectionReason?: string;
  publicMessage?: string;
  internalNote?: string;
  returnShippingCode?: string;
  returnInstructions?: string;
  replacements?: Array<{ returnItemId: string; variantId: string }>;
}) {
  return authenticatedRequest<ApiReturnRequest>(`/returns/${id}/decision`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function receiveReturn(id: string, payload: {
  publicMessage?: string;
  internalNote?: string;
  items: Array<{
    returnItemId: string;
    receivedQuantity: number;
    restockQuantity: number;
    condition: string;
  }>;
}) {
  return authenticatedRequest<ApiReturnRequest>(`/returns/${id}/receive`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function refundReturn(id: string, payload: {
  idempotencyKey: string;
  provider: "manual";
  refundShipping: boolean;
  reason: string;
  items: Array<{ orderItemId: string; quantity: number }>;
}) {
  return authenticatedRequest<{
    refund: ApiReturnRequest["refunds"][number];
    quote?: { amount: number; currency: string };
    replay: boolean;
  }>(`/returns/${id}/refunds`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
