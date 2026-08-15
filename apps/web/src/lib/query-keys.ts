export const queryKeys = {
  session: {
    all: ["me"] as const,
    detail: (
      actorType: string | null,
      organizationSlug: string | null,
      impersonationId: string | null,
    ) => ["me", actorType, organizationSlug, impersonationId] as const,
  },
  // A30. Security state belongs to a concrete account/session actor. Include the
  // subject id so signing into a different account in the same browser can never
  // reuse assurance, passkey, or session data from React Query's cache.
  security: {
    summary: (
      actorType: string | null,
      subjectId: string | null,
      organizationSlug: string | null,
    ) => ["security", actorType, subjectId, organizationSlug, "summary"] as const,
    sessions: (actorType: string | null, subjectId: string | null) =>
      ["security", actorType, subjectId, "sessions"] as const,
    passkeys: (actorType: string | null, subjectId: string | null) =>
      ["security", actorType, subjectId, "passkeys"] as const,
    policy: (subjectId: string | null, organizationSlug: string) =>
      ["security", subjectId, organizationSlug, "policy"] as const,
    stepUp: (actorType: string | null, subjectId: string | null) =>
      ["security", actorType, subjectId, "step-up"] as const,
  },
  summary: {
    all: ["summary"] as const,
    detail: (organizationSlug: string) =>
      ["summary", organizationSlug] as const,
  },
  catalog: {
    products: {
      all: (organizationSlug: string) =>
        ["products", organizationSlug] as const,
      list: (
        organizationSlug: string,
        search: string,
        status: string,
        categoryId: string,
      ) => ["products", organizationSlug, search, status, categoryId] as const,
      byCategory: (organizationSlug: string, categoryId?: string | null) =>
        ["category-products", organizationSlug, categoryId ?? ""] as const,
    },
    categories: (organizationSlug: string) =>
      ["categories", organizationSlug] as const,
    colors: (organizationSlug: string) =>
      ["customColors", organizationSlug] as const,
    sizes: (organizationSlug: string) =>
      ["customSizes", organizationSlug] as const,
  },
  content: {
    slides: (organizationSlug: string) => ["slides", organizationSlug] as const,
    campaigns: (organizationSlug: string) =>
      ["campaigns", organizationSlug] as const,
    collections: (organizationSlug: string) =>
      ["collections", organizationSlug] as const,
    collectionProducts: (
      organizationSlug: string,
      collectionId: string | null,
    ) => ["collection-products", organizationSlug, collectionId] as const,
    blog: (organizationSlug: string) =>
      ["blog-posts", organizationSlug] as const,
  },
  coupons: {
    all: (organizationSlug: string) => ["coupons", organizationSlug] as const,
    redemptions: (organizationSlug: string, couponId: string | null) =>
      ["coupon-redemptions", organizationSlug, couponId] as const,
  },
  customers: {
    all: (organizationSlug: string) => ["customers", organizationSlug] as const,
    list: (organizationSlug: string, search: string) =>
      ["customers", organizationSlug, search] as const,
  },
  orders: {
    all: (organizationSlug: string) => ["orders", organizationSlug] as const,
    list: (organizationSlug: string, filters: string) =>
      ["orders", organizationSlug, filters] as const,
    detail: (organizationSlug: string, orderId?: string | null) =>
      ["order-detail", organizationSlug, orderId ?? null] as const,
    metadata: (organizationSlug: string) =>
      ["order-operations-metadata", organizationSlug] as const,
  },
  returns: {
    all: (organizationSlug: string) => ["returns", organizationSlug] as const,
    list: (organizationSlug: string, status: string, type: string) =>
      ["returns", organizationSlug, status, type] as const,
    detail: (organizationSlug: string, requestId?: string | null) =>
      ["return-detail", organizationSlug, requestId ?? null] as const,
  },
  shipments: {
    all: (organizationSlug: string) => ["shipments", organizationSlug] as const,
    list: (organizationSlug: string, status: string) => ["shipments", organizationSlug, status] as const,
    detail: (organizationSlug: string, shipmentId?: string | null) => ["shipment-detail", organizationSlug, shipmentId ?? null] as const,
    profiles: (organizationSlug: string) => ["shipping-profiles", organizationSlug] as const,
  },
  invoices: {
    all: (organizationSlug: string) => ["invoices", organizationSlug] as const,
    detail: (organizationSlug: string, invoiceId?: string | null) => ["invoice-detail", organizationSlug, invoiceId ?? null] as const,
    legalProfile: (organizationSlug: string) => ["invoice-legal-profile", organizationSlug] as const,
  },
  imports: {
    all: (organizationSlug: string) => ["imports", organizationSlug] as const,
    detail: (organizationSlug: string, jobId?: string | null) => ["import-detail", organizationSlug, jobId ?? null] as const,
  },
  carts: {
    all: (organizationSlug: string, filters?: string) => ["carts", organizationSlug, filters ?? ""] as const,
    metrics: (organizationSlug: string) => ["cart-metrics", organizationSlug] as const,
    detail: (organizationSlug: string, cartId?: string | null) => ["cart-detail", organizationSlug, cartId ?? null] as const,
  },
  reviews: {
    all: (organizationSlug: string, status: string) => ["reviews-moderation", organizationSlug, status] as const,
    questions: (organizationSlug: string, status: string) => ["questions-moderation", organizationSlug, status] as const,
  },
  giftWrap: {
    all: (organizationSlug: string) => ["gift-wrap", organizationSlug] as const,
  },
  // Tenant keys carry the organization slug; platform keys are explicitly separate so a
  // super-admin view can never be served from a tenant-scoped cache entry (or vice versa).
  domains: {
    tenant: (organizationSlug: string) => ["domains", organizationSlug] as const,
    detail: (organizationSlug: string, domainId: number) => ["domains", organizationSlug, "detail", domainId] as const,
    platform: (filterKey: string) => ["domains", "platform", filterKey] as const,
    platformDetail: (domainId: number) => ["domains", "platform", "detail", domainId] as const,
  },
  // Every tenant-scoped key carries the organization slug so switching tenants (or
  // impersonating one) can never serve another tenant's billing data from cache.
  subscription: {
    current: (organizationSlug: string) => ["subscription", organizationSlug, "current"] as const,
    usage: (organizationSlug: string) => ["subscription", organizationSlug, "usage"] as const,
    invoices: (organizationSlug: string) => ["subscription", organizationSlug, "invoices"] as const,
    preview: (organizationSlug: string, targetPlan: string) =>
      ["subscription", organizationSlug, "preview", targetPlan] as const,
    plans: () => ["subscription", "platform", "plans"] as const,
    versions: (planName: string) => ["subscription", "platform", "versions", planName] as const,
    events: () => ["subscription", "platform", "billing-events"] as const,
    overrides: (organizationId: string) => ["subscription", "platform", "overrides", organizationId] as const,
    adminSubscriptions: () => ["subscription", "platform", "subscriptions"] as const,
    adminDetail: (organizationId: string) => ["subscription", "platform", "detail", organizationId] as const,
  },
  // A28. Draft and published are separate keys on purpose: publishing must not be able to
  // leave a stale draft in the cache, and a draft must never be read where the live theme
  // is expected. Version snapshots are keyed by id because they are immutable once archived.
  theme: {
    published: (organizationSlug: string) => ["theme", organizationSlug, "published"] as const,
    draft: (organizationSlug: string) => ["theme", organizationSlug, "draft"] as const,
    versions: (organizationSlug: string) => ["theme", organizationSlug, "versions"] as const,
    version: (organizationSlug: string, versionId: number) =>
      ["theme", organizationSlug, "version", versionId] as const,
  },
  // A29. Deliveries are keyed by their filter so switching endpoint or status refetches
  // rather than showing another endpoint's log; one-time secrets are never cached at all,
  // so there is deliberately no key for them.
  integrations: {
    meta: (organizationSlug: string) => ["integrations", organizationSlug, "meta"] as const,
    apiKeys: (organizationSlug: string) => ["integrations", organizationSlug, "api-keys"] as const,
    webhooks: (organizationSlug: string) => ["integrations", organizationSlug, "webhooks"] as const,
    deliveries: (organizationSlug: string, filterKey: string) =>
      ["integrations", organizationSlug, "deliveries", filterKey] as const,
  },
  instagramImport: {
    all: (organizationSlug: string) => ["instagram-import", organizationSlug] as const,
    connections: (organizationSlug: string) => ["instagram-import", organizationSlug, "connections"] as const,
    media: (organizationSlug: string, status: string) => ["instagram-import", organizationSlug, "media", status] as const,
    draft: (organizationSlug: string, draftId?: string | null) => ["instagram-import", organizationSlug, "draft", draftId ?? null] as const,
  },
  sizeGuides: {
    all: (organizationSlug: string) => ["size-guides", organizationSlug] as const,
    forProduct: (organizationSlug: string, productId: string) => ["size-guide-product", organizationSlug, productId] as const,
  },
  notifications: {
    overview: (organizationSlug: string) => ["notifications", organizationSlug, "overview"] as const,
    providers: (organizationSlug: string) => ["notifications", organizationSlug, "providers"] as const,
    outbox: (organizationSlug: string, status: string) => ["notifications", organizationSlug, "outbox", status] as const,
    deliveries: (organizationSlug: string) => ["notifications", organizationSlug, "deliveries"] as const,
    failed: (organizationSlug: string) => ["notifications", organizationSlug, "failed"] as const,
    suppressions: (organizationSlug: string) => ["notifications", organizationSlug, "suppressions"] as const,
  },
  team: {
    members: (organizationSlug: string) =>
      ["team-members", organizationSlug] as const,
    invites: (organizationSlug: string) =>
      ["organization-invites", organizationSlug] as const,
  },
  platform: {
    legacyOverview: ["superadmin-overview"] as const,
    overview: ["platform-overview"] as const,
    stores: {
      all: ["platform-stores"] as const,
      overview: ["platform-stores", "overview"] as const,
      users: ["platform-stores", "users"] as const,
      list: (filters: {
        q: string;
        status: string;
        plan: string;
        domain: string;
        flag: string;
      }) => ["platform-stores", filters] as const,
      detail: (storeId: string) => ["platform-store", storeId] as const,
      usersFor: (storeId: string) => ["platform-store-users", storeId] as const,
      storage: (storeId: string) =>
        ["platform-store-storage", storeId] as const,
      metrics: (storeId: string) =>
        ["platform-store-metrics", storeId] as const,
    },
    activity: (storeId: string) => ["platform-activity", storeId] as const,
    allActivity: ["platform-activity", "all"] as const,
    domains: ["platform-domains"] as const,
    plans: ["platform-plans"] as const,
    health: ["platform-health"] as const,
    settings: ["platform-settings"] as const,
  },
} as const;
