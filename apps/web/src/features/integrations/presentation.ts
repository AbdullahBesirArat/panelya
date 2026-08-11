import type {
  ApiKey, DeliveryStatus, WebhookDelivery, WebhookEndpoint, WebhookStatus,
} from "@/lib/api/integrations";

// Pure presentation helpers for the integrations section, so the rules that decide what a
// tenant is told can be tested without rendering anything.
//
// Nothing here decides what is ALLOWED — the server does. What these do decide is what a
// state means to a human, and that has to be unambiguous: "this key still works" and "this
// key stopped working an hour ago" must never render the same way.

export type KeyState = "active" | "rotating" | "expired" | "overlap_ended" | "revoked";

/**
 * The effective state of a key, which is not the same as its stored status. A key can be
 * `active` in the database and still be refused by authentication because its expiry or its
 * rotation overlap has passed — showing it as simply "active" would be a lie the tenant
 * would debug for an hour.
 */
export function keyState(key: Pick<ApiKey, "status" | "expires_at" | "overlap_until">, now = Date.now()): KeyState {
  if (key.status === "revoked") return "revoked";
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return "expired";
  if (key.overlap_until) {
    return new Date(key.overlap_until).getTime() <= now ? "overlap_ended" : "rotating";
  }
  return "active";
}

const KEY_STATE_LABELS: Record<KeyState, string> = {
  active: "Aktif",
  rotating: "Döndürülüyor (eski anahtar hâlâ geçerli)",
  expired: "Süresi doldu",
  overlap_ended: "Geçiş süresi bitti",
  revoked: "İptal edildi",
};

export function keyStateLabel(state: KeyState) {
  return KEY_STATE_LABELS[state];
}

export function keyStateTone(state: KeyState): "mint" | "sun" | "coral" | "leaf" {
  if (state === "active") return "mint";
  if (state === "rotating") return "sun";
  if (state === "revoked") return "leaf";
  return "coral";
}

/** A key that authentication will refuse right now, whatever its stored status says. */
export function keyIsUsable(key: Pick<ApiKey, "status" | "expires_at" | "overlap_until">, now = Date.now()) {
  const state = keyState(key, now);
  return state === "active" || state === "rotating";
}

const WEBHOOK_STATUS_LABELS: Record<WebhookStatus, string> = {
  active: "Aktif",
  disabled: "Devre dışı",
  archived: "Arşivlendi",
};

export function webhookStatusLabel(status: WebhookStatus) {
  return WEBHOOK_STATUS_LABELS[status];
}

export function webhookStatusTone(status: WebhookStatus): "mint" | "sun" | "coral" | "leaf" {
  if (status === "active") return "mint";
  if (status === "disabled") return "coral";
  return "leaf";
}

const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Sırada",
  processing: "Gönderiliyor",
  retry: "Yeniden denenecek",
  delivered: "Teslim edildi",
  dead_letter: "Başarısız (ölü mektup)",
  cancelled: "İptal edildi",
};

export function deliveryStatusLabel(status: DeliveryStatus) {
  return DELIVERY_STATUS_LABELS[status];
}

export function deliveryStatusTone(status: DeliveryStatus): "mint" | "sun" | "coral" | "leaf" {
  if (status === "delivered") return "mint";
  if (status === "retry" || status === "processing" || status === "pending") return "sun";
  if (status === "dead_letter") return "coral";
  return "leaf";
}

/** Only a delivery the worker has stopped pursuing is worth a manual retry. */
export function canRetryDelivery(delivery: Pick<WebhookDelivery, "status">) {
  return ["dead_letter", "retry", "cancelled"].includes(delivery.status);
}

/**
 * Endpoints the platform switched off after repeated failures, so the admin can surface
 * them rather than leaving a tenant wondering why events stopped.
 */
export function autoDisabledEndpoints(endpoints: WebhookEndpoint[]) {
  return endpoints.filter((endpoint) => endpoint.status === "disabled" && endpoint.consecutive_failures > 0);
}

