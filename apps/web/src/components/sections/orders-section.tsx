"use client";

import type { FormEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { MetricGrid } from "@/components/page-kit";
import {
  applyBulkOrderTransition,
  createOrderNote,
  createOrderTag,
  deleteOrderNote,
  fetchOrderDetail,
  fetchOrderOperationsMetadata,
  fetchOrders,
  previewBulkOrderTransition,
  replaceOrderTags,
  transitionOrder,
  updateOrderAssignment,
  updateOrderShipping,
  type ApiOrder,
  type ApiOrderDetail,
  type FulfillmentStatus,
  type OrderLifecycleStatus,
  type OrderOperationsMetadata,
  type OrderStateDomain,
  type OrderStateValue,
  type PaymentStatus,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { queryKeys } from "@/lib/query-keys";
import { useUrlFilterState } from "@/lib/use-url-filter-state";
import {
  FieldLabel,
  InlineError,
  Panel,
  SectionError,
  SectionLoading,
  formatCount,
  formatCurrency,
  formatDateTime,
  useSummaryQuery,
} from "@/components/operations-shared";
import { useToastStore } from "@/store/toast";

const orderLabels: Record<OrderLifecycleStatus, string> = {
  pending_payment: "Ödeme bekliyor",
  confirmed: "Onaylandı",
  paid: "Ödendi",
  processing: "Hazırlanıyor",
  ready_to_ship: "Kargoya hazır",
  shipped: "Kargoda",
  delivered: "Teslim edildi",
  cancelled: "İptal",
  return_requested: "İade talebi",
  partially_refunded: "Kısmi iade",
  refunded: "İade edildi",
};

const paymentLabels: Record<PaymentStatus, string> = {
  pending: "Bekliyor",
  manual_pending: "Havale bekliyor",
  authorized: "Provizyonda",
  paid: "Ödendi",
  failed: "Başarısız",
  cancelled: "İptal",
  partially_refunded: "Kısmi iade",
  refunded: "İade edildi",
};

const fulfillmentLabels: Record<FulfillmentStatus, string> = {
  unfulfilled: "Hazırlanmadı",
  processing: "Hazırlanıyor",
  ready_to_ship: "Kargoya hazır",
  shipped: "Kargoda",
  delivered: "Teslim edildi",
  returned: "Geri döndü",
  cancelled: "İptal",
};

const orderStatuses = Object.keys(orderLabels) as OrderLifecycleStatus[];
const paymentStatuses = Object.keys(paymentLabels) as PaymentStatus[];
const fulfillmentStatuses = Object.keys(
  fulfillmentLabels,
) as FulfillmentStatus[];
const optionalColumns = [
  "customer",
  "total",
  "payment",
  "fulfillment",
  "assignment",
  "tags",
  "created",
] as const;
type OptionalColumn = (typeof optionalColumns)[number];
type Filters = {
  search: string;
  orderStatus: OrderLifecycleStatus | "";
  paymentStatus: PaymentStatus | "";
  fulfillmentStatus: FulfillmentStatus | "";
  assignedTo: string;
  tagId: string;
};

const columnLabels: Record<OptionalColumn, string> = {
  customer: "Müşteri",
  total: "Tutar",
  payment: "Ödeme",
  fulfillment: "Fulfillment",
  assignment: "Atanan",
  tags: "Etiketler",
  created: "Tarih",
};

function emptyShippingForm() {
  return {
    version: 1,
    shippingCompany: "",
    trackingNumber: "",
    trackingUrl: "",
    shippedAt: "",
  };
}

function stateLabel(domain: OrderStateDomain, status: string) {
  if (domain === "order")
    return orderLabels[status as OrderLifecycleStatus] || status;
  if (domain === "payment")
    return paymentLabels[status as PaymentStatus] || status;
  return fulfillmentLabels[status as FulfillmentStatus] || status;
}

function stateTone(status: string) {
  if (["cancelled", "failed", "refunded", "returned"].includes(status))
    return "border-coral/30 bg-coral/10 text-coral";
  if (
    [
      "pending_payment",
      "pending",
      "manual_pending",
      "return_requested",
    ].includes(status)
  )
    return "border-sun/40 bg-sun/15 text-zinc-700";
  if (["paid", "delivered", "confirmed"].includes(status))
    return "border-leaf/30 bg-leaf/10 text-leaf";
  return "border-mint/30 bg-mint/10 text-mint";
}

function StateBadge({
  domain,
  status,
}: {
  domain: OrderStateDomain;
  status: string;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${stateTone(status)}`}
    >
      {stateLabel(domain, status)}
    </span>
  );
}

export function OrdersSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.pushToast);
  const summaryQuery = useSummaryQuery(organizationSlug);
  const [search, setSearch] = useUrlFilterState<string>("q", "");
  const [orderStatus, setOrderStatus] = useUrlFilterState<Filters["orderStatus"]>("orderStatus", "");
  const [paymentStatus, setPaymentStatus] = useUrlFilterState<Filters["paymentStatus"]>("paymentStatus", "");
  const [fulfillmentStatus, setFulfillmentStatus] = useUrlFilterState<Filters["fulfillmentStatus"]>("fulfillmentStatus", "");
  const [assignedTo, setAssignedTo] = useUrlFilterState<string>("assignedTo", "");
  const [tagId, setTagId] = useUrlFilterState<string>("tagId", "");
  const filters = useMemo<Filters>(() => ({
    search,
    orderStatus,
    paymentStatus,
    fulfillmentStatus,
    assignedTo,
    tagId,
  }), [search, orderStatus, paymentStatus, fulfillmentStatus, assignedTo, tagId]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<Set<OptionalColumn>>(
    () => {
      if (typeof window === "undefined") return new Set(optionalColumns);
      try {
        const saved = JSON.parse(
          localStorage.getItem("panelya:orders:columns:v1") || "null",
        ) as OptionalColumn[] | null;
        if (saved?.length)
          return new Set(
            saved.filter((column) => optionalColumns.includes(column)),
          );
      } catch {
        /* use defaults */
      }
      return new Set(optionalColumns);
    },
  );
  const [bulkDomain, setBulkDomain] = useState<OrderStateDomain>("order");
  const [bulkStatus, setBulkStatus] = useState<OrderStateValue>("processing");
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null);
  const [shippingForm, setShippingForm] = useState(emptyShippingForm);
  const debouncedSearch = useDebouncedValue(filters.search);

  const filtersKey = useMemo(
    () => JSON.stringify({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );
  const ordersQuery = useQuery({
    queryKey: queryKeys.orders.list(organizationSlug, filtersKey),
    queryFn: ({ signal }) => fetchOrders({ ...filters, q: debouncedSearch, limit: 100 }, signal),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const metadataQuery = useQuery({
    queryKey: queryKeys.orders.metadata(organizationSlug),
    queryFn: fetchOrderOperationsMetadata,
    staleTime: 60_000,
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.orders.detail(organizationSlug, selectedOrderId),
    queryFn: () => fetchOrderDetail(selectedOrderId || ""),
    enabled: Boolean(selectedOrderId),
    staleTime: 5_000,
  });

  const invalidateOrders = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.all(organizationSlug),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.summary.detail(organizationSlug),
      }),
    ]);
  }, [organizationSlug, queryClient]);

  const bulkPreview = useMutation({
    mutationFn: () =>
      previewBulkOrderTransition({
        orderIds: Array.from(selectedIds),
        domain: bulkDomain,
        status: bulkStatus,
      }),
  });
  const bulkApply = useMutation({
    mutationFn: () => {
      const validIds = new Set(
        (bulkPreview.data?.results || [])
          .filter((row) => row.valid)
          .map((row) => String(row.id)),
      );
      const orders = (ordersQuery.data || [])
        .filter((order) => validIds.has(order.id))
        .map((order) => ({ id: order.id, version: order.version }));
      return applyBulkOrderTransition({
        orders,
        domain: bulkDomain,
        status: bulkStatus,
      });
    },
    onSuccess: async (result) => {
      pushToast({
        title: "Toplu işlem tamamlandı",
        description: `${result.successCount} başarılı, ${result.failureCount} başarısız.`,
        tone: result.failureCount ? "info" : "success",
      });
      setSelectedIds(new Set());
      await invalidateOrders();
    },
  });
  const shippingMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      updateOrderShipping(id, {
        ...shippingForm,
        shippedAt: shippingForm.shippedAt || null,
      }),
    onSuccess: async () => {
      setShippingOrderId(null);
      setShippingForm(emptyShippingForm());
      pushToast({
        title: "Kargo bilgisi kaydedildi",
        description: "Takip bilgileri timeline'a işlendi.",
        tone: "success",
      });
      await invalidateOrders();
    },
  });

  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const canCollaborate = canManage || currentRole === "member";
  const orders = useMemo(() => ordersQuery.data || [], [ordersQuery.data]);
  const metadata = metadataQuery.data || { tags: [], members: [] };

  function toggleColumn(column: OptionalColumn) {
    setVisibleColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      localStorage.setItem(
        "panelya:orders:columns:v1",
        JSON.stringify(Array.from(next)),
      );
      return next;
    });
  }

  function toggleOrder(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    bulkPreview.reset();
  }

  function openShipping(
    order: Pick<
      ApiOrder,
      | "id"
      | "version"
      | "shipping_company"
      | "tracking_number"
      | "tracking_url"
      | "shipped_at"
    >,
  ) {
    setShippingForm({
      version: order.version,
      shippingCompany: order.shipping_company || "",
      trackingNumber: order.tracking_number || "",
      trackingUrl: order.tracking_url || "",
      shippedAt: order.shipped_at ? order.shipped_at.slice(0, 16) : "",
    });
    setShippingOrderId(order.id);
  }

  if (summaryQuery.isLoading || (ordersQuery.isLoading && !ordersQuery.data))
    return <SectionLoading />;
  if (summaryQuery.isError || ordersQuery.isError || !summaryQuery.data) {
    return (
      <SectionError
        message="Sipariş operasyon verisi yüklenemedi."
        onRetry={() => {
          void summaryQuery.refetch();
          void ordersQuery.refetch();
        }}
      />
    );
  }

  return (
    <>
      <MetricGrid
        metrics={[
          {
            label: "Bugün",
            value: formatCount(summaryQuery.data.metrics.today_orders),
            tone: "mint",
          },
          {
            label: "Ödeme bekliyor",
            value: formatCount(summaryQuery.data.metrics.pending_orders),
            tone: "sun",
          },
          {
            label: "Kargoda",
            value: formatCount(summaryQuery.data.metrics.shipped_orders),
            tone: "leaf",
          },
          {
            label: "İptal",
            value: formatCount(summaryQuery.data.metrics.cancelled_orders),
            tone: "coral",
          },
        ]}
      />

      <Panel
        title="Sipariş operasyonları"
        description="Ayrık sipariş, ödeme ve fulfillment durumları"
        actions={
          <details className="relative">
            <summary className="focus-ring cursor-pointer rounded-lg border border-line px-3 py-2 text-sm font-semibold">
              Kolonlar
            </summary>
            <div className="absolute right-0 z-10 mt-2 w-48 rounded-lg border border-line bg-white p-3 shadow-panel">
              {optionalColumns.map((column) => (
                <label
                  className="flex items-center gap-2 py-1 text-sm"
                  key={column}
                >
                  <input
                    checked={visibleColumns.has(column)}
                    onChange={() => toggleColumn(column)}
                    type="checkbox"
                  />
                  {columnLabels[column]}
                </label>
              ))}
            </div>
          </details>
        }
      >
        <div className="grid gap-2 border-b border-line pb-4 md:grid-cols-3 xl:grid-cols-6">
          <input
            aria-label="Sipariş ara"
            className="focus-ring h-10 rounded-lg border border-line px-3 text-sm"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Kod veya müşteri ara"
            value={filters.search}
          />
          <FilterSelect
            label="Tüm sipariş durumları"
            onChange={(value) => setOrderStatus(value as Filters["orderStatus"])}
            options={orderStatuses.map((value) => ({
              value,
              label: orderLabels[value],
            }))}
            value={filters.orderStatus}
          />
          <FilterSelect
            label="Tüm ödeme durumları"
            onChange={(value) => setPaymentStatus(value as Filters["paymentStatus"])}
            options={paymentStatuses.map((value) => ({
              value,
              label: paymentLabels[value],
            }))}
            value={filters.paymentStatus}
          />
          <FilterSelect
            label="Tüm fulfillment durumları"
            onChange={(value) => setFulfillmentStatus(value as Filters["fulfillmentStatus"])}
            options={fulfillmentStatuses.map((value) => ({
              value,
              label: fulfillmentLabels[value],
            }))}
            value={filters.fulfillmentStatus}
          />
          <FilterSelect
            label="Tüm görevliler"
            onChange={setAssignedTo}
            options={metadata.members.map((member) => ({
              value: member.id,
              label: member.name || member.email,
            }))}
            value={filters.assignedTo}
          />
          <FilterSelect
            label="Tüm etiketler"
            onChange={setTagId}
            options={metadata.tags.map((tag) => ({
              value: tag.id,
              label: tag.name,
            }))}
            value={filters.tagId}
          />
        </div>

        {canManage && selectedIds.size ? (
          <div className="my-4 rounded-lg border border-mint/30 bg-mint/5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="mr-2 text-sm">
                {selectedIds.size} sipariş seçili
              </strong>
              <select
                className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-sm"
                onChange={(event) => {
                  const nextDomain = event.target.value as OrderStateDomain;
                  setBulkDomain(nextDomain);
                  setBulkStatus(
                    nextDomain === "order"
                      ? "processing"
                      : nextDomain === "payment"
                        ? "paid"
                        : "processing",
                  );
                  bulkPreview.reset();
                }}
                value={bulkDomain}
              >
                <option value="order">Sipariş</option>
                <option value="payment">Ödeme</option>
                <option value="fulfillment">Fulfillment</option>
              </select>
              <select
                className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-sm"
                onChange={(event) => {
                  setBulkStatus(event.target.value as OrderStateValue);
                  bulkPreview.reset();
                }}
                value={bulkStatus}
              >
                {(bulkDomain === "order"
                  ? orderStatuses
                  : bulkDomain === "payment"
                    ? paymentStatuses
                    : fulfillmentStatuses
                ).map((status) => (
                  <option key={status} value={status}>
                    {stateLabel(bulkDomain, status)}
                  </option>
                ))}
              </select>
              <Button
                disabled={bulkPreview.isPending}
                onClick={() => bulkPreview.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                Önizle
              </Button>
              <Button
                disabled={!bulkPreview.data?.validCount || bulkApply.isPending}
                onClick={() => bulkApply.mutate()}
                size="sm"
                type="button"
                variant="mint"
              >
                Geçerli olanları uygula
              </Button>
            </div>
            {bulkPreview.data ? (
              <p className="mt-3 text-sm text-zinc-600">
                {bulkPreview.data.validCount}/{bulkPreview.data.total} sipariş
                bu geçişe uygun. Uygun olmayanlar değiştirilmez.
              </p>
            ) : null}
            {bulkApply.data?.failureCount ? (
              <p className="mt-2 text-sm text-coral">
                {bulkApply.data.results
                  .filter((row) => !row.ok)
                  .map((row) => `${row.id}: ${row.error}`)
                  .join(" · ")}
              </p>
            ) : null}
            {bulkPreview.error || bulkApply.error ? (
              <InlineError
                message={
                  (bulkPreview.error || bulkApply.error)?.message ||
                  "Toplu işlem başarısız"
                }
              />
            ) : null}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line bg-zinc-50 text-xs uppercase text-zinc-600">
              <tr>
                <th className="px-3 py-3">
                  <input
                    aria-label="Tüm siparişleri seç"
                    checked={
                      orders.length > 0 && selectedIds.size === orders.length
                    }
                    onChange={(event) => {
                      setSelectedIds(
                        event.target.checked
                          ? new Set(orders.map((order) => order.id))
                          : new Set(),
                      );
                      bulkPreview.reset();
                    }}
                    type="checkbox"
                  />
                </th>
                <th className="px-3 py-3">Kod / durum</th>
                {optionalColumns
                  .filter((column) => visibleColumns.has(column))
                  .map((column) => (
                    <th className="px-3 py-3" key={column}>
                      {columnLabels[column]}
                    </th>
                  ))}
                <th className="px-3 py-3">Aksiyon</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.map((order) => (
                <OrderRow
                  canManage={canManage}
                  columns={visibleColumns}
                  key={order.id}
                  onOpen={() => setSelectedOrderId(order.id)}
                  onOpenShipping={() => openShipping(order)}
                  onToggle={() => toggleOrder(order.id)}
                  order={order}
                  selected={selectedIds.has(order.id)}
                />
              ))}
            </tbody>
          </table>
          {!orders.length ? (
            <p className="p-8 text-center text-sm text-zinc-600">
              Bu filtrelerle sipariş bulunamadı.
            </p>
          ) : null}
        </div>
      </Panel>

      {selectedOrderId ? (
        <OrderDetailModal
          canCollaborate={canCollaborate}
          canManage={canManage}
          isLoading={detailQuery.isLoading}
          metadata={metadata}
          onChanged={invalidateOrders}
          onClose={() => setSelectedOrderId(null)}
          onOpenShipping={(order) => {
            setSelectedOrderId(null);
            openShipping(order);
          }}
          order={detailQuery.data || null}
          organizationSlug={organizationSlug}
        />
      ) : null}
      {shippingOrderId ? (
        <ShippingModal
          error={shippingMutation.error?.message || ""}
          form={shippingForm}
          isSaving={shippingMutation.isPending}
          onChange={setShippingForm}
          onClose={() => setShippingOrderId(null)}
          onSubmit={(event) => {
            event.preventDefault();
            shippingMutation.mutate({ id: shippingOrderId });
          }}
        />
      ) : null}
    </>
  );
}

function FilterSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <select
      aria-label={label}
      className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function OrderRow({
  canManage,
  columns,
  onOpen,
  onOpenShipping,
  onToggle,
  order,
  selected,
}: {
  canManage: boolean;
  columns: Set<OptionalColumn>;
  onOpen: () => void;
  onOpenShipping: () => void;
  onToggle: () => void;
  order: ApiOrder;
  selected: boolean;
}) {
  return (
    <tr>
      <td className="px-3 py-3">
        <input
          aria-label={`${order.order_code} seç`}
          checked={selected}
          onChange={onToggle}
          type="checkbox"
        />
      </td>
      <td className="px-3 py-3">
        <button
          className="focus-ring font-bold underline-offset-4 hover:underline"
          onClick={onOpen}
          type="button"
        >
          {order.order_code}
        </button>
        <div className="mt-2">
          <StateBadge domain="order" status={order.order_status} />
        </div>
      </td>
      {columns.has("customer") ? (
        <td className="px-3 py-3">
          <p className="font-semibold">{order.customer || "Misafir"}</p>
          <p className="text-xs text-zinc-600">{order.email || "-"}</p>
        </td>
      ) : null}
      {columns.has("total") ? (
        <td className="px-3 py-3 font-semibold">
          {formatCurrency(order.total)}
        </td>
      ) : null}
      {columns.has("payment") ? (
        <td className="px-3 py-3">
          <StateBadge domain="payment" status={order.payment_status} />
          <p className="mt-1 text-xs text-zinc-600">
            {order.payment_method === "iban" ? "IBAN" : "Kart"}
          </p>
        </td>
      ) : null}
      {columns.has("fulfillment") ? (
        <td className="px-3 py-3">
          <StateBadge domain="fulfillment" status={order.fulfillment_status} />
          {order.tracking_number ? (
            <p className="mt-1 text-xs text-zinc-600">
              {order.tracking_number}
            </p>
          ) : null}
        </td>
      ) : null}
      {columns.has("assignment") ? (
        <td className="px-3 py-3 text-zinc-600">
          {order.assignment?.name ||
            order.assignment?.assigned_user_name ||
            "Atanmadı"}
        </td>
      ) : null}
      {columns.has("tags") ? (
        <td className="px-3 py-3">
          <div className="flex flex-wrap gap-1">
            {(order.tags || []).map((tag) => (
              <span
                className="rounded-full border px-2 py-0.5 text-xs"
                key={tag.id}
                style={{ borderColor: tag.color }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        </td>
      ) : null}
      {columns.has("created") ? (
        <td className="px-3 py-3 text-xs text-zinc-600">
          {formatDateTime(order.created_at)}
        </td>
      ) : null}
      <td className="px-3 py-3">
        <div className="flex gap-2">
          <Button onClick={onOpen} size="sm" type="button" variant="outline">
            Operasyon
          </Button>
          {canManage ? (
            <Button
              onClick={onOpenShipping}
              size="sm"
              type="button"
              variant="ghost"
            >
              Kargo
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function OrderDetailModal({
  canCollaborate,
  canManage,
  isLoading,
  metadata,
  onChanged,
  onClose,
  onOpenShipping,
  order,
  organizationSlug,
}: {
  canCollaborate: boolean;
  canManage: boolean;
  isLoading: boolean;
  metadata: OrderOperationsMetadata;
  onChanged: () => Promise<void>;
  onClose: () => void;
  onOpenShipping: (order: ApiOrderDetail) => void;
  order: ApiOrderDetail | null;
  organizationSlug: string;
}) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.pushToast);
  const [noteContent, setNoteContent] = useState("");
  const [noteVisibility, setNoteVisibility] = useState<"internal" | "customer">(
    "internal",
  );
  const [tagDraft, setTagDraft] = useState<string[] | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [assignmentDraft, setAssignmentDraft] = useState<string | undefined>(
    undefined,
  );
  const tagIds = tagDraft ?? order?.tags.map((tag) => tag.id) ?? [];
  const assignedUserId =
    assignmentDraft ??
    order?.assignment?.assigned_user_id ??
    order?.assignment?.userId ??
    "";

  const refreshDetail = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(organizationSlug, order?.id),
      }),
      onChanged(),
    ]);
  }, [onChanged, order?.id, organizationSlug, queryClient]);
  const transitionMutation = useMutation({
    mutationFn: ({
      domain,
      status,
    }: {
      domain: OrderStateDomain;
      status: OrderStateValue;
    }) =>
      transitionOrder(order?.id || "", {
        domain,
        status,
        version: order?.version || 0,
      }),
    onSuccess: async () => {
      pushToast({
        title: "Durum güncellendi",
        description: "Timeline ve bildirim kaydı oluşturuldu.",
        tone: "success",
      });
      await refreshDetail();
    },
  });
  const noteMutation = useMutation({
    mutationFn: () =>
      createOrderNote(order?.id || "", {
        visibility: noteVisibility,
        content: noteContent,
      }),
    onSuccess: async () => {
      setNoteContent("");
      await refreshDetail();
    },
  });
  const noteDeleteMutation = useMutation({
    mutationFn: (noteId: string) => deleteOrderNote(order?.id || "", noteId),
    onSuccess: refreshDetail,
  });
  const tagMutation = useMutation({
    mutationFn: () => replaceOrderTags(order?.id || "", tagIds),
    onSuccess: async () => {
      setTagDraft(null);
      await refreshDetail();
    },
  });
  const tagCreateMutation = useMutation({
    mutationFn: () =>
      createOrderTag({ name: newTagName.trim(), color: "#71717a" }),
    onSuccess: async (tag) => {
      setNewTagName("");
      setTagDraft(Array.from(new Set([...tagIds, tag.id])));
      await queryClient.invalidateQueries({
        queryKey: queryKeys.orders.metadata(organizationSlug),
      });
    },
  });
  const assignmentMutation = useMutation({
    mutationFn: () =>
      updateOrderAssignment(order?.id || "", assignedUserId || null),
    onSuccess: async () => {
      setAssignmentDraft(undefined);
      await refreshDetail();
    },
  });

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950/45 px-4 py-6">
      <section className="mx-auto w-full max-w-6xl rounded-xl bg-white p-5 shadow-panel">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
              Sipariş operasyonu
            </p>
            <h2 className="mt-1 text-2xl font-bold">
              {order?.order_code || "Yükleniyor"}
            </h2>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={!order}
              onClick={() => window.print()}
              type="button"
              variant="outline"
            >
              Paketleme çıktısı
            </Button>
            <Button onClick={onClose} type="button" variant="ghost">
              Kapat
            </Button>
          </div>
        </div>
        {isLoading || !order ? (
          <p className="mt-6 text-sm text-zinc-600">Sipariş yükleniyor.</p>
        ) : (
          <div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-5">
              <section className="grid gap-3 sm:grid-cols-3">
                <InfoBox
                  label="Sipariş"
                  value={orderLabels[order.order_status]}
                />
                <InfoBox
                  label="Ödeme"
                  value={paymentLabels[order.payment_status]}
                />
                <InfoBox
                  label="Fulfillment"
                  value={fulfillmentLabels[order.fulfillment_status]}
                />
              </section>
              <section className="rounded-lg border border-line p-4">
                <h3 className="font-bold">Geçerli aksiyonlar</h3>
                {canManage ? (
                  <div className="mt-3 space-y-3">
                    {(
                      ["order", "payment", "fulfillment"] as OrderStateDomain[]
                    ).map((domain) => (
                      <div
                        className="flex flex-wrap items-center gap-2"
                        key={domain}
                      >
                        <span className="w-24 text-xs font-semibold uppercase text-zinc-600">
                          {domain}
                        </span>
                        {order.valid_transitions[domain].length ? (
                          order.valid_transitions[domain].map((status) => (
                            <Button
                              disabled={transitionMutation.isPending}
                              key={status}
                              onClick={() =>
                                transitionMutation.mutate({ domain, status })
                              }
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              {stateLabel(domain, status)}
                            </Button>
                          ))
                        ) : (
                          <span className="text-sm text-zinc-600">
                            Terminal durum
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-zinc-600">
                    Durum aksiyonları salt okunur.
                  </p>
                )}
                {transitionMutation.error ? (
                  <InlineError message={transitionMutation.error.message} />
                ) : null}
              </section>
              <section className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-line p-4">
                  <h3 className="font-bold">Müşteri ve adres snapshot</h3>
                  <div className="mt-3 space-y-1 text-sm text-zinc-600">
                    <p className="font-semibold text-ink">
                      {order.customer.name || "Misafir"}
                    </p>
                    <p>{order.customer.email || "-"}</p>
                    <p>{order.customer.phone || "-"}</p>
                    <p>{order.customer.address || "-"}</p>
                  </div>
                </div>
                <div className="rounded-lg border border-line p-4">
                  <div className="flex items-start justify-between">
                    <h3 className="font-bold">Kargo</h3>
                    {canManage ? (
                      <Button
                        onClick={() => onOpenShipping(order)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Düzenle
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-3 space-y-1 text-sm text-zinc-600">
                    <p>Firma: {order.shipping_company || "-"}</p>
                    <p>Takip: {order.tracking_number || "-"}</p>
                    <p>Gönderim: {formatDateTime(order.shipped_at)}</p>
                  </div>
                </div>
              </section>
              <section className="rounded-lg border border-line">
                <div className="border-b border-line p-4">
                  <h3 className="font-bold">Paketleme listesi</h3>
                  <p className="text-xs text-zinc-600">
                    Fiyatlar paket çalışanı çıktısında gösterilmez.
                  </p>
                </div>
                <div className="packing-print p-4">
                  <h2 className="hidden text-xl font-bold print:block">
                    {order.order_code} paketleme listesi
                  </h2>
                  <p className="hidden text-sm print:block">
                    {String(
                      order.packing_list.shippingAddress.address ||
                        order.customer.address ||
                        "",
                    )}
                  </p>
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="py-2 text-left">Ürün / varyant / SKU</th>
                        <th className="py-2 text-right">Adet</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.packing_list.items.map((item, index) => (
                        <tr
                          className="border-b border-line"
                          key={`${item.variantId}-${index}`}
                        >
                          <td className="py-3">
                            <strong>{item.name}</strong>
                            <p className="text-xs text-zinc-600">
                              {item.variant || "Standart"} ·{" "}
                              {item.sku || "SKU yok"}
                            </p>
                          </td>
                          <td className="py-3 text-right font-bold">
                            {item.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {order.packing_list.giftWrap ||
                  order.packing_list.giftNote ? (
                    <div className="mt-4 rounded border p-3 text-sm" data-testid="order-gift-wrap">
                      <strong>Hediye paketi</strong>
                      {/* Sipariş anındaki anlık görüntü: seçenek sonradan
                          değiştirilse bile bu satır değişmez. */}
                      <p>
                        {order.gift_wrap_snapshot?.title ||
                          order.packing_list.giftWrapTitle ||
                          (order.packing_list.giftWrap ? "Hediye paketi" : "—")}
                        {order.gift_wrap_fee != null
                          ? ` · ${Number(order.gift_wrap_fee).toLocaleString("tr-TR", {
                            minimumFractionDigits: 2, maximumFractionDigits: 2,
                          })} ${order.gift_wrap_snapshot?.currency || "TRY"}`
                          : ""}
                      </p>
                      {order.packing_list.giftNote ? (
                        <p className="mt-1 whitespace-pre-line" data-testid="order-gift-note">
                          {order.packing_list.giftNote}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </section>
              <section className="rounded-lg border border-line">
                <div className="border-b border-line p-4">
                  <h3 className="font-bold">
                    Sipariş kalemleri ve ödeme özeti
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-sm">
                    <tbody className="divide-y divide-line">
                      {order.items.map((item) => (
                        <tr key={item.id}>
                          <td className="px-4 py-3">
                            <strong>{item.name}</strong>
                            <p className="text-xs text-zinc-600">
                              {[item.color, item.size, item.sku]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </td>
                          <td className="px-4 py-3">{item.quantity} adet</td>
                          <td className="px-4 py-3 text-right">
                            {formatCurrency(item.line_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid gap-2 border-t border-line p-4 text-sm sm:grid-cols-4">
                  <InfoBox
                    label="Ara toplam"
                    value={formatCurrency(order.subtotal)}
                  />
                  <InfoBox
                    label="İndirim"
                    value={formatCurrency(order.discount_total)}
                  />
                  <InfoBox
                    label="Kargo"
                    value={formatCurrency(order.shipping_fee)}
                  />
                  <InfoBox label="Toplam" value={formatCurrency(order.total)} />
                </div>
              </section>
            </div>
            <aside className="space-y-5">
              <section className="rounded-lg border border-line p-4">
                <h3 className="font-bold">Atama ve etiketler</h3>
                <div className="mt-3 grid gap-3">
                  <FieldLabel htmlFor="orderAssignee">
                    Atanan görevli
                  </FieldLabel>
                  <select
                    className="focus-ring h-10 rounded-lg border border-line px-3 text-sm"
                    disabled={!canManage}
                    id="orderAssignee"
                    onChange={(event) => setAssignmentDraft(event.target.value)}
                    value={assignedUserId}
                  >
                    <option value="">Atanmadı</option>
                    {metadata.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name || member.email}
                      </option>
                    ))}
                  </select>
                  {canManage ? (
                    <Button
                      disabled={assignmentMutation.isPending}
                      onClick={() => assignmentMutation.mutate()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Atamayı kaydet
                    </Button>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {metadata.tags.map((tag) => (
                      <label
                        className="flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
                        key={tag.id}
                        style={{ borderColor: tag.color }}
                      >
                        <input
                          checked={tagIds.includes(tag.id)}
                          disabled={!canCollaborate}
                          onChange={(event) =>
                            setTagDraft(
                              event.target.checked
                                ? [...tagIds, tag.id]
                                : tagIds.filter((id) => id !== tag.id),
                            )
                          }
                          type="checkbox"
                        />
                        {tag.name}
                      </label>
                    ))}
                  </div>
                  {canCollaborate ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        tagCreateMutation.mutate();
                      }}
                    >
                      <input
                        className="focus-ring h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
                        maxLength={50}
                        onChange={(event) => setNewTagName(event.target.value)}
                        placeholder="Yeni etiket"
                        value={newTagName}
                      />
                      <Button
                        disabled={
                          !newTagName.trim() || tagCreateMutation.isPending
                        }
                        size="sm"
                        type="submit"
                        variant="outline"
                      >
                        Oluştur
                      </Button>
                    </form>
                  ) : null}
                  {canCollaborate ? (
                    <Button
                      disabled={tagMutation.isPending}
                      onClick={() => tagMutation.mutate()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Etiketleri kaydet
                    </Button>
                  ) : null}
                </div>
              </section>
              <section className="rounded-lg border border-line p-4">
                <h3 className="font-bold">Notlar</h3>
                {canCollaborate ? (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      noteMutation.mutate();
                    }}
                  >
                    <select
                      className="focus-ring h-9 w-full rounded-lg border border-line px-2 text-sm"
                      onChange={(event) =>
                        setNoteVisibility(
                          event.target.value as "internal" | "customer",
                        )
                      }
                      value={noteVisibility}
                    >
                      <option value="internal">İç not</option>
                      <option value="customer">Müşteriye görünür</option>
                    </select>
                    <textarea
                      className="focus-ring min-h-24 w-full rounded-lg border border-line p-3 text-sm"
                      maxLength={4000}
                      onChange={(event) => setNoteContent(event.target.value)}
                      placeholder="Operasyon notu"
                      value={noteContent}
                    />
                    <Button
                      disabled={!noteContent.trim() || noteMutation.isPending}
                      size="sm"
                      type="submit"
                      variant="mint"
                    >
                      Not ekle
                    </Button>
                  </form>
                ) : null}
                <div className="mt-4 space-y-2">
                  {order.notes.map((note) => (
                    <article
                      className="rounded-lg bg-zinc-50 p-3 text-sm"
                      key={note.id}
                    >
                      <div className="flex justify-between gap-2">
                        <strong>
                          {note.visibility === "customer"
                            ? "Müşteri notu"
                            : "İç not"}
                        </strong>
                        {canManage ? (
                          <button
                            className="text-xs text-coral underline"
                            onClick={() => noteDeleteMutation.mutate(note.id)}
                            type="button"
                          >
                            Sil
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-zinc-700">
                        {note.content}
                      </p>
                      <p className="mt-2 text-xs text-zinc-600">
                        {note.author_name || "Sistem"} ·{" "}
                        {formatDateTime(note.created_at)}
                      </p>
                    </article>
                  ))}
                  {!order.notes.length ? (
                    <p className="text-sm text-zinc-600">Not yok.</p>
                  ) : null}
                </div>
              </section>
              <section className="rounded-lg border border-line p-4">
                <h3 className="font-bold">Timeline ve audit</h3>
                <div className="mt-4 space-y-4 border-l-2 border-line pl-4">
                  {order.events.map((event) => (
                    <article className="relative" key={event.id}>
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-mint" />
                      <p className="text-sm font-semibold">
                        {eventLabel(event.event_type)}
                      </p>
                      {event.from_status || event.to_status ? (
                        <p className="text-xs text-zinc-600">
                          {event.from_status || "-"} → {event.to_status || "-"}
                        </p>
                      ) : null}
                      {event.public_message ? (
                        <p className="mt-1 text-sm text-zinc-700">
                          {event.public_message}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-zinc-600">
                        {event.actor_name || event.actor_type} · v
                        {event.order_version} ·{" "}
                        {formatDateTime(event.created_at)}
                      </p>
                      <p className="text-[11px] text-zinc-600">
                        Kaynak:{" "}
                        {String(event.internal_metadata?.source || "uygulama")}
                      </p>
                    </article>
                  ))}
                  {!order.events.length ? (
                    <p className="text-sm text-zinc-600">Timeline boş.</p>
                  ) : null}
                </div>
              </section>
            </aside>
          </div>
        )}
        {noteMutation.error ||
        tagMutation.error ||
        tagCreateMutation.error ||
        assignmentMutation.error ||
        noteDeleteMutation.error ? (
          <div className="mt-4">
            <InlineError
              message={
                (
                  noteMutation.error ||
                  tagMutation.error ||
                  tagCreateMutation.error ||
                  assignmentMutation.error ||
                  noteDeleteMutation.error
                )?.message || "İşlem başarısız"
              }
            />
          </div>
        ) : null}
        <style jsx global>{`
          @media print {
            body * {
              visibility: hidden !important;
            }
            .packing-print,
            .packing-print * {
              visibility: visible !important;
            }
            .packing-print {
              position: absolute;
              inset: 0;
              width: 100%;
              background: white;
              padding: 24px !important;
            }
          }
        `}</style>
      </section>
    </div>
  );
}

function eventLabel(type: string) {
  return (
    (
      {
        order_created: "Sipariş oluşturuldu",
        order_status_changed: "Sipariş durumu değişti",
        payment_status_changed: "Ödeme durumu değişti",
        fulfillment_status_changed: "Fulfillment durumu değişti",
        note_added: "Not eklendi",
        note_edited: "Not düzenlendi",
        note_deleted: "Not silindi",
        tags_replaced: "Etiketler güncellendi",
        assignment_changed: "Görevli atandı",
        assignment_cleared: "Atama kaldırıldı",
        shipping_updated: "Kargo bilgisi güncellendi",
      } as Record<string, string>
    )[type] || type
  );
}

function ShippingModal({
  error,
  form,
  isSaving,
  onChange,
  onClose,
  onSubmit,
}: {
  error: string;
  form: ReturnType<typeof emptyShippingForm>;
  isSaving: boolean;
  onChange: (next: ReturnType<typeof emptyShippingForm>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-zinc-950/45 px-4 py-8">
      <form
        className="w-full max-w-xl rounded-xl bg-white p-5 shadow-panel"
        onSubmit={onSubmit}
      >
        <div className="flex justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-600">
              Kargo
            </p>
            <h2 className="text-xl font-bold">Takip bilgisi</h2>
          </div>
          <Button onClick={onClose} type="button" variant="ghost">
            Kapat
          </Button>
        </div>
        <div className="mt-5 grid gap-4">
          <TextField
            id="shippingCompany"
            label="Kargo firması"
            onChange={(value) => onChange({ ...form, shippingCompany: value })}
            value={form.shippingCompany}
          />
          <TextField
            id="trackingNumber"
            label="Takip numarası"
            onChange={(value) => onChange({ ...form, trackingNumber: value })}
            value={form.trackingNumber}
          />
          <TextField
            id="trackingUrl"
            label="Takip linki"
            onChange={(value) => onChange({ ...form, trackingUrl: value })}
            type="url"
            value={form.trackingUrl}
          />
          <TextField
            id="shippedAt"
            label="Gönderim tarihi"
            onChange={(value) => onChange({ ...form, shippedAt: value })}
            type="datetime-local"
            value={form.shippedAt}
          />
          {error ? <InlineError message={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} type="button" variant="outline">
              Vazgeç
            </Button>
            <Button disabled={isSaving} type="submit" variant="mint">
              {isSaving ? "Kaydediliyor" : "Kaydet"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function TextField({
  id,
  label,
  onChange,
  type = "text",
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  type?: string;
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        className="focus-ring h-10 rounded-lg border border-line px-3 text-sm"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-zinc-50 px-3 py-3">
      <p className="text-xs font-semibold uppercase text-zinc-600">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}
