import { authenticatedRequest } from "./core";

export type CountRow = { status?: string; channel?: string; purpose?: string; subscription_type?: string; count: number };

export type NotificationOverview = {
  consents: CountRow[];
  subscriptions: CountRow[];
  outbox: CountRow[];
  deliveries: CountRow[];
  suppressions: CountRow[];
};

export type OutboxRow = {
  id: number;
  event_type: string;
  channel: string;
  provider: string;
  recipient_masked: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryRow = {
  id: number;
  outbox_id: number;
  provider: string;
  provider_message_id: string | null;
  status: string;
  channel: string;
  event_type: string;
  recipient_masked: string;
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
};

export type SuppressionRow = {
  id: number;
  channel: string;
  reason: string;
  source: string;
  created_at: string;
  expires_at: string | null;
};

export type ProviderStatus = { channel: string; provider: string | null; mode: "test" | "configured" | "unconfigured" };
export type ProviderMetric = { provider: string; total: number; sent: number; failed: number; error_rate: number };

type Paged<T> = { items: T[]; page: number; pageSize: number };

export function fetchNotificationOverview() {
  return authenticatedRequest<NotificationOverview>("/operations/notifications/overview");
}

export function fetchNotificationOutbox(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return authenticatedRequest<Paged<OutboxRow>>(`/operations/notifications/outbox${query}`);
}

export function fetchNotificationDeliveries(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return authenticatedRequest<Paged<DeliveryRow>>(`/operations/notifications/deliveries${query}`);
}

export function fetchFailedNotifications() {
  return authenticatedRequest<Paged<OutboxRow>>("/operations/notifications/failed");
}

export function fetchNotificationSuppressions() {
  return authenticatedRequest<Paged<SuppressionRow>>("/operations/notifications/suppressions");
}

export function fetchNotificationProviders() {
  return authenticatedRequest<{ providers: ProviderStatus[] }>("/operations/notifications/providers");
}

export function fetchNotificationMetrics(windowDays = 7) {
  return authenticatedRequest<{ window_days: number; providers: ProviderMetric[] }>(
    `/operations/notifications/metrics?window_days=${encodeURIComponent(String(windowDays))}`
  );
}

export function retryNotification(id: number) {
  return authenticatedRequest<{ id: number; status: string }>(`/operations/notifications/outbox/${id}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function suppressRecipient(input: { channel: string; email?: string; phone?: string; reason?: string }) {
  return authenticatedRequest<{ channel: string; suppressed: boolean }>("/operations/notifications/suppressions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
