import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  autoDisabledEndpoints, canRetryDelivery, deliveryFilterKey, deliveryStatusLabel,
  deliveryStatusTone, groupEvents, integrationErrorMessage, keyIsUsable, keyState,
  keyStateLabel, keyStateTone, parseIpAllowlist, webhookStatusLabel, webhookStatusTone,
} from "../src/features/integrations/presentation";
import type { DeliveryStatus, WebhookEndpoint, WebhookStatus } from "../src/lib/api/integrations";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("a key past its expiry is not shown as active, whatever the stored status says", () => {
  // The database says 'active' but authentication will refuse it. Rendering "Aktif" here is
  // the difference between a five-second fix and an afternoon of debugging.
  assert.equal(keyState({ status: "active", expires_at: iso(-3600_000), overlap_until: null }, NOW), "expired");
  assert.equal(keyState({ status: "active", expires_at: iso(3600_000), overlap_until: null }, NOW), "active");
  assert.equal(keyState({ status: "active", expires_at: null, overlap_until: null }, NOW), "active");
  assert.equal(keyState({ status: "revoked", expires_at: null, overlap_until: null }, NOW), "revoked");
  // Revocation wins over everything: a revoked key is revoked even if it also expired.
  assert.equal(keyState({ status: "revoked", expires_at: iso(-1), overlap_until: iso(-1) }, NOW), "revoked");
});

test("a rotating key is distinguished from one whose overlap has ended", () => {
  assert.equal(keyState({ status: "active", expires_at: null, overlap_until: iso(1800_000) }, NOW), "rotating");
  assert.equal(keyState({ status: "active", expires_at: null, overlap_until: iso(-1000) }, NOW), "overlap_ended");
  assert.notEqual(keyStateLabel("rotating"), keyStateLabel("overlap_ended"));
  // "still works" vs "stopped working" must never read the same.
  assert.equal(keyIsUsable({ status: "active", expires_at: null, overlap_until: iso(1800_000) }, NOW), true);
  assert.equal(keyIsUsable({ status: "active", expires_at: null, overlap_until: iso(-1000) }, NOW), false);
  assert.equal(keyIsUsable({ status: "active", expires_at: iso(-1000), overlap_until: null }, NOW), false);
  assert.equal(keyIsUsable({ status: "revoked", expires_at: null, overlap_until: null }, NOW), false);
});

test("every key state has a distinct label and a tone that matches its severity", () => {
  const states = ["active", "rotating", "expired", "overlap_ended", "revoked"] as const;
  const labels = states.map(keyStateLabel);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every((label) => label.length > 0));
  assert.equal(keyStateTone("active"), "mint");
  assert.equal(keyStateTone("rotating"), "sun");
  assert.equal(keyStateTone("expired"), "coral");
  assert.equal(keyStateTone("overlap_ended"), "coral");
});

test("every webhook and delivery state is labelled and toned", () => {
  const webhookStatuses: WebhookStatus[] = ["active", "disabled", "archived"];
  const webhookLabels = webhookStatuses.map(webhookStatusLabel);
  assert.equal(new Set(webhookLabels).size, webhookLabels.length);
  assert.equal(webhookStatusTone("active"), "mint");
  assert.equal(webhookStatusTone("disabled"), "coral");

  const deliveryStatuses: DeliveryStatus[] = [
    "pending", "processing", "retry", "delivered", "dead_letter", "cancelled",
  ];
  const deliveryLabels = deliveryStatuses.map(deliveryStatusLabel);
  assert.equal(new Set(deliveryLabels).size, deliveryLabels.length);
  assert.equal(deliveryStatusTone("delivered"), "mint");
  assert.equal(deliveryStatusTone("dead_letter"), "coral");
  assert.equal(deliveryStatusTone("retry"), "sun");
});

