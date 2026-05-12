import { useSessionStore, type SessionOrganization, type SessionUser } from "@/store/session";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000/api";

export type ProductStatus = "active" | "draft" | "out";
export type OrderStatus =
  | "new"
  | "payment_pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "paid";

type SessionResponse = {
  accessToken: string;
  refreshToken?: string;
  user: SessionUser;
  currentOrganization: SessionOrganization;
  organizations: SessionOrganization[];
  role: string;
  actorType?: "app";
};

export type AdminSessionResponse = {
  actorType: "admin";
  accessToken: string;
  role: "super_admin" | "admin" | "viewer";
  admin: {
    id: string;
    username: string;
    role: "super_admin" | "admin" | "viewer";
  };
};

export type MeResponse = {
  actorType: "app" | "admin";
  user?: SessionUser;
  admin?: AdminSessionResponse["admin"];
  currentOrganization?: SessionOrganization;
  organizations?: SessionOrganization[];
  role?: string;
};

export type ApiCategory = {
  id: string;
  name: string;
  slug: string;
  image_url: string;
};

export type ApiProduct = {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  price: string;
  sale_price: string | null;
  stock: number;
  status: ProductStatus;
  colors: string[];
  sizes: string[];
  variants?: ProductVariant[];
  images: string[];
  details: {
    short_description?: string;
    story?: string;
    measurements?: string;
    delivery_note?: string;
    [key: string]: unknown;
  };
  tags: string;
  description: string;
  product_story: string;
  emoji: string;
  created_at: string;
  updated_at: string;
};

export type ProductVariant = {
  id?: string | number;
  product_id?: string | number;
  color: string;
  size: string;
  sku?: string;
  stock: number;
  status?: "active" | "out";
};

export type ApiCustomer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  created_at: string;
  orders: number;
  total: string;
};