const ERROR_MESSAGES: Record<string, string> = {
  API_KEY_SCOPES_REQUIRED: "En az bir yetki seçmelisiniz.",
  API_KEY_SCOPE_UNKNOWN: "Seçilen yetki tanınmıyor. Sayfayı yenileyip tekrar deneyin.",
  API_KEY_NAME_REQUIRED: "Anahtar için bir ad girin.",
  API_KEY_IP_INVALID: "IP veya CIDR biçimi geçersiz. Örnek: 203.0.113.7 veya 203.0.113.0/24",
  API_KEY_IP_ALLOWLIST_TOO_LARGE: "IP listesi en fazla 50 girdi içerebilir.",
  API_KEY_EXPIRY_PAST: "Geçerlilik tarihi gelecekte olmalı.",
  API_KEY_EXPIRY_INVALID: "Geçerlilik tarihi okunamadı.",
  API_KEY_NOT_ACTIVE: "İptal edilmiş bir anahtar döndürülemez.",
  API_KEY_ALREADY_ROTATED: "Bu anahtar zaten döndürülmüş. Listeyi yenileyin.",
  WEBHOOK_NAME_REQUIRED: "Webhook için bir ad girin.",
  WEBHOOK_URL_REQUIRED: "Webhook adresi zorunlu.",
  WEBHOOK_URL_NOT_HTTPS: "Webhook adresi https:// ile başlamalı.",
  WEBHOOK_URL_PRIVATE_ADDRESS: "Bu adres özel/dahili bir ağı işaret ediyor ve kullanılamaz.",
  WEBHOOK_URL_PORT_NOT_ALLOWED: "Yalnızca 443 portu kullanılabilir.",
  WEBHOOK_URL_HAS_CREDENTIALS: "Adres kullanıcı adı/parola içeremez.",
  WEBHOOK_URL_HAS_FRAGMENT: "Adres # ile başlayan bir parça içeremez.",
  WEBHOOK_URL_INVALID: "Webhook adresi geçersiz.",
  WEBHOOK_EVENTS_REQUIRED: "En az bir olay seçmelisiniz.",
  WEBHOOK_EVENT_UNKNOWN: "Seçilen olay tanınmıyor. Sayfayı yenileyip tekrar deneyin.",
  WEBHOOK_NOT_FOUND: "Webhook bulunamadı.",
  WEBHOOK_ENDPOINT_NOT_ACTIVE: "Devre dışı bir webhook'a test gönderilemez.",
  WEBHOOK_DELIVERY_NOT_RETRYABLE: "Bu teslimat yeniden denenemez.",
  WEBHOOK_ENCRYPTION_NOT_CONFIGURED: "Webhook imza anahtarı sunucuda yapılandırılmamış.",
  PLAN_LIMIT_REACHED: "Plan limitinize ulaştınız. Planınızı yükseltebilirsiniz.",
};

export function integrationErrorMessage(code: string | null | undefined, fallback: string) {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback || "İşlem tamamlanamadı.";
}

/**
 * Splits a textarea of IP entries. Empty input means an UNRESTRICTED key, which is a real
 * choice and not an error — the backend treats an empty allowlist the same way.
 */
export function parseIpAllowlist(input: string): string[] {
  return String(input || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Groups the event catalogue by prefix so the picker is scannable rather than a wall. */
export function groupEvents(events: string[]): Array<{ group: string; items: string[] }> {
  const order: string[] = [];
  const groups: Record<string, string[]> = {};
  for (const event of events) {
    const [group] = event.split(".");
    if (!groups[group]) {
      groups[group] = [];
      order.push(group);
    }
    groups[group].push(event);
  }
  return order.map((group) => ({ group, items: groups[group] }));
}

export function deliveryFilterKey(endpointId: number | null, status: string) {
  return `${endpointId ?? "all"}:${status || "all"}`;
}
