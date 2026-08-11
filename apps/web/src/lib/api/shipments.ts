import { authenticatedRequest, buildQuery } from "./core";

export type ShipmentStatus =
  | "pending" | "label_ready" | "shipped" | "in_transit"
  | "delivered" | "failed" | "cancelled" | "returned";

export type ApiShipmentItem = {
  id: string;
  order_item_id: string;
  quantity: number;
  product_name: string;
  selected_color: string;
  selected_size: string;
  sku: string;
  ordered_quantity: number;
};

export type ApiShipment = {
  id: string;
  order_id: string;
  order_code: string;
  provider: string;
  status: ShipmentStatus;
  carrier_name: string;
  service_name: string;
  tracking_number: string;
  tracking_url: string;
  package_weight_kg: number;
  package_desi: number;
  estimated_delivery_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  return_of_shipment_id: string | null;
  item_quantity?: number;
  created_at: string;
  items: ApiShipmentItem[];
  events: Array<{
    id: string;
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    public_message: string | null;
    created_at: string;
  }>;
  labels: Array<{
    id: string;
    filename: string;
    content_type: string;
    created_at: string;
  }>;
};

export type ShippingProfileRow = {
  profile_id: string;
  profile_name: string;
  provider: string;
  is_default: boolean;
  profile_active: boolean;
  zone_id: string | null;
  zone_name: string | null;
  cities: string[] | null;
  rule_id: string | null;
  rate_id: string | null;
  rate_name: string | null;
  calculation_type: string | null;
  amount: number | null;
  per_kg_amount: number | null;
  free_shipping_threshold: number | null;
};

export function fetchShipments(filters: { status?: string; order_id?: string } = {}) {
  return authenticatedRequest<ApiShipment[]>(`/shipments${buildQuery(filters)}`);
}

export function fetchShipmentDetail(id: string) {
  return authenticatedRequest<ApiShipment>(`/shipments/${id}`);
}

export function createShipment(payload: {
  orderId: number;
  provider: "manual";
  carrierName: string;
  serviceName?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  items: Array<{ orderItemId: number; quantity: number }>;
  package: { weightKg: number; lengthCm: number; widthCm: number; heightCm: number; desi: number };
}) {
  return authenticatedRequest<ApiShipment>("/shipments", { method: "POST", body: JSON.stringify(payload) });
}

export function updateShipmentStatus(id: string, payload: {
  status: ShipmentStatus;
  trackingNumber?: string;
  trackingUrl?: string;
  publicMessage?: string;
}) {
  return authenticatedRequest<ApiShipment>(`/shipments/${id}/status`, { method: "POST", body: JSON.stringify(payload) });
}

export function cancelShipment(id: string) {
  return authenticatedRequest<ApiShipment>(`/shipments/${id}/cancel`, { method: "POST", body: "{}" });
}

export function createReturnShipment(source: ApiShipment) {
  return authenticatedRequest<ApiShipment>(`/shipments/${source.id}/return`, {
    method: "POST",
    body: JSON.stringify({
      orderId: Number(source.order_id), provider: "manual", carrierName: source.carrier_name || "Manual Kargo",
      serviceName: "Iade", items: source.items.map((item) => ({ orderItemId: Number(item.order_item_id), quantity: Number(item.quantity) })),
      package: { weightKg: Number(source.package_weight_kg || 0), lengthCm: 0, widthCm: 0, heightCm: 0, desi: Number(source.package_desi || 0) },
    }),
  });
}

export function attachShipmentLabel(id: string, uploadAssetId: string) {
  return authenticatedRequest<ApiShipment["labels"][number]>(`/shipments/${id}/labels`, {
    method: "POST",
    body: JSON.stringify({ uploadAssetId }),
  });
}

export function fetchShippingProfiles() {
  return authenticatedRequest<ShippingProfileRow[]>("/shipments/profiles");
}

export async function createFlatShippingProfile(payload: {
  name: string;
  cities: string[];
  calculationType: "flat" | "free_threshold" | "weight_band";
  amount: number;
  perKgAmount: number;
  freeShippingThreshold: number | null;
  maxWeightKg: number | null;
}) {
  const profile = await authenticatedRequest<{ id: string }>("/shipments/profiles", {
    method: "POST", body: JSON.stringify({ name: payload.name, provider: "manual", is_default: true }),
  });
  const zone = await authenticatedRequest<{ id: string }>(`/shipments/profiles/${profile.id}/zones`, {
    method: "POST", body: JSON.stringify({ name: payload.cities.length ? "Secili sehirler" : "Tum Turkiye", countries: ["TR"], cities: payload.cities }),
  });
  const rule = await authenticatedRequest<{ id: string }>(`/shipments/zones/${zone.id}/rules`, {
    method: "POST", body: JSON.stringify({ max_weight_kg: payload.maxWeightKg }),
  });
  return authenticatedRequest(`/shipments/rules/${rule.id}/rates`, {
    method: "POST",
    body: JSON.stringify({
      name: payload.name, calculation_type: payload.calculationType, amount: payload.amount,
      per_kg_amount: payload.perKgAmount, free_shipping_threshold: payload.freeShippingThreshold,
    }),
  });
}