export type ApiOrder = {
  id: string;
  order_code: string;
  customer_id: string | null;
  customer: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  items: string;
  total: string;
  status: OrderStatus;
  payment_provider: string | null;
  payment_method: "card" | "iban";
  note: string;
  gift_wrap: boolean;
  shipping_fee: string;
  shipping_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ApiOrderDetail = Omit<ApiOrder, "items" | "customer"> & {
  customer: {
    id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  items: Array<{
    id: string;
    product_id: string | null;
    name: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>;
};

export type ApiSlide = {
  id: string;
  organization_id: string;
  tag: string;
  title: string;
  sub: string;
  btn: string;
  image_url: string;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ApiCampaign = {
  id: string;
  organization_id: string;
  name: string;
  type: string;
  value: string;
  end_date: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type ApiCollection = {
  id: string;
  organization_id: string;
  title: string;
  slug: string;
  description: string;
  image_url: string;
  link_url: string;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ApiBlogPost = {
  id: string;
  organization_id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  image_url: string;
  active: boolean;
  sort_order: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationSummary = {
  organization: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    created_at: string;
    store_settings?: StoreSettings;
  };
  metrics: {
    product_count: number;
    active_products: number;
    draft_products: number;
    out_of_stock_products: number;
    low_stock_products: number;
    category_count: number;
    customer_count: number;
    repeat_customers: number;
    new_customers_this_month: number;
    order_count: number;
    today_orders: number;
    pending_orders: number;
    shipped_orders: number;
    delivered_orders: number;
    cancelled_orders: number;
    gross_revenue: string;
    month_revenue: string;
    active_members: number;
  };
  recentOrders: Array<{
    id: string;
    order_code: string;
    total: string;
    status: OrderStatus;
    created_at: string;
    customer_name: string | null;
  }>;
  lowStockProducts: Array<{
    id: string;
    name: string;
    stock: number;
    status: ProductStatus;
    category_name: string | null;
  }>;
  recentActivity: Array<{
    id: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    metadata: {
      oldValue?: Record<string, unknown> | null;
      newValue?: Record<string, unknown> | null;
      success?: boolean;
      errorMessage?: string | null;
    };
    created_at: string;
    actor_name: string;
  }>;
  orderStatusBreakdown: Array<{
    status: OrderStatus;
    count: number;
  }>;
  topCustomers: Array<{
    id: string;
    name: string;
    email: string;
    orders: number;
    total: string;
  }>;
  subscription: {
    provider: string;
    plan: string;
    status: string;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    updated_at: string;
  } | null;
};

export type ApiOrganizationSettings = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string;
  updated_at: string;
  public_access_token: string;
  store_settings?: StoreSettings;
};

export type StoreSettings = {
  contactEmail?: string;
  supportPhone?: string;
  shippingFee?: number;
  freeShippingThreshold?: number;
  paymentProvider?: "manual" | "iyzico";
  paymentEnabled?: boolean;
  orderEmailEnabled?: boolean;
};

export type ApiTeamMember = {
  id: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  email: string;
  name: string;
  last_login_at: string | null;
};

export type ApiOrganizationInvite = {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  invited_by_name: string | null;
  invited_by_email: string | null;
  inviteToken?: string;
};

export type SuperAdminOverview = {
  metrics: {
    shop_count: number;
    live_shop_count: number;
    suspended_shop_count: number;
    order_count: number;
    today_orders: number;
    month_orders: number;
    gross_revenue: string;
    month_revenue: string;
  };
  shops: Array<{
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    owners: string;
    owner_emails: string;
    product_count: number;
    customer_count: number;
    order_count: number;
    today_orders: number;
    month_orders: number;
    pending_orders: number;
    shipped_orders: number;
    delivered_orders: number;
    cancelled_orders: number;
    gross_revenue: string;
    month_revenue: string;
    last_order_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  recentOrders: Array<{
    id: string;
    order_code: string;
    total: string;
    status: OrderStatus;
    created_at: string;
    organization_id: string;
    organization_name: string;
    organization_slug: string;
    customer_name: string | null;
    customer_email: string | null;
  }>;
};

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  return undefined as T;
}

async function readError(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};
  const status = response.status;
  const serverMessage = typeof body.error === "string" ? body.error : "";

  if (status === 401) {
    throw new Error("Oturumunuz gecersiz veya suresi dolmus.");
  }
  if (status === 403) {
    throw new Error("Bu işlem için yetkiniz yok.");
  }
  if (status === 404) {
    throw new Error("Istenen kayit bulunamadi.");
  }
  if (status === 409) {
    throw new Error("Bu işlem mevcut verilerle çakıştı.");
  }
  if (status === 429) {
    throw new Error("Cok fazla istek gonderildi. Lutfen biraz sonra tekrar deneyin.");
  }
  if (status >= 500) {
    throw new Error("Sunucuda bir hata olustu. Lutfen tekrar deneyin.");
  }

  throw new Error(serverMessage || "Islem tamamlanamadi. Girdilerinizi kontrol edip tekrar deneyin.");
}

function buildQuery(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}

async function publicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body != null && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) await readError(response);
  return parseResponse<T>(response);
}

let refreshSessionPromise: Promise<boolean> | null = null;

async function tryRefreshSession() {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  const state = useSessionStore.getState();
  if (!state.refreshToken) return false;

  refreshSessionPromise = (async () => {
    try {
      const refreshed = await publicRequest<SessionResponse>("/auth/session/refresh", {
        method: "POST",
        body: JSON.stringify({
          refreshToken: state.refreshToken,
          organizationSlug: state.organizationSlug,
        }),
      });
      useSessionStore.getState().applySession(refreshed);
      return true;
    } catch {
      useSessionStore.getState().clearSession();
      return false;
    } finally {
      refreshSessionPromise = null;
    }
  })();

  return refreshSessionPromise;
}

async function authenticatedRequest<T>(path: string, options: RequestInit = {}, canRetry = true): Promise<T> {
  const state = useSessionStore.getState();
  const headers = new Headers(options.headers);

  if (options.body != null && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (state.accessToken) {
    headers.set("Authorization", `Bearer ${state.accessToken}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && canRetry && state.refreshToken) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return authenticatedRequest<T>(path, options, false);
    }
  }

  if (!response.ok) await readError(response);
  return parseResponse<T>(response);
}

export async function loginSession(payload: {
  email: string;
  password: string;
  organizationSlug?: string;
}) {
  return publicRequest<SessionResponse>("/auth/session/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function loginAdminSession(payload: {
  username: string;
  password: string;
}) {
  return publicRequest<AdminSessionResponse>("/auth/admin/session/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function registerWorkspace(payload: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  organizationSlug?: string;
}) {
  return publicRequest<SessionResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchMe() {
  return authenticatedRequest<MeResponse>("/auth/me");
}

export async function switchOrganizationSession(organizationSlug: string) {
  return authenticatedRequest<Omit<SessionResponse, "refreshToken">>("/auth/session/switch-organization", {
    method: "POST",
    body: JSON.stringify({ organizationSlug }),
  });
}

export async function logoutSession() {
  const refreshToken = useSessionStore.getState().refreshToken;

  try {
    await publicRequest<void>("/auth/session/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  } finally {
    useSessionStore.getState().clearSession();
  }
}

export async function fetchCategories() {
  return authenticatedRequest<ApiCategory[]>("/categories");
}

export async function createCategory(payload: { name: string; slug?: string; imageUrl?: string }) {
  return authenticatedRequest<ApiCategory>("/categories", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      slug: payload.slug,
      image_url: payload.imageUrl || "",
    }),
  });
}

export async function updateCategory(id: string, payload: { name: string; slug?: string; imageUrl?: string }) {
  return authenticatedRequest<ApiCategory>(`/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      slug: payload.slug,
      image_url: payload.imageUrl || "",
    }),
  });
}

export async function deleteCategory(id: string) {
  return authenticatedRequest<void>(`/categories/${id}`, {
    method: "DELETE",
  });
}

export async function fetchProducts(filters: {
  q?: string;
  categoryId?: string;
  status?: ProductStatus | "";
  limit?: number;
  offset?: number;
} = {}) {
  return authenticatedRequest<ApiProduct[]>(
    `/products${buildQuery({
      q: filters.q,
      category_id: filters.categoryId,
      status: filters.status,
      limit: filters.limit,
      offset: filters.offset,
    })}`
  );
}

export async function createProduct(payload: {
  name: string;
  categoryId?: string;
  price: number;
  salePrice?: number | null;
  stock: number;
  status: ProductStatus;
  colors?: string[];
  sizes?: string[];
  variants?: ProductVariant[];
  images?: string[];
  details?: {
    short_description?: string;
    story?: string;
    measurements?: string;
    delivery_note?: string;
  };
  tags?: string;
  description?: string;
  emoji?: string;
}) {
  return authenticatedRequest<ApiProduct>("/products", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      category_id: payload.categoryId || null,
      price: payload.price,
      sale_price: payload.salePrice ?? null,
      stock: payload.stock,
      status: payload.status,
      colors: payload.colors ?? [],
      sizes: payload.sizes ?? [],
      variants: payload.variants ?? [],
      images: payload.images ?? [],
      details: payload.details ?? {},
      tags: payload.tags ?? "",
      description: payload.description ?? "",
      emoji: payload.emoji ?? "",
    }),
  });
}

