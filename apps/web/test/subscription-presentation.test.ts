import test from "node:test";
import assert from "node:assert/strict";

import {
  downgradeOutcome, formatMoney, invoiceLabel, invoiceTone, isUnlimited,
  lifecycleBanner, statusLabel, statusTone, usagePercent, usageRows,
} from "../src/features/subscription/presentation";
import { maskEventId } from "../src/components/sections/subscription-platform-panel";
import { ApiError, getApiErrorCode } from "../src/lib/api/types";
import type { PlanChangePreview, SubscriptionStatus, UsageWarning } from "../src/lib/api/subscription";

function subscription(overrides: Partial<{
  status: SubscriptionStatus; trial_end: string | null; grace_until: string | null;
  current_period_end: string | null; cancel_at_period_end: boolean; suspension_reason: string | null;
}> = {}) {
  return {
    status: "active" as SubscriptionStatus,
    trial_end: null,
    grace_until: null,
    current_period_end: null,
    cancel_at_period_end: false,
    suspension_reason: null,
    ...overrides,
  };
}

test("trial banner shows the trial deadline", () => {
  const banner = lifecycleBanner(subscription({ status: "trialing", trial_end: "2026-09-01T00:00:00Z" }));
  assert.equal(banner?.tone, "info");
  assert.equal(banner?.deadline, "2026-09-01T00:00:00Z");
});

test("an active plan with no scheduled cancellation shows no banner", () => {
  assert.equal(lifecycleBanner(subscription({ status: "active" })), null);
});

test("past_due and grace banners warn without threatening data loss", () => {
  const pastDue = lifecycleBanner(subscription({ status: "past_due" }));
  assert.equal(pastDue?.tone, "warning");
  assert.match(pastDue!.body, /silinmez/);

  const grace = lifecycleBanner(subscription({ status: "grace_period", grace_until: "2026-09-10T00:00:00Z" }));
  assert.equal(grace?.tone, "warning");
  assert.equal(grace?.deadline, "2026-09-10T00:00:00Z");
  assert.match(grace!.body, /silinmez/);
});

test("suspended/cancelled/expired never imply the tenant lost their data", () => {
  for (const status of ["suspended", "cancelled", "expired"] as SubscriptionStatus[]) {
    const banner = lifecycleBanner(subscription({ status }));
    assert.ok(banner, `${status} must render a banner`);
    assert.match(banner!.body, /saklanmaya devam|olduğu gibi duruyor|silinmez/);
    assert.doesNotMatch(banner!.body, /silindi|kaybedild/i);
  }
});

test("a scheduled cancellation on an active plan is surfaced with its date", () => {
  const banner = lifecycleBanner(subscription({
    status: "active", cancel_at_period_end: true, current_period_end: "2026-10-01T00:00:00Z",
  }));
  assert.equal(banner?.tone, "warning");
  assert.equal(banner?.deadline, "2026-10-01T00:00:00Z");
});

test("a limit of zero renders as unlimited, never as an always-exceeded ceiling", () => {
  assert.equal(isUnlimited(0), true);
  assert.equal(isUnlimited(-1), true);
  assert.equal(isUnlimited(25), false);
  assert.equal(usagePercent(10, 0), 0);
  assert.equal(usagePercent(5, 10), 50);
  assert.equal(usagePercent(99, 10), 100, "percentage is clamped");
});

test("usage rows carry warning and hard-limit states distinctly", () => {
  const warnings: UsageWarning[] = [
    { resource: "products", used: 24, limit: 25, ratio: 0.96, warning: true, atLimit: false },
    { resource: "members", used: 3, limit: 3, ratio: 1, warning: false, atLimit: true },
    { resource: "orders_month", used: 1, limit: 150, ratio: 0.006, warning: false, atLimit: false },
    { resource: "storage_mb", used: 10, limit: 0, ratio: 0, warning: false, atLimit: false },
  ];
  const rows = usageRows(warnings);
  assert.deepEqual(rows.map((r) => r.state), ["warning", "at_limit", "ok", "ok"]);
  assert.deepEqual(rows.map((r) => r.tone), ["sun", "coral", "mint", "mint"]);
  assert.equal(rows[3].unlimited, true);
  assert.equal(rows[0].label, "Ürünler");
});

function preview(exceeded: boolean): PlanChangePreview {
  return {
    sourcePlan: "growth", sourcePlanVersion: 1, targetPlan: "starter",
    targetPlanVersion: 1, targetPlanVersionId: 2,
    resources: [{ resource: "products", currentUsage: 40, currentLimit: 250, targetLimit: 25, exceeded, difference: exceeded ? 15 : 0 }],
    exceeded,
    dataImpact: "none",
  };
}

test("downgrade outcome mirrors the backend decision instead of inventing policy", () => {
  assert.equal(downgradeOutcome(preview(false), null)?.kind, "immediate");
  // Backend said it scheduled it -> the UI says scheduled, and promises no deletion.
  const scheduled = downgradeOutcome(preview(true), false);
  assert.equal(scheduled?.kind, "scheduled");
  assert.match(scheduled!.message, /dönem sonunda|silinmez/);
  // Not yet submitted: warn, but still never claim data will be removed.
  const pending = downgradeOutcome(preview(true), null);
  assert.equal(pending?.kind, "requires_action");
  assert.match(pending!.message, /silinmez/);
  assert.equal(downgradeOutcome(null, null), null);
});

test("invoice rendering distinguishes paid from unpaid states", () => {
  assert.equal(invoiceLabel("paid"), "Ödendi");
  assert.equal(invoiceTone("paid"), "mint");
  assert.equal(invoiceLabel("open"), "Ödeme bekliyor");
  assert.equal(invoiceTone("open"), "sun");
  assert.equal(invoiceTone("uncollectible"), "coral");
  assert.equal(formatMoney("120.00", "TRY"), "120,00 TRY");
  assert.equal(formatMoney("not-a-number", "TRY"), "— TRY");
});

test("status labels and tones cover the whole lifecycle", () => {
  const statuses: SubscriptionStatus[] = [
    "trialing", "active", "past_due", "grace_period", "suspended", "cancelled", "expired",
  ];
  for (const status of statuses) {
    assert.ok(statusLabel(status).length > 0, `${status} needs a label`);
    assert.ok(["mint", "sun", "coral", "leaf"].includes(statusTone(status)));
  }
  assert.equal(statusTone("active"), "mint");
  assert.equal(statusTone("suspended"), "coral");
});

test("provider event ids are masked so a provider customer cannot be identified from the UI", () => {
  assert.equal(maskEventId("evt_1234567890abcdef"), "…90abcdef");
  assert.equal(maskEventId("short"), "short");
  assert.doesNotMatch(maskEventId("evt_1234567890abcdef"), /evt_12345/);
});

test("machine-readable backend codes survive the typed client", () => {
  const error = new ApiError("Limit doldu", 402, "req-1", "PLAN_LIMIT_REACHED");
  assert.equal(getApiErrorCode(error), "PLAN_LIMIT_REACHED");
  assert.equal(error.status, 402);
  // A plain Error carries no code, and the helper must not invent one.
  assert.equal(getApiErrorCode(new Error("boom")), null);
  assert.equal(getApiErrorCode(new ApiError("x", 500)), null);
});
