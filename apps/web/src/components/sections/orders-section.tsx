"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { MetricGrid } from "@/components/page-kit";
import {
  fetchOrderDetail,
  fetchOrders,
  type ApiOrder,
  type OrderStatus,
  updateOrderShipping,
  updateOrderStatus,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  FieldLabel,
  InlineError,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatCount,
  formatCurrency,
  formatDateTime,
  orderStatusLabels,
  useSummaryQuery,
} from "@/components/operations-shared";
import { useToastStore } from "@/store/toast";

const orderStatusOptions: OrderStatus[] = ["new", "payment_pending", "processing", "paid", "shipped", "delivered", "cancelled"];

function emptyShippingForm() {
  return {
    shippingCompany: "",
    trackingNumber: "",
    trackingUrl: "",
    shippedAt: "",
  };
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
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [statusDrafts, setStatusDrafts] = useState<Record<string, OrderStatus>>({});
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null);
  const [shippingForm, setShippingForm] = useState(emptyShippingForm);
  const debouncedSearch = useDebouncedValue(search);

  const ordersQuery = useQuery({
    queryKey: ["orders", organizationSlug, debouncedSearch, status],
    queryFn: () => fetchOrders({ q: debouncedSearch, status, limit: 50 }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const detailQuery = useQuery({
    queryKey: ["order-detail", organizationSlug, selectedOrderId],
    queryFn: () => fetchOrderDetail(selectedOrderId || ""),
    enabled: Boolean(selectedOrderId),
    staleTime: 15_000,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, nextStatus }: { id: string; nextStatus: OrderStatus }) => updateOrderStatus(id, nextStatus),
    onSuccess: async () => {
      pushToast({
        title: "Sipariş güncellendi",
        description: "Durum bilgisi kaydedildi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orders", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["order-detail", organizationSlug] }),
      ]);
    },
  });

  const shippingMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => updateOrderShipping(id, {
      ...shippingForm,
      shippedAt: shippingForm.shippedAt || null,
    }),
    onSuccess: async () => {
      closeShippingModal();
      pushToast({
        title: "Kargo bilgisi kaydedildi",
        description: "Takip bilgileri siparişe işlendi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orders", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["order-detail", organizationSlug] }),
      ]);
    },
  });

  const canManageOrders = currentRole === "owner" || currentRole === "admin";

  function openShippingModal(order: Pick<ApiOrder, "id" | "shipping_company" | "tracking_number" | "tracking_url" | "shipped_at">) {
    setShippingForm({
      shippingCompany: order.shipping_company || "",
      trackingNumber: order.tracking_number || "",
      trackingUrl: order.tracking_url || "",
      shippedAt: order.shipped_at ? order.shipped_at.slice(0, 16) : "",
    });
    setShippingOrderId(order.id);
  }

  function closeShippingModal() {
    setShippingOrderId(null);
    setShippingForm(emptyShippingForm());
  }

  function handleShippingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shippingOrderId) return;
    shippingMutation.mutate({ id: shippingOrderId });
  }

  if (summaryQuery.isLoading || (ordersQuery.isLoading && !ordersQuery.data)) return <SectionLoading />;
  if (summaryQuery.isError || (ordersQuery.isError && !ordersQuery.data) || !summaryQuery.data || !ordersQuery.data) {
    return (
      <SectionError
        message="Sipariş verisi yüklenemedi."
        onRetry={() => {
          void summaryQuery.refetch();
          void ordersQuery.refetch();
        }}
      />
    );
  }

  const summary = summaryQuery.data;
  const orders = ordersQuery.data;

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Bugün", value: formatCount(summary.metrics.today_orders), tone: "mint" },
          { label: "Ödeme bekliyor", value: formatCount(summary.metrics.pending_orders), tone: "sun" },
          { label: "Kargoda", value: formatCount(summary.metrics.shipped_orders), tone: "leaf" },
          { label: "İptal", value: formatCount(summary.metrics.cancelled_orders), tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Siparişler"
          description="Canlı sipariş akışları"
          actions={(
            <div className="flex flex-wrap gap-2">
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Kod veya müşteri ara"
                value={search}
              />
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setStatus(event.target.value as OrderStatus | "")}
                value={status}
              >
                <option value="">Tüm durumlar</option>
                {orderStatusOptions.map((option) => (
                  <option key={option} value={option}>{orderStatusLabels[option]}</option>
                ))}
              </select>
              {ordersQuery.isFetching ? (
                <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-500">
                  Güncelleniyor
                </span>
              ) : null}
            </div>
          )}
        >
          <DataGrid
            columns={["Kod", "Müşteri", "Tutar", "Kalemler", "Ödeme", "Durum", "Aksiyon"]}
            emptyMessage="Bu filtrelerle sipariş bulunamadı."
            rows={orders}
            renderRow={(order) => renderOrderRow({
              canManageOrders,
              isSavingStatus: statusMutation.isPending && statusMutation.variables?.id === order.id,
              onOpenDetail: setSelectedOrderId,
              onOpenShipping: openShippingModal,
              onSaveStatus: (id, nextStatus) => statusMutation.mutate({ id, nextStatus }),
              order,
              statusDraft: statusDrafts[order.id] || order.status,
              setStatusDrafts,
            })}
          />
          {statusMutation.isError && <InlineError message={statusMutation.error.message} />}
        </Panel>
        <div className="space-y-5">
          <Panel title="Sipariş özeti" description="En yeni hareket">
            <div className="space-y-3">
              {summary.recentOrders.length === 0 ? (
                <p className="text-sm text-zinc-500">Henüz sipariş yok. İlk ödeme denemesi burada görünecek.</p>
              ) : summary.recentOrders.map((order) => (
                <div className="rounded-lg border border-line px-4 py-3" key={order.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{order.order_code}</p>
                      <p className="text-xs text-zinc-500">{order.customer_name || "Misafir"} - {formatDateTime(order.created_at)}</p>
                    </div>
                    <StatusPill tone={order.status === "cancelled" ? "coral" : order.status === "payment_pending" ? "sun" : "leaf"}>
                      {orderStatusLabels[order.status]}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-zinc-600">{formatCurrency(order.total)}</p>
                </div>
              ))}
            </div>
          </Panel>
          <ActivityPanel
            title="Ödeme hareketleri"
            items={summary.recentOrders.length > 0
              ? summary.recentOrders.map((order) => `${order.order_code} ${order.customer_name || "Misafir"} için ${orderStatusLabels[order.status].toLocaleLowerCase("tr-TR")}`)
              : ["Sipariş akışı başladığında hareketler burada görünecek."]}
          />
        </div>
      </div>

      {selectedOrderId ? (
        <OrderDetailModal
          isLoading={detailQuery.isLoading}
          order={detailQuery.data || null}
          onClose={() => setSelectedOrderId(null)}
          onOpenShipping={(order) => {
            setSelectedOrderId(null);
            openShippingModal(order);
          }}
          canManageOrders={canManageOrders}
        />
      ) : null}

      {shippingOrderId ? (
        <ShippingModal
          form={shippingForm}
          isSaving={shippingMutation.isPending}
          onChange={setShippingForm}
          onClose={closeShippingModal}
          onSubmit={handleShippingSubmit}
          error={shippingMutation.error?.message || ""}
        />
      ) : null}
    </>
  );
}