export async function updateProduct(id: string, payload: {
  name: string;
  categoryId?: string;
  price: number;
  salePrice?: number | null;
  stock: number;
  status: ProductStatus;
  colors?: string[];
  sizes?: string[];
  variants?: ProductVariant[];
  images?: string[];
  details?: {
    short_description?: string;
    story?: string;
    measurements?: string;
    delivery_note?: string;
  };
  tags?: string;
  description?: string;
  emoji?: string;
}) {
  return authenticatedRequest<ApiProduct>(`/products/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      category_id: payload.categoryId || null,
      price: payload.price,
      sale_price: payload.salePrice ?? null,
      stock: payload.stock,
      status: payload.status,
      colors: payload.colors ?? [],
      sizes: payload.sizes ?? [],
      variants: payload.variants ?? [],
      images: payload.images ?? [],
      details: payload.details ?? {},
      tags: payload.tags ?? "",
      description: payload.description ?? "",
      emoji: payload.emoji ?? "",
    }),
  });
}

export async function bulkUpdateProducts(payload: {
  ids: string[];
  action: "status" | "category" | "delete";
  status?: ProductStatus;
  categoryId?: string;
}) {
  return authenticatedRequest<{
    ok: boolean;
    action: string;
    affectedCount: number;
    products: Array<Pick<ApiProduct, "id" | "name" | "status" | "category_id">>;
  }>("/products/bulk", {
    method: "POST",
    body: JSON.stringify({
      ids: payload.ids,
      action: payload.action,
      status: payload.status,
      category_id: payload.categoryId || null,
    }),
  });
}

export async function deleteProduct(id: string) {
  return authenticatedRequest<void>(`/products/${id}`, {
    method: "DELETE",
  });
}

export async function uploadProductImages(files: File[]) {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));

  return authenticatedRequest<{ files: Array<{ url: string }> }>("/upload", {
    method: "POST",
    body: formData,
  });
}

export async function fetchCustomers(filters: { q?: string; limit?: number; offset?: number } = {}) {
  return authenticatedRequest<ApiCustomer[]>(
    `/customers${buildQuery({
      q: filters.q,
      limit: filters.limit,
      offset: filters.offset,
    })}`
  );
}

export async function fetchOrders(filters: {
  q?: string;
  status?: OrderStatus | "";
  limit?: number;
  offset?: number;
} = {}) {
  return authenticatedRequest<ApiOrder[]>(
    `/orders${buildQuery({
      q: filters.q,
      status: filters.status,
      limit: filters.limit,
      offset: filters.offset,
    })}`
  );
}

export async function fetchOrderDetail(id: string) {
  return authenticatedRequest<ApiOrderDetail>(`/orders/${id}`);
}

export async function updateOrderStatus(id: string, status: OrderStatus) {
  return authenticatedRequest<ApiOrder>(`/orders/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

export async function updateOrderShipping(id: string, payload: {
  shippingCompany?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shippedAt?: string | null;
}) {
  return authenticatedRequest<ApiOrder>(`/orders/${id}/shipping`, {
    method: "PUT",
    body: JSON.stringify({
      shipping_company: payload.shippingCompany || "",
      tracking_number: payload.trackingNumber || "",
      tracking_url: payload.trackingUrl || "",
      shipped_at: payload.shippedAt || null,
    }),
  });
}

export async function fetchSlides() {
  return authenticatedRequest<ApiSlide[]>("/slider/admin/all");
}

export async function createSlide(payload: {
  tag?: string;
  title: string;
  sub?: string;
  btn?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiSlide>("/slider", {
    method: "POST",
    body: JSON.stringify({
      tag: payload.tag || "",
      title: payload.title,
      sub: payload.sub || "",
      btn: payload.btn || "Kesfet",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function updateSlide(id: string, payload: {
  tag?: string;
  title: string;
  sub?: string;
  btn?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiSlide>(`/slider/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      tag: payload.tag || "",
      title: payload.title,
      sub: payload.sub || "",
      btn: payload.btn || "Kesfet",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function deleteSlide(id: string) {
  return authenticatedRequest<void>(`/slider/${id}`, {
    method: "DELETE",
  });
}

export async function fetchCampaigns() {
  return authenticatedRequest<ApiCampaign[]>("/campaigns/admin/all");
}

export async function createCampaign(payload: {
  name: string;
  type: string;
  value: number;
  endDate?: string | null;
  active: boolean;
}) {
  return authenticatedRequest<ApiCampaign>("/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      type: payload.type,
      value: payload.value,
      end_date: payload.endDate || null,
      active: payload.active,
    }),
  });
}

export async function updateCampaign(id: string, payload: {
  name: string;
  type: string;
  value: number;
  endDate?: string | null;
  active: boolean;
}) {
  return authenticatedRequest<ApiCampaign>(`/campaigns/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      type: payload.type,
      value: payload.value,
      end_date: payload.endDate || null,
      active: payload.active,
    }),
  });
}

export async function deleteCampaign(id: string) {
  return authenticatedRequest<void>(`/campaigns/${id}`, {
    method: "DELETE",
  });
}

export async function fetchCollections() {
  return authenticatedRequest<ApiCollection[]>("/collections/admin/all");
}

export async function createCollection(payload: {
  title: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  linkUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiCollection>("/collections", {
    method: "POST",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      description: payload.description || "",
      image_url: payload.imageUrl || "",
      link_url: payload.linkUrl || "urunler",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function updateCollection(id: string, payload: {
  title: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  linkUrl?: string;
  active: boolean;
  sortOrder: number;
}) {
  return authenticatedRequest<ApiCollection>(`/collections/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      description: payload.description || "",
      image_url: payload.imageUrl || "",
      link_url: payload.linkUrl || "urunler",
      active: payload.active,
      sort_order: payload.sortOrder,
    }),
  });
}

export async function deleteCollection(id: string) {
  return authenticatedRequest<void>(`/collections/${id}`, {
    method: "DELETE",
  });
}

export async function fetchBlogPosts() {
  return authenticatedRequest<ApiBlogPost[]>("/blog/admin/all");
}

export async function fetchBlogPost(idOrSlug: string) {
  return publicRequest<ApiBlogPost>(`/blog/${encodeURIComponent(idOrSlug)}`);
}

export async function createBlogPost(payload: {
  title: string;
  slug?: string;
  excerpt?: string;
  content?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
  publishedAt?: string | null;
}) {
  return authenticatedRequest<ApiBlogPost>("/blog", {
    method: "POST",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      excerpt: payload.excerpt || "",
      content: payload.content || "",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
      published_at: payload.publishedAt || null,
    }),
  });
}

export async function updateBlogPost(id: string, payload: {
  title: string;
  slug?: string;
  excerpt?: string;
  content?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
  publishedAt?: string | null;
}) {
  return authenticatedRequest<ApiBlogPost>(`/blog/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: payload.title,
      slug: payload.slug || "",
      excerpt: payload.excerpt || "",
      content: payload.content || "",
      image_url: payload.imageUrl || "",
      active: payload.active,
      sort_order: payload.sortOrder,
      published_at: payload.publishedAt || null,
    }),
  });
}

export async function deleteBlogPost(id: string) {
  return authenticatedRequest<void>(`/blog/${id}`, {
    method: "DELETE",
  });
}

export async function fetchOrganizationSummary() {
  return authenticatedRequest<OrganizationSummary>("/organizations/current/summary");
}

export async function fetchSuperAdminOverview() {
  return authenticatedRequest<SuperAdminOverview>("/organizations/superadmin/overview");
}

export async function updateOrganizationSettings(payload: { name: string; slug: string; settings?: StoreSettings }) {
  return authenticatedRequest<ApiOrganizationSettings>("/organizations/current", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function regeneratePublicAccessToken() {
  return authenticatedRequest<ApiOrganizationSettings>("/organizations/current/public-access-token/regenerate", {
    method: "POST",
  });
}

export async function changeOrganizationEmail(payload: {
  currentEmail: string;
  newEmail: string;
  newEmailConfirm: string;
}) {
  return authenticatedRequest<ApiOrganizationSettings>("/organizations/current/email", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export type ApiCustomColor = {
  name: string;
  hex: string;
  value: string;
};

export async function fetchOrganizationColors() {
  return authenticatedRequest<ApiCustomColor[]>("/organizations/colors");
}

export async function addOrganizationColor(payload: { name: string; hex: string }) {
  return authenticatedRequest<ApiCustomColor>("/organizations/colors", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchTeamMembers() {
  return authenticatedRequest<ApiTeamMember[]>("/organizations/current/members");
}

export async function fetchOrganizationInvites() {
  return authenticatedRequest<ApiOrganizationInvite[]>("/organizations/current/invites");
}

export async function createOrganizationInvite(payload: { email: string; role: "admin" | "member" | "viewer" }) {
  return authenticatedRequest<ApiOrganizationInvite>("/organizations/current/invites", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateTeamMemberRole(id: string, role: "admin" | "member" | "viewer") {
  return authenticatedRequest<ApiTeamMember>(`/organizations/current/members/${id}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export async function removeTeamMember(id: string) {
  return authenticatedRequest<void>(`/organizations/current/members/${id}`, {
    method: "DELETE",
  });
}
