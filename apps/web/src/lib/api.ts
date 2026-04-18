import { useSessionStore, type SessionOrganization, type SessionUser } from "@/store/session";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000/api";

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

export type MeResponse = {
  actorType: "app" | "admin";
  user?: SessionUser;
  currentOrganization?: SessionOrganization;
  organizations?: SessionOrganization[];
  role?: string;
};

export type ApiCategory = {
  id: string;
  name: string;
  slug: string;
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
  created_at: string;
  updated_at: string;
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
  shipping_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
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

export type OrganizationSummary = {
  organization: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    created_at: string;
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
  throw new Error(body.error || `API request failed: ${response.status}`);
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
  if (options.body != null) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) await readError(response);
  return parseResponse<T>(response);
}

async function tryRefreshSession() {
  const state = useSessionStore.getState();
  if (!state.refreshToken) return false;

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
  }
}

async function authenticatedRequest<T>(path: string, options: RequestInit = {}, canRetry = true): Promise<T> {
  const state = useSessionStore.getState();
  const headers = new Headers(options.headers);

  if (options.body != null) {
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

export async function createCategory(payload: { name: string; slug?: string }) {
  return authenticatedRequest<ApiCategory>("/categories", {
    method: "POST",
    body: JSON.stringify(payload),
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
    }),
  });
}

export async function deleteProduct(id: string) {
  return authenticatedRequest<void>(`/products/${id}`, {
    method: "DELETE",
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

export async function updateOrderStatus(id: string, status: OrderStatus) {
  return authenticatedRequest<ApiOrder>(`/orders/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status }),
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

export async function fetchOrganizationSummary() {
  return authenticatedRequest<OrganizationSummary>("/organizations/current/summary");
}