function renderOrderRow({
  canManageOrders,
  isSavingStatus,
  onOpenDetail,
  onOpenShipping,
  onSaveStatus,
  order,
  statusDraft,
  setStatusDrafts,
}: {
  canManageOrders: boolean;
  isSavingStatus: boolean;
  onOpenDetail: (id: string) => void;
  onOpenShipping: (order: Pick<ApiOrder, "id" | "shipping_company" | "tracking_number" | "tracking_url" | "shipped_at">) => void;
  onSaveStatus: (id: string, status: OrderStatus) => void;
  order: ApiOrder;
  statusDraft: OrderStatus;
  setStatusDrafts: Dispatch<SetStateAction<Record<string, OrderStatus>>>;
}) {
  return (
    <tr key={order.id}>
      <DataCell>
        <button className="focus-ring rounded text-left font-semibold text-ink underline-offset-4 hover:underline" onClick={() => onOpenDetail(order.id)} type="button">
          {order.order_code}
        </button>
      </DataCell>
      <DataCell>
        <div className="space-y-1">
          <p className="font-semibold">{order.customer || "Misafir"}</p>
          <p className="text-xs text-zinc-500">{order.email || "-"}</p>
        </div>
      </DataCell>
      <DataCell>{formatCurrency(order.total)}</DataCell>
      <DataCell>
        <div className="space-y-1">
          <p>{order.items}</p>
          {order.note ? <p className="text-xs text-zinc-500">Not: {order.note}</p> : null}
          {order.gift_wrap ? <p className="text-xs font-semibold text-zinc-500">Hediye paketi</p> : null}
        </div>
      </DataCell>
      <DataCell>
        <div className="space-y-1 text-xs text-zinc-500">
          <p className="font-semibold text-ink">{paymentMethodLabel(order.payment_method)}</p>
          {Number(order.shipping_fee || 0) > 0 ? <p>Kargo: {formatCurrency(order.shipping_fee)}</p> : null}
          {order.tracking_number ? <p>Takip: {order.tracking_number}</p> : null}
        </div>
      </DataCell>
      <DataCell>
        <StatusPill tone={order.status === "cancelled" ? "coral" : order.status === "payment_pending" ? "sun" : "mint"}>
          {orderStatusLabels[order.status]}
        </StatusPill>
      </DataCell>
      <DataCell>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onOpenDetail(order.id)} size="sm" type="button" variant="outline">Detay</Button>
          {canManageOrders ? (
            <>
              <Button onClick={() => onOpenShipping(order)} size="sm" type="button" variant="outline">Kargo</Button>
              <select
                className="focus-ring h-9 min-w-36 rounded-lg border border-line bg-white px-2 text-xs"
                onChange={(event) => setStatusDrafts((current) => ({ ...current, [order.id]: event.target.value as OrderStatus }))}
                value={statusDraft}
              >
                {orderStatusOptions.map((option) => (
                  <option key={option} value={option}>{orderStatusLabels[option]}</option>
                ))}
              </select>
              <Button
                disabled={statusDraft === order.status || isSavingStatus}
                onClick={() => onSaveStatus(order.id, statusDraft)}
                size="sm"
                type="button"
                variant="outline"
              >
                {isSavingStatus ? "Kaydediliyor" : "Kaydet"}
              </Button>
            </>
          ) : (
            <span className="text-xs text-zinc-400">Salt okunur</span>
          )}
        </div>
      </DataCell>
    </tr>
  );
}

