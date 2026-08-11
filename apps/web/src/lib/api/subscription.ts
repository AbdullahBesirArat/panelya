import { authenticatedRequest, buildQuery } from "./core";

// Types mirror the actual responses of panelya-api/routes/subscription.js and
// routes/subscriptionOperations.js. Anything the backend does not send is absent here
// rather than optimistically declared.

export type SubscriptionStatus =
  | "trialing" | "active" | "past_due" | "grace_period"
  | "suspended" | "cancelled" | "expired";

export type SubscriptionProviderName = "manual" | "test" | "stripe" | "iyzico";

export type Subscription = {
  id: string;
  provider: SubscriptionProviderName;
  plan: string;
  plan_version_id: number | null;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  grace_until: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
};

export type ProviderCapabilities = {
  provider: SubscriptionProviderName;
  configured: boolean;
  supportsProration: boolean;
};

export type PlanLimits = {
  maxProducts: number;
  maxOrdersMonth: number;
  maxMembers: number;
  maxStorageMb: number;
  maxCollections: number;
  maxBlogPosts: number;
  /** A27: domains became a countable plan resource (migration 061). */
  maxDomains: number;
  /** A29: the integration platform's dimensions (migration 067). */
  maxApiKeys: number;
  maxWebhooks: number;
  maxApiCallsMonth: number;
};

export type PlanUsage = {
  products: number;
  ordersMonth: number;
  members: number;
  collections: number;
  blogPosts: number;
  domains: number;
  apiKeys: number;
  webhooks: number;
  apiCallsMonth: number;
  storageBytes: number;
  storageMb: number;
};

export type UsageWarning = {
  resource: string;
  used: number;
  limit: number;
  ratio: number;
  /** Advisory: approaching the ceiling. */
  warning: boolean;
  /** Hard state: the backend will refuse the next create. */
  atLimit: boolean;
};

export type SubscriptionAccess = {
  status: SubscriptionStatus | null;
  capabilities: Array<"read" | "write" | "billing" | "admin">;
  unrestricted: boolean;
};

export type SubscriptionOverviewPlan = {
  name: string;
  version: number | null;
  version_id: number | null;
  limit_source: "plan_version" | "plan_limits";
  overrides: Array<{ resource: string; limit: number }>;
};

export type SubscriptionOverview = {
  subscription: Subscription | null;
  provider: ProviderCapabilities | null;
  plan: SubscriptionOverviewPlan | null;
  usage: PlanUsage | null;
  limits: PlanLimits | null;
  warnings: UsageWarning[];
  access: SubscriptionAccess;
};

export type SubscriptionInvoice = {
  id: number;
  invoice_number: string;
  provider: SubscriptionProviderName;
  provider_invoice_reference: string | null;
  currency: string;
  subtotal: string;
  tax_total: string;
  total: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  period_start: string | null;
  period_end: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  created_at: string;
};

export type PlanChangePreviewResource = {
  resource: string;
  currentUsage: number;
  currentLimit: number;
  targetLimit: number;
  exceeded: boolean;
  difference: number;
};

export type PlanChangePreview = {
  sourcePlan: string;
  sourcePlanVersion: number | null;
  targetPlan: string;
  targetPlanVersion: number;
  targetPlanVersionId: number;
  resources: PlanChangePreviewResource[];
  exceeded: boolean;
  dataImpact: string;
};

export type Proration = {
  supported: boolean;
  reason: string;
  amount: number | null;
} | null;

export type PlanChangeRequest = {
  id: number;
  subscription_id: string;
  source_plan_name: string;
  target_plan_name: string;
  target_plan_version_id: number;
  change_type: "upgrade" | "downgrade" | "same_plan_version";
  status: "pending" | "scheduled" | "applied" | "rejected" | "failed" | "cancelled";
  effective_at: string | null;
  applied_at: string | null;
  failure_reason: string | null;
  requested_at: string;
};

export type PlanChangeResult = {
  request: PlanChangeRequest;
  preview: PlanChangePreview;
  /** false means the backend SCHEDULED it (period end) instead of applying now. */
  applied: boolean;
  proration: Proration;
};

// --- tenant surface --------------------------------------------------------------------

export function fetchSubscriptionOverview() {
  return authenticatedRequest<SubscriptionOverview>("/subscription");
}

export function fetchSubscriptionInvoices() {
  return authenticatedRequest<{ items: SubscriptionInvoice[] }>("/subscription/invoices");
}

export function fetchPlanChangePreview(targetPlan: string) {
  return authenticatedRequest<{ preview: PlanChangePreview }>(
    `/subscription/plan-change/preview${buildQuery({ plan: targetPlan })}`
  );
}

export function requestPlanChange(targetPlan: string, reason?: string) {
  return authenticatedRequest<PlanChangeResult>("/subscription/plan-change", {
    method: "POST",
    body: JSON.stringify({ plan: targetPlan, reason: reason || "" }),
  });
}

export function cancelAtPeriodEnd(reason?: string) {
  return authenticatedRequest<{ subscription: Subscription }>("/subscription/cancel", {
    method: "POST",
    body: JSON.stringify({ reason: reason || "" }),
  });
}

