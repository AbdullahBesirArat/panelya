import type { SessionOrganization, SessionUser } from "@/store/session";

export type ProductStatus = "active" | "draft" | "out";
export type OrderStatus =
  | "new"
  | "payment_pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "paid";
export type OrderLifecycleStatus =
  | "pending_payment"
  | "confirmed"
  | "paid"
  | "processing"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "return_requested"
  | "partially_refunded"
  | "refunded";
export type PaymentStatus =
  | "pending"
  | "manual_pending"
  | "authorized"
  | "paid"
  | "failed"
  | "cancelled"
  | "partially_refunded"
  | "refunded";
export type FulfillmentStatus =
  | "unfulfilled"
  | "processing"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "returned"
  | "cancelled";

export type SessionResponse = {
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

export class ApiError extends Error {
  status: number;
  requestId: string | null;
  /**
   * Machine-readable backend code (PLAN_LIMIT_REACHED, SUBSCRIPTION_ACCESS_DENIED,
   * INVALID_SUBSCRIPTION_TRANSITION, SUBSCRIPTION_PROVIDER_NOT_CONFIGURED, ...). The
   * generic HTTP-status message is for display; this is what callers branch on, so a UI
   * never has to re-derive policy by string-matching a human sentence.
   */
  code: string | null;

  constructor(
    message: string,
    status: number,
    requestId: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    this.code = code;
  }
}

export function getApiErrorCode(error: unknown) {
  return error instanceof ApiError ? error.code : null;
}

export function getApiErrorStatus(error: unknown) {
  return error instanceof ApiError ? error.status : null;
}

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
  featured_in_category: boolean;
  emoji: string;
  created_at: string;
  updated_at: string;
};

export type ProductVariant = {
  id?: string | number;
  product_id?: string | number;
  color: string;
  size: string;
  sku?: string | null;
  stock: number;
  on_hand?: number;
  reserved?: number;
  available?: number;
  is_default?: boolean;
  is_active?: boolean;
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
  subtotal: string;
  discount_total: string;
  campaign_discount: string;
  coupon_discount: string;
  shipping_discount: string;
  coupon_code: string | null;
  promotion_snapshot: Record<string, unknown>;
  status: OrderStatus;
  order_status: OrderLifecycleStatus;
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  version: number;
  payment_provider: string | null;
  payment_method: "card" | "iban";
  note: string;
  gift_wrap: boolean;
  // A24.5: immutable per-order snapshot; never re-read from gift_wrap_options.
  gift_wrap_fee?: string | null;
  gift_note?: string | null;
  gift_wrap_snapshot?: {
    selected?: boolean;
    option_id?: number;
    title?: string;
    description?: string;
    fee?: number;
    currency?: string;
    note?: string;
  } | null;
  shipping_fee: string;
  shipping_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
  tags: ApiOrderTag[];
  assignment: ApiOrderAssignment | null;
};

export type ApiOrderTag = {
  id: string;
  name: string;
  color: string;
};

export type ApiOrderAssignment = {
  id: string;
  assigned_user_id?: string;
  userId?: string;
  assigned_user_name?: string;
  assigned_user_email?: string;
  name?: string;
  email?: string;
  assigned_at?: string;
};

export type ApiOrderEvent = {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: "system" | "staff" | "customer" | "payment_provider" | "worker";
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  public_message: string | null;
  internal_metadata: Record<string, unknown>;
  order_version: number;
  created_at: string;
};

export type ApiOrderNote = {
  id: string;
  visibility: "internal" | "customer";
  author_user_id: string | null;
  author_name: string;
  content: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
};

export type OrderOperationsMetadata = {
  tags: ApiOrderTag[];
  members: Array<{ id: string; name: string; email: string; role: string }>;
};

export type ApiOrderDetail = Omit<ApiOrder, "items" | "customer"> & {
  customer: {
    id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  current_customer: {
    id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  shipping_address: Record<string, unknown>;
  items: Array<{
    id: string;
    product_id: string | null;
    variant_id: string | null;
    name: string;
    color: string;
    size: string;
    sku: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>;
  events: ApiOrderEvent[];
  notes: ApiOrderNote[];
  tags: ApiOrderTag[];
  assignment: ApiOrderAssignment | null;
  valid_transitions: {
    order: OrderLifecycleStatus[];
    payment: PaymentStatus[];
    fulfillment: FulfillmentStatus[];
  };
  packing_list: {
    orderId: string;
    orderCode: string;
    generatedAt: string;
    customer: Record<string, unknown>;
    shippingAddress: Record<string, unknown>;
    giftWrap: boolean;
    giftWrapTitle?: string;
    giftNote: string;
    items: Array<{
      productId: string;
      variantId: string;
      name: string;
      sku: string;
      variant: string;
      quantity: number;
    }>;
  };
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
    storefront_url?: string | null;
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
  storefront_url?: string | null;
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
  whatsappPhone?: string;
  whatsappUrl?: string;
  iban?: string;
  ibanHolderName?: string;
  bankName?: string;
  paymentNote?: string;
  shoppingNotes?: {
    freeShipping?: {
      enabled?: boolean;
      description?: string;
    };
    returns?: {
      enabled?: boolean;
      title?: string;
      description?: string;
      days?: number;
    };
    payment?: {
      enabled?: boolean;
      title?: string;
      description?: string;
    };
  };
  publicShoppingNotes?: Array<{
    key: string;
    title: string;
    description: string;
  }>;
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

export type ApiCoupon = {
  id: string;
  organization_id: string;
  code: string;
  normalized_code: string;
  name: string;
  internal_description: string;
  discount_type: "percentage" | "fixed" | "free_shipping";
  value: string;
  minimum_subtotal: string;
  maximum_discount: string | null;
  starts_at: string | null;
  ends_at: string | null;
  total_usage_limit: number | null;
  per_customer_limit: number | null;
  first_order_only: boolean;
  status: "active" | "inactive";
  stacking_policy: "exclusive" | "with_campaign" | "best_discount";
  priority: number;
  redeemed_count: number;
  reserved_count: number;
  include_product_ids: number[];
  exclude_product_ids: number[];
  include_category_ids: number[];
  exclude_category_ids: number[];
  include_collection_ids: number[];
  exclude_collection_ids: number[];
  created_at: string;
  updated_at: string;
};

export type ApiCouponRedemption = {
  id: string;
  order_id: string;
  order_code: string;
  customer_name: string | null;
  email: string | null;
  discount_amount: string;
  status: "reserved" | "redeemed" | "released";
  created_at: string;
};

export type PromotionPricing = {
  subtotal: number;
  discount: number;
  campaignDiscount: number;
  couponDiscount: number;
  shippingDiscount: number;
  shippingFee: number;
  total: number;
  coupon: null | {
    code: string;
    name: string;
    applied: boolean;
    notAppliedReason: string | null;
  };
  breakdown: Array<{
    source: string;
    label: string;
    amount: number;
    code?: string;
  }>;
};