test("only a delivery the worker has given up on offers a manual retry", () => {
  assert.equal(canRetryDelivery({ status: "dead_letter" }), true);
  assert.equal(canRetryDelivery({ status: "retry" }), true);
  assert.equal(canRetryDelivery({ status: "cancelled" }), true);
  // Re-sending a delivered event on a whim would tell the receiver it happened twice.
  assert.equal(canRetryDelivery({ status: "delivered" }), false);
  assert.equal(canRetryDelivery({ status: "pending" }), false);
  assert.equal(canRetryDelivery({ status: "processing" }), false);
});

test("endpoints the platform switched off are surfaced separately", () => {
  const endpoints = [
    { id: 1, status: "active", consecutive_failures: 0 },
    { id: 2, status: "disabled", consecutive_failures: 15 },
    { id: 3, status: "disabled", consecutive_failures: 0 },
  ] as WebhookEndpoint[];
  const disabled = autoDisabledEndpoints(endpoints);
  // Only the one the threshold disabled: id 3 was switched off by hand and needs no alarm.
  assert.deepEqual(disabled.map((endpoint) => endpoint.id), [2]);
});

test("integration errors map from backend codes, never from message text", () => {
  assert.match(integrationErrorMessage("WEBHOOK_URL_PRIVATE_ADDRESS", "boom"), /özel\/dahili/i);
  assert.match(integrationErrorMessage("WEBHOOK_URL_NOT_HTTPS", "boom"), /https/i);
  assert.match(integrationErrorMessage("API_KEY_IP_INVALID", "boom"), /CIDR/);
  assert.equal(integrationErrorMessage(null, "sunucu hatasi"), "sunucu hatasi");
  assert.equal(integrationErrorMessage(undefined, ""), "İşlem tamamlanamadı.");
  // A message that merely mentions a code is not a code.
  assert.equal(integrationErrorMessage(null, "WEBHOOK_URL_NOT_HTTPS oldu"), "WEBHOOK_URL_NOT_HTTPS oldu");
});

test("every error code the integration API can return has its own message", () => {
  const codes = [
    "API_KEY_SCOPES_REQUIRED", "API_KEY_SCOPE_UNKNOWN", "API_KEY_NAME_REQUIRED",
    "API_KEY_IP_INVALID", "API_KEY_EXPIRY_PAST", "API_KEY_NOT_ACTIVE", "API_KEY_ALREADY_ROTATED",
    "WEBHOOK_URL_NOT_HTTPS", "WEBHOOK_URL_PRIVATE_ADDRESS", "WEBHOOK_URL_PORT_NOT_ALLOWED",
    "WEBHOOK_URL_HAS_CREDENTIALS", "WEBHOOK_EVENTS_REQUIRED", "WEBHOOK_ENDPOINT_NOT_ACTIVE",
    "WEBHOOK_DELIVERY_NOT_RETRYABLE", "PLAN_LIMIT_REACHED",
  ];
  const messages = codes.map((code) => integrationErrorMessage(code, "fallback"));
  assert.equal(new Set(messages).size, messages.length, "no two codes may read the same");
  assert.ok(messages.every((message) => message !== "fallback"));
});

test("an empty IP list is an unrestricted key, not an error", () => {
  assert.deepEqual(parseIpAllowlist(""), []);
  assert.deepEqual(parseIpAllowlist("   "), []);
  assert.deepEqual(parseIpAllowlist("203.0.113.7"), ["203.0.113.7"]);
  assert.deepEqual(parseIpAllowlist("203.0.113.7, 198.51.100.0/24"), ["203.0.113.7", "198.51.100.0/24"]);
  assert.deepEqual(parseIpAllowlist("203.0.113.7\n198.51.100.1"), ["203.0.113.7", "198.51.100.1"]);
});