export function resumeSubscription() {
  return authenticatedRequest<{ subscription: Subscription }>("/subscription/resume", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// --- super-admin surface ----------------------------------------------------------------

export type PlanDefinition = {
  plan_name: string;
  max_products: number;
  max_orders_month: number;
  max_members: number;
  max_storage_mb: number;
  max_collections: number;
  max_blog_posts: number;
};

export type PlanVersion = {
  id: number;
  plan_name: string;
  version: number;
  status: "draft" | "active" | "retired";
  effective_from: string | null;
  limits: Partial<PlanLimits>;
  notes: string;
  published_at: string | null;
  created_at: string;
};

export type AdminSubscription = Subscription & {
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  plan_version: number | null;
};

export type SubscriptionOverride = {
  id: number;
  organization_id: string;
  subscription_id: string | null;
  override_type: "limit" | "status" | "plan_version";
  target_key: string;
  target_value: Record<string, unknown>;
  reason: string;
  created_by: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  /** Server-computed: revoked_at is null AND expires_at is still in the future. */
  is_live?: boolean;
};

export type BillingEvent = {
  id: number;
  organization_id: string | null;
  provider: SubscriptionProviderName;
  provider_event_id: string;
  event_type: string;
  event_sequence: number | null;
  status: "pending" | "processing" | "processed" | "failed" | "ignored";
  processing_attempts: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
  next_retry_at?: string | null;
};

export type AdminSubscriptionDetail = {
  subscription: (Subscription & { organization_id: string }) | null;
  invoices: SubscriptionInvoice[];
  billing_events: BillingEvent[];
  overrides: SubscriptionOverride[];
  plan_changes: PlanChangeRequest[];
};

export function fetchPlanCatalog() {
  return authenticatedRequest<{ plans: PlanDefinition[]; versions: PlanVersion[] }>(
    "/operations/subscriptions/plans"
  );
}

export function createPlanVersionDraft(planName: string, limits: PlanLimits, notes?: string) {
  return authenticatedRequest<{ version: PlanVersion }>(
    `/operations/subscriptions/plans/${encodeURIComponent(planName)}/versions`,
    { method: "POST", body: JSON.stringify({ limits, notes: notes || "" }) }
  );
}

/** Publishing is the only way limits change; existing subscriptions stay pinned. */
export function publishPlanVersion(planName: string, version: number) {
  return authenticatedRequest<{ version: PlanVersion }>(
    `/operations/subscriptions/plans/${encodeURIComponent(planName)}/versions/${version}/publish`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export function fetchAdminSubscriptions() {
  return authenticatedRequest<{ items: AdminSubscription[] }>("/operations/subscriptions");
}

export function fetchAdminSubscriptionDetail(organizationId: string) {
  return authenticatedRequest<AdminSubscriptionDetail>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}`
  );
}

// Every super-admin mutation requires a reason; the backend rejects a short one with
// REASON_REQUIRED, so the UI must always collect it.
export function grantSubscription(organizationId: string, input: {
  plan: string; provider?: SubscriptionProviderName; with_trial?: boolean; reason: string;
}) {
  return authenticatedRequest<{ subscription: Subscription }>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}/grant`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function transitionSubscription(organizationId: string, input: {
  to: SubscriptionStatus; reason: string; grace_until?: string | null; suspension_reason?: string;
}) {
  return authenticatedRequest<{ subscription: Subscription; previous_status: SubscriptionStatus }>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}/transition`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function adminPlanChange(organizationId: string, input: {
  plan: string; reason: string; apply_immediately?: boolean;
}) {
  return authenticatedRequest<PlanChangeResult>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}/plan-change`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function recordInvoice(organizationId: string, input: {
  invoice_number?: string; subtotal: number; tax_total: number;
  status?: SubscriptionInvoice["status"]; paid_at?: string | null; reason: string;
}) {
  return authenticatedRequest<{ invoice: SubscriptionInvoice }>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}/invoices`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function createOverride(organizationId: string, input: {
  override_type: SubscriptionOverride["override_type"];
  target_key: string;
  target_value: Record<string, unknown>;
  reason: string;
  /** Required: the backend has no indefinite override. */
  expires_at: string;
}) {
  return authenticatedRequest<{ override: SubscriptionOverride }>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}/overrides`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function revokeOverride(organizationId: string, overrideId: number, reason: string) {
  return authenticatedRequest<{ override: SubscriptionOverride }>(
    `/operations/subscriptions/${encodeURIComponent(organizationId)}/overrides/${overrideId}/revoke`,
    { method: "POST", body: JSON.stringify({ reason }) }
  );
}

export function fetchFailedBillingEvents() {
  return authenticatedRequest<{ items: BillingEvent[] }>("/operations/subscriptions/billing-events/failed");
}

export function retryBillingEvent(eventId: number, reason: string) {
  return authenticatedRequest<{ event: BillingEvent }>(
    `/operations/subscriptions/billing-events/${eventId}/retry`,
    { method: "POST", body: JSON.stringify({ reason }) }
  );
}

export function fetchProviderCapabilities(provider: SubscriptionProviderName) {
  return authenticatedRequest<{ provider: string; configured: boolean; supports_proration: boolean }>(
    `/operations/subscriptions/providers/${encodeURIComponent(provider)}`
  );
}