function OrderDetailModal({
  canManageOrders,
  isLoading,
  order,
  onClose,
  onOpenShipping,
}: {
  canManageOrders: boolean;
  isLoading: boolean;
  order: Awaited<ReturnType<typeof fetchOrderDetail>> | null;
  onClose: () => void;
  onOpenShipping: (order: Pick<ApiOrder, "id" | "shipping_company" | "tracking_number" | "tracking_url" | "shipped_at">) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 px-4 py-8">
      <section className="w-full max-w-4xl rounded-lg bg-white p-5 shadow-panel">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500">Sipariş detayı</p>
            <h2 className="mt-1 text-xl font-bold">{order?.order_code || "Yükleniyor"}</h2>
          </div>
          <Button onClick={onClose} type="button" variant="ghost">Kapat</Button>
        </div>

        {isLoading || !order ? (
          <p className="mt-5 text-sm text-zinc-500">Sipariş bilgileri yükleniyor.</p>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="grid gap-3 md:grid-cols-4">
              <InfoBox label="Durum" value={orderStatusLabels[order.status]} />
              <InfoBox label="Toplam" value={formatCurrency(order.total)} />
              <InfoBox label="Ödeme" value={paymentMethodLabel(order.payment_method)} />
              <InfoBox label="Tarih" value={formatDateTime(order.created_at)} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-line p-4">
                <h3 className="text-sm font-bold">Müşteri</h3>
                <div className="mt-3 space-y-1 text-sm text-zinc-600">
                  <p className="font-semibold text-ink">{order.customer.name || "Misafir"}</p>
                  <p>{order.customer.email || "-"}</p>
                  <p>{order.customer.phone || "-"}</p>
                  <p>{order.customer.address || "-"}</p>
                </div>
              </div>
              <div className="rounded-lg border border-line p-4">
                <h3 className="text-sm font-bold">Kargo</h3>
                <div className="mt-3 space-y-1 text-sm text-zinc-600">
                  <p>Firma: {order.shipping_company || "-"}</p>
                  <p>Takip no: {order.tracking_number || "-"}</p>
                  <p>Gönderim: {formatDateTime(order.shipped_at)}</p>
                  {order.tracking_url ? <a className="font-semibold text-ink underline" href={order.tracking_url} rel="noreferrer" target="_blank">Takip linki</a> : null}
                </div>
                {canManageOrders ? (
                  <Button className="mt-4" onClick={() => onOpenShipping(order)} size="sm" type="button" variant="outline">Kargo bilgisi düzenle</Button>
                ) : null}
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Ürün</th>
                    <th className="px-4 py-3 font-semibold">Adet</th>
                    <th className="px-4 py-3 font-semibold">Birim</th>
                    <th className="px-4 py-3 font-semibold">Toplam</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {order.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-3 font-semibold text-ink">{item.name}</td>
                      <td className="px-4 py-3 text-zinc-600">{formatCount(item.quantity)}</td>
                      <td className="px-4 py-3 text-zinc-600">{formatCurrency(item.unit_price)}</td>
                      <td className="px-4 py-3 text-zinc-600">{formatCurrency(item.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 px-4 py-8">
      <form className="w-full max-w-xl rounded-lg bg-white p-5 shadow-panel" onSubmit={onSubmit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500">Kargo</p>
            <h2 className="mt-1 text-xl font-bold">Takip bilgisi</h2>
          </div>
          <Button onClick={onClose} type="button" variant="ghost">Kapat</Button>
        </div>
        <div className="mt-5 grid gap-4">
          <div className="grid gap-2">
            <FieldLabel htmlFor="shippingCompany">Kargo firması</FieldLabel>
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              id="shippingCompany"
              onChange={(event) => onChange({ ...form, shippingCompany: event.target.value })}
              value={form.shippingCompany}
            />
          </div>
          <div className="grid gap-2">
            <FieldLabel htmlFor="trackingNumber">Takip numarası</FieldLabel>
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              id="trackingNumber"
              onChange={(event) => onChange({ ...form, trackingNumber: event.target.value })}
              value={form.trackingNumber}
            />
          </div>
          <div className="grid gap-2">
            <FieldLabel htmlFor="trackingUrl">Takip linki</FieldLabel>
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              id="trackingUrl"
              onChange={(event) => onChange({ ...form, trackingUrl: event.target.value })}
              type="url"
              value={form.trackingUrl}
            />
          </div>
          <div className="grid gap-2">
            <FieldLabel htmlFor="shippedAt">Gönderim tarihi</FieldLabel>
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              id="shippedAt"
              onChange={(event) => onChange({ ...form, shippedAt: event.target.value })}
              type="datetime-local"
              value={form.shippedAt}
            />
          </div>
          {error ? <InlineError message={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} type="button" variant="outline">Vazgeç</Button>
            <Button disabled={isSaving} type="submit" variant="mint">{isSaving ? "Kaydediliyor" : "Kaydet"}</Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-zinc-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase text-zinc-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function paymentMethodLabel(method: string | null | undefined) {
  if (method === "iban") return "IBAN";
  return "Kart";
}