test("the event picker groups by aggregate and keeps every event reachable", () => {
  const events = ["order.created", "order.status_changed", "product.updated", "payment.paid"];
  const grouped = groupEvents(events);
  assert.deepEqual(grouped.map((entry) => entry.group), ["order", "product", "payment"]);
  assert.deepEqual(grouped[0].items, ["order.created", "order.status_changed"]);
  // Nothing may be dropped: an event the picker cannot show is an event a tenant cannot
  // subscribe to.
  assert.equal(grouped.flatMap((entry) => entry.items).length, events.length);
  assert.deepEqual(groupEvents([]), []);
});

test("delivery filters produce distinct cache keys", () => {
  assert.notEqual(deliveryFilterKey(1, "delivered"), deliveryFilterKey(1, "dead_letter"));
  assert.notEqual(deliveryFilterKey(1, "delivered"), deliveryFilterKey(2, "delivered"));
  assert.equal(deliveryFilterKey(null, ""), "all:all");
  assert.equal(deliveryFilterKey(1, "retry"), "1:retry");
});

/**
 * Comments explain what the code deliberately does NOT do, and they name the very APIs
 * these assertions look for. Stripping them keeps the checks about code rather than prose.
 */
function stripComments(source: string) {
  // Line comments go FIRST. One of them contains a path ending in `/*`, which a
  // block-comment pass would treat as an opener and swallow the declarations after it.
  return source.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("a one-time secret is held in component state and never persisted", () => {
  const source = stripComments(fs.readFileSync(
    path.join(__dirname, "..", "src", "components", "sections", "integrations-section.tsx"),
    "utf8"
  ));
  // The property that makes "shown once" true rather than aspirational.
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /sessionStorage/);
  assert.doesNotMatch(source, /document\.cookie/);
  assert.doesNotMatch(source, /console\.(log|info|warn|error)/);
  // Closing the dialog drops the only copy in the browser.
  assert.match(source, /setSecret\(null\)/);
  // Copying is an explicit user action, never automatic.
  assert.match(source, /onClick=\{async \(\) => \{[\s\S]*?clipboard\.writeText/);
  assert.doesNotMatch(source, /useEffect\([^)]*clipboard/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("the typed client never exposes a secret on a list or detail shape", () => {
  const source = stripComments(fs.readFileSync(
    path.join(__dirname, "..", "src", "lib", "api", "integrations.ts"),
    "utf8"
  ));
  const apiKeyType = /export type ApiKey = \{[\s\S]*?\n\};/.exec(source)?.[0] ?? "";
  assert.ok(apiKeyType.length > 0);
  assert.ok(!/\bsecret\b/.test(apiKeyType) && !/\btoken\b/.test(apiKeyType),
    "the list shape must have no field a secret could occupy");
  assert.match(apiKeyType, /prefix: string;/);

  const endpointType = /export type WebhookEndpoint = \{[\s\S]*?\n\};/.exec(source)?.[0] ?? "";
  assert.ok(endpointType.length > 0);
  assert.ok(!/\bsecret:\s/.test(endpointType) && !/ciphertext/.test(endpointType));
  assert.match(endpointType, /secret_version: number \| null;/);

  // The only shapes that carry a secret are the one-time create/rotate responses.
  assert.match(source, /export type ApiKeyCreated = \{ key: ApiKey; token: string \};/);
  assert.match(source, /export type WebhookCreated = \{ endpoint: WebhookEndpoint; secret: string \};/);
});

test("the integrations section is reachable from the admin navigation", () => {
  const root = path.join(__dirname, "..", "src");
  const navigation = fs.readFileSync(path.join(root, "lib", "demo-data.ts"), "utf8");
  const content = fs.readFileSync(path.join(root, "components", "operations-content.tsx"), "utf8");
  assert.match(navigation, /\{ key: "integrations", label: "[^"]+" \}/);
  assert.match(navigation, /^ {2}integrations: \{$/m, "a section without sectionMeta renders no page header");
  assert.match(content, /case "integrations":/);
  assert.match(content, /<IntegrationsSection currentRole=\{currentRole\} organizationSlug=\{activeOrganizationSlug\} \/>/);
});
