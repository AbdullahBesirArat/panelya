import { authenticatedRequest, buildQuery } from "./core";

export type PlatformStoreStatus =
  | "setup" | "active" | "trialing" | "past_due" | "suspended" | "cancelled" | "archived";

export type PlatformStore = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: PlatformStoreStatus;
  domain: string | null;
  storefrontUrl: string | null;
  owner: { userId: string | null; name: string | null; email: string | null };
  counts: {
    products: number;
    activeProducts: number;
    productsWithoutImage: number;
    customers: number;
    orders: number;
    orders30d: number;
    cancelledOrders: number;
    uploads: number;
  };
  storageBytes: number;
  settingsCompleteness: {
    checks: Record<string, boolean>;
    missing: string[];
    isComplete: boolean;
    completionRatio: number;
  };
  setupCompletedAt: string | null;
  suspendedAt: string | null;
  archivedAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformOverview = {
  metrics: {
    total_stores: number;
    active_stores: number;
    setup_stores: number;
    passive_stores: number;
    archived_stores: number;
    new_stores_7d: number;
    total_products: number;
    total_orders: number;
    orders_30d: number;
    total_customers: number;
    total_uploads: number;
    total_storage_bytes: string;
  };
  recentStores: PlatformStore[];
  incompleteStores: Array<{ id: string; name: string; slug: string; missing: string[] }>;
  recentActivity: Array<{
    action: string;
    entity_type: string;
    entity_id: string | null;
    created_at: string;
    organization_name: string | null;
    organization_slug: string | null;
  }>;
};

export type PlatformStoreFilters = {
  status?: string;
  plan?: string;
  domain?: "connected" | "none" | "";
  q?: string;
  noProducts?: boolean;
  noOrders?: boolean;
  incompleteSettings?: boolean;
  limit?: number;
  offset?: number;
};

export type CreateStorePayload = {
  name: string;
  slug?: string;
  description?: string;
  storeType?: string;
  plan?: string;
  status?: string;
  owner: { mode: "new" | "existing"; name?: string; email?: string; phone?: string; userId?: string; password?: string };
  settings?: Record<string, unknown>;
};

export type PlatformPlan = {
  plan_name: string;
  max_products: number;
  max_orders_month: number;
  max_members: number;
  max_storage_mb: number;
  max_collections: number;
  max_blog_posts: number;
};

export async function fetchPlatformOverview() {
  return authenticatedRequest<PlatformOverview>("/platform/overview");
}

export async function fetchPlatformStores(filters: PlatformStoreFilters = {}) {
  return authenticatedRequest<{ total: number; limit: number; offset: number; stores: PlatformStore[] }>(
    `/platform/stores${buildQuery({
      status: filters.status,
      plan: filters.plan,
      domain: filters.domain,
      q: filters.q,
      noProducts: filters.noProducts ? "true" : undefined,
      noOrders: filters.noOrders ? "true" : undefined,
      incompleteSettings: filters.incompleteSettings ? "true" : undefined,
      limit: filters.limit,
      offset: filters.offset,
    })}`
  );
}

