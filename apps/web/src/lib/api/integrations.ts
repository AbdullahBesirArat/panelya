import { authenticatedRequest } from "./core";

// Types mirror panelya-api/routes/integrations.js and modules/integrations/*.
//
// Two shapes deliberately have no secret field, and adding one would be a bug rather than a
// feature: `ApiKey` and `WebhookEndpoint` are what list and detail return, and the backend
// never puts a secret in them. A secret appears only in the one-time create/rotate response
// types below, which is the only moment it exists outside the caller's own storage.

export type ApiKeyStatus = "active" | "revoked";

export type ApiKey = {
  id: number;
  name: string;
  /** Public half of the credential; safe to display and to log. */
  prefix: string;
  scopes: string[];
  status: ApiKeyStatus;
  ip_allowlist: string[];
  expires_at: string | null;
  /** Set while a rotated predecessor is still accepted; after it, auth refuses the key. */
  overlap_until: string | null;
  rotated_from_id: number | null;
  rotation_group_id: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The ONLY shape that carries a secret. Shown once, never fetched again. */
export type ApiKeyCreated = { key: ApiKey; token: string };
export type ApiKeyRotated = {
  key: ApiKey;
  token: string;
  previous: ApiKey;
  overlapMinutes: number;
};

export type WebhookStatus = "active" | "disabled" | "archived";

export type WebhookEndpoint = {
  id: number;
  name: string;
  url: string;
  status: WebhookStatus;
  events: string[];
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  /** Version number only. The ciphertext never leaves the server. */
  secret_version: number | null;
  created_at: string;
  updated_at: string;
};

export type WebhookCreated = { endpoint: WebhookEndpoint; secret: string };
export type WebhookSecretRotated = { secret: string; version: number };

export type DeliveryStatus =
  | "pending" | "processing" | "retry" | "delivered" | "dead_letter" | "cancelled";

export type WebhookDelivery = {
  id: number;
  event_id: string | null;
  event_type: string | null;
  endpoint_id: number;
  attempt: number;
  max_attempts: number;
  status: DeliveryStatus;
  response_status: number | null;
  duration_ms: number | null;
  error_code: string | null;
  /** Already bounded and redacted server-side; a receiver's body is untrusted input. */
  error_detail: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
};

export type IntegrationMeta = {
  scopes: Array<{ value: string; label: string }>;
  events: string[];
};

export function fetchIntegrationMeta() {
  return authenticatedRequest<IntegrationMeta>("/integrations/meta");
}

export function fetchApiKeys() {
  return authenticatedRequest<{ items: ApiKey[] }>("/integrations/api-keys");
}

export function createApiKey(input: {
  name: string;
  scopes: string[];
  ipAllowlist?: string[];
  expiresAt?: string | null;
}) {
  return authenticatedRequest<ApiKeyCreated>("/integrations/api-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Rotation returns a new secret and keeps the old key working for `overlapMinutes`, so an
 * integration can be redeployed without a broken window.
 */
export function rotateApiKey(keyId: number, overlapMinutes?: number) {
  return authenticatedRequest<ApiKeyRotated>(`/integrations/api-keys/${keyId}/rotate`, {
    method: "POST",
    body: JSON.stringify(overlapMinutes ? { overlapMinutes } : {}),
  });
}

export function revokeApiKey(keyId: number) {
  return authenticatedRequest<{ key: ApiKey }>(`/integrations/api-keys/${keyId}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function fetchWebhookEndpoints() {
  return authenticatedRequest<{ items: WebhookEndpoint[] }>("/integrations/webhooks");
}

export function createWebhookEndpoint(input: { name: string; url: string; events: string[] }) {
  return authenticatedRequest<WebhookCreated>("/integrations/webhooks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateWebhookEndpoint(
  endpointId: number,
  input: { name?: string; url?: string; events?: string[] }
) {
  return authenticatedRequest<{ endpoint: WebhookEndpoint }>(`/integrations/webhooks/${endpointId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function setWebhookStatus(endpointId: number, status: WebhookStatus, reason?: string) {
  return authenticatedRequest<{ endpoint: WebhookEndpoint }>(`/integrations/webhooks/${endpointId}/status`, {
    method: "POST",
    body: JSON.stringify({ status, reason }),
  });
}

export function rotateWebhookSecret(endpointId: number) {
  return authenticatedRequest<WebhookSecretRotated>(`/integrations/webhooks/${endpointId}/rotate-secret`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/**
 * Enqueues a real delivery of a `webhook.test` event. It goes through the same signing,
 * SSRF and retry pipeline a production event does, so a passing test proves the real path.
 */
export function sendWebhookTest(endpointId: number) {
  return authenticatedRequest<{ delivery: WebhookDelivery }>(`/integrations/webhooks/${endpointId}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function fetchDeliveries(params: { endpointId?: number; status?: string; limit?: number } = {}) {
  const query = new URLSearchParams();
  if (params.endpointId) query.set("endpointId", String(params.endpointId));
  if (params.status) query.set("status", params.status);
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return authenticatedRequest<{ items: WebhookDelivery[] }>(`/integrations/deliveries${suffix}`);
}

/** Re-queues an existing delivery. It never creates a second business event. */
export function retryDelivery(deliveryId: number, reason?: string) {
  return authenticatedRequest<{ delivery: WebhookDelivery }>(`/integrations/deliveries/${deliveryId}/retry`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
