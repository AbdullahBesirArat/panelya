"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import { fetchOrders, type OrderStatus, updateOrderStatus } from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
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
  const debouncedSearch = useDebouncedValue(search);

  const ordersQuery = useQuery({
    queryKey: ["orders", organizationSlug, debouncedSearch, status],
    queryFn: () => fetchOrders({ q: debouncedSearch, status, limit: 50 }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, nextStatus }: { id: string; nextStatus: OrderStatus }) => updateOrderStatus(id, nextStatus),
    onSuccess: async () => {
      pushToast({
        title: "Siparis guncellendi",
        description: "Durum bilgisi kaydedildi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orders", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const canManageOrders = currentRole === "owner" || currentRole === "admin";

  if (summaryQuery.isLoading || (ordersQuery.isLoading && !ordersQuery.data)) return <SectionLoading />;
  if (summaryQuery.isError || (ordersQuery.isError && !ordersQuery.data) || !summaryQuery.data || !ordersQuery.data) {
    return (
      <SectionError
        message="Siparis verisi yuklenemedi."
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
          { label: "Bugun", value: formatCount(summary.metrics.today_orders), tone: "mint" },
          { label: "Odeme bekliyor", value: formatCount(summary.metrics.pending_orders), tone: "sun" },
          { label: "Kargoda", value: formatCount(summary.metrics.shipped_orders), tone: "leaf" },
          { label: "Iptal", value: formatCount(summary.metrics.cancelled_orders), tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Siparisler"
          description="Canli siparis akislari"
          actions={(
            <div className="flex flex-wrap gap-2">
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Kod veya musteri ara"
                value={search}
              />
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setStatus(event.target.value as OrderStatus | "")}
                value={status}
              >
                <option value="">Tum durumlar</option>
                {orderStatusOptions.map((option) => (
                  <option key={option} value={option}>{orderStatusLabels[option]}</option>
                ))}
              </select>
              {ordersQuery.isFetching ? (
                <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-500">
                  Guncelleniyor
                </span>
              ) : null}
            </div>
          )}
        >
          <DataGrid
            columns={["Kod", "Musteri", "Tutar", "Kalemler", "Durum", "Aksiyon"]}
            emptyMessage="Bu filtrelerle siparis bulunamadi."
            rows={orders}
            renderRow={(order) => {
              const draft = statusDrafts[order.id] || order.status;
              const isSaving = statusMutation.isPending && statusMutation.variables?.id === order.id;

              return (
                <tr key={order.id}>
                  <DataCell>{order.order_code}</DataCell>
                  <DataCell>
                    <div className="space-y-1">
                      <p className="font-semibold">{order.customer || "Misafir"}</p>
                      <p className="text-xs text-zinc-500">{order.email || "-"}</p>
                    </div>
                  </DataCell>
                  <DataCell>{formatCurrency(order.total)}</DataCell>
                  <DataCell>{order.items}</DataCell>
                  <DataCell>
                    <StatusPill tone={order.status === "cancelled" ? "coral" : order.status === "payment_pending" ? "sun" : "mint"}>
                      {orderStatusLabels[order.status]}
                    </StatusPill>
                  </DataCell>
                  <DataCell>
                    {canManageOrders ? (
                      <div className="flex flex-wrap gap-2">
                        <select
                          className="focus-ring h-9 min-w-36 rounded-lg border border-line bg-white px-2 text-xs"
                          onChange={(event) => setStatusDrafts((current) => ({ ...current, [order.id]: event.target.value as OrderStatus }))}
                          value={draft}
                        >
                          {orderStatusOptions.map((option) => (
                            <option key={option} value={option}>{orderStatusLabels[option]}</option>
                          ))}
                        </select>
                        <button
                          className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold"
                          disabled={draft === order.status || isSaving}
                          onClick={() => statusMutation.mutate({ id: order.id, nextStatus: draft })}
                          type="button"
                        >
                          {isSaving ? "Kaydediliyor" : "Kaydet"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400">Salt okunur</span>
                    )}
                  </DataCell>
                </tr>
              );
            }}
          />
          {statusMutation.isError && <InlineError message={statusMutation.error.message} />}
        </Panel>
        <div className="space-y-5">
          <Panel title="Siparis ozeti" description="En yeni hareket">
            <div className="space-y-3">
              {summary.recentOrders.length === 0 ? (
                <p className="text-sm text-zinc-500">No orders yet. Ilk odeme denemesi burada gorunecek.</p>
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
            title="Odeme hareketleri"
            items={summary.recentOrders.length > 0
              ? summary.recentOrders.map((order) => `${order.order_code} ${order.customer_name || "Misafir"} icin ${orderStatusLabels[order.status].toLocaleLowerCase("tr-TR")}`)
              : ["Siparis akisi basladiginda hareketler burada gorunecek."]}
          />
        </div>
      </div>
    </>
  );
}