export async function createPlatformStore(payload: CreateStorePayload) {
  return authenticatedRequest<{ store: PlatformStore & { ownerEmail: string }; temporaryPassword?: string; passwordNote?: string }>(
    "/platform/stores",
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export async function fetchPlatformStore(id: string) {
  return authenticatedRequest<{ store: PlatformStore }>(`/platform/stores/${id}`);
}

export async function updatePlatformStore(id: string, payload: Record<string, unknown>) {
  return authenticatedRequest<{ ok: boolean; id: string }>(`/platform/stores/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function updatePlatformStoreStatus(id: string, status: PlatformStoreStatus) {
  return authenticatedRequest<{ ok: boolean; status: string }>(`/platform/stores/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export type PlatformStoreMetrics = {
  planUsage: {
    plan: string;
    limits: Record<string, number>;
    usage: Record<string, number>;
  } | null;
  orderStatusBreakdown: Array<{ status: string; count: number }>;
};

export async function fetchPlatformStoreMetrics(id: string) {
  return authenticatedRequest<PlatformStoreMetrics>(`/platform/stores/${id}/metrics`);
}

export type PlatformStorageReport = {
  storageBytes: number;
  storageMb: number;
  maxStorageMb: number;
  usedRatioPercent: number | null;
  overLimit: boolean;
  images: {
    productImages: number;
    sliderImages: number;
    blogImages: number;
    categoryImages: number;
    uploadAssets: number;
    total: number;
    productsWithoutImage: number;
  };
  largestFiles: Array<{ filename: string; byte_size: number; mime_type: string; created_at: string }>;
};

export async function fetchPlatformStoreStorage(id: string) {
  return authenticatedRequest<PlatformStorageReport>(`/platform/stores/${id}/storage`);
}

export type PlatformStoreUser = {
  membership_id: string;
  role: string;
  status: string;
  created_at: string;
  user_id: string;
  email: string;
  name: string;
  last_login_at: string | null;
  email_verified_at: string | null;
  platformRole: string;
};

export async function fetchPlatformStoreUsers(id: string) {
  return authenticatedRequest<{ users: PlatformStoreUser[] }>(`/platform/stores/${id}/users`);
}

export async function addPlatformStoreUser(id: string, payload: { email: string; name?: string; role?: string; password?: string }) {
  return authenticatedRequest<{ ok: boolean; userId: string; role: string; temporaryPassword?: string }>(
    `/platform/stores/${id}/users`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export type ImpersonationResponse = {
  // Stripped by the BFF (kept in an HttpOnly cookie); never present client-side.
  accessToken?: string;
  tokenType: "app";
  organization: { id: string; name: string; slug: string };
  expiresAt: string;
  impersonationLogId: string;
  warning: string;
};

export async function impersonateStore(id: string, reason?: string) {
  return authenticatedRequest<ImpersonationResponse>(`/platform/stores/${id}/impersonate`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || "" }),
  });
}

export type PlatformDomain = {
  organizationId: string;
  name: string;
  slug: string;
  domain: string | null;
  subdomain: string | null;
  storefrontUrl: string | null;
  connected: boolean;
  domainStatus: string;
  sslStatus: string;
  verification: string;
  updatedAt: string;
};

export async function fetchPlatformDomains() {
  return authenticatedRequest<{ domains: PlatformDomain[] }>("/platform/domains");
}

export async function updatePlatformStoreDomain(id: string, payload: {
  domain?: string;
  subdomain?: string;
  storefrontUrl?: string;
  domainStatus?: string;
  sslStatus?: string;
}) {
  return authenticatedRequest<{ ok: boolean; domain: string | null; subdomain: string; storefrontUrl: string | null; domainStatus: string }>(
    `/platform/stores/${id}/domain`,
    { method: "PATCH", body: JSON.stringify(payload) }
  );
}

export async function fetchPlatformPlans() {
  return authenticatedRequest<{ plans: PlatformPlan[] }>("/platform/plans");
}

export async function updatePlatformStorePlan(id: string, plan: string) {
  return authenticatedRequest<{ ok: boolean; plan: string }>(`/platform/stores/${id}/plan`, {
    method: "PATCH",
    body: JSON.stringify({ plan }),
  });
}

export type PlatformActivityLog = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  actor_user_id: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  actor_email: string | null;
};

export async function fetchPlatformActivityLogs(params: { organizationId?: string; limit?: number; offset?: number } = {}) {
  return authenticatedRequest<{ logs: PlatformActivityLog[]; limit: number; offset: number }>(
    `/platform/activity-logs${buildQuery({
      organizationId: params.organizationId,
      limit: params.limit,
      offset: params.offset,
    })}`
  );
}

export type PlatformHealth = {
  ok: boolean;
  db: { connected: boolean; latencyMs: number };
  counts: Record<string, number | string>;
  pendingPaymentCallbacks: number;
  migrations: { count: number; last_applied: string | null };
  env: Record<string, boolean | string | null>;
  warnings: string[];
};

export async function fetchPlatformHealth() {
  return authenticatedRequest<PlatformHealth>("/platform/health");
}

export async function fetchPlatformSettings() {
  return authenticatedRequest<{ settings: Record<string, unknown>; updatedAt: string | null }>("/platform/settings");
}

export async function updatePlatformSettings(payload: {
  defaultPlan?: string;
  supportEmail?: string;
  allowSelfSignup?: boolean;
  maintenanceMode?: boolean;
}) {
  return authenticatedRequest<{ settings: Record<string, unknown>; updatedAt: string }>("/platform/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
