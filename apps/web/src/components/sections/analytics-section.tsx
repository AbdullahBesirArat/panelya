"use client";

import { MetricGrid } from "@/components/page-kit";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  EmptyText,
  Panel,
  SectionError,
  SectionLoading,
  formatCount,
  formatCurrency,
  formatPercent,
  orderStatusLabels,
  useSummaryQuery,
} from "@/components/operations-shared";

export function AnalyticsSection({ organizationSlug }: { organizationSlug: string }) {
  const summaryQuery = useSummaryQuery(organizationSlug);

  if (summaryQuery.isLoading) return <SectionLoading />;
  if (summaryQuery.isError || !summaryQuery.data) {
    return <SectionError message="Analitik verisi yuklenemedi." onRetry={() => void summaryQuery.refetch()} />;
  }

  const summary = summaryQuery.data;
  const averageOrderValue = summary.metrics.order_count > 0
    ? Number(summary.metrics.gross_revenue) / summary.metrics.order_count
    : 0;
  const repeatRate = summary.metrics.customer_count > 0
    ? summary.metrics.repeat_customers / summary.metrics.customer_count
    : 0;

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Toplam gelir", value: formatCurrency(summary.metrics.gross_revenue), tone: "mint" },
          { label: "Aylik gelir", value: formatCurrency(summary.metrics.month_revenue), tone: "leaf" },
          { label: "Ortalama siparis", value: formatCurrency(averageOrderValue), tone: "sun" },
          { label: "Tekrar oran", value: formatPercent(repeatRate), tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Siparis durum grafigi" description="Adet ve paylari tek bakista izle">
          <OrderStatusChart rows={summary.orderStatusBreakdown} total={summary.metrics.order_count} />
        </Panel>
        <ActivityPanel
          title="Gelir notlari"
          items={summary.topCustomers.length > 0
            ? summary.topCustomers.map((customer) => `${customer.name} ${formatCurrency(customer.total)} toplam ciro uretti`)
            : summary.recentOrders.map((order) => `${order.order_code} ${formatCurrency(order.total)} tutarinda kaydedildi`)}
        />
      </div>
      <Panel title="Performans dagilimi" description="Siparis durum dagilimi">
        <DataGrid
          columns={["Durum", "Adet", "Pay", "Not"]}
          emptyMessage="Durum dagilimi olusmadi."
          rows={summary.orderStatusBreakdown}
          renderRow={(item) => (
            <tr key={item.status}>
              <DataCell>{orderStatusLabels[item.status]}</DataCell>
              <DataCell>{formatCount(item.count)}</DataCell>
              <DataCell>{formatPercent(summary.metrics.order_count > 0 ? item.count / summary.metrics.order_count : 0)}</DataCell>
              <DataCell>
                {item.status === "payment_pending"
                  ? "Callback akislarini izle"
                  : item.status === "cancelled"
                    ? "Iptal sebeplerini kontrol et"
                    : "Akis dengeli"}
              </DataCell>
            </tr>
          )}
        />
      </Panel>
    </>
  );
}

type OrderStatusBreakdown = {
  status: keyof typeof orderStatusLabels;
  count: number;
};

const statusBarClass: Record<OrderStatusBreakdown["status"], string> = {
  new: "bg-mint",
  payment_pending: "bg-sun",
  processing: "bg-leaf",
  paid: "bg-mint",
  shipped: "bg-leaf",
  delivered: "bg-leaf",
  cancelled: "bg-coral",
};

function OrderStatusChart({
  rows,
  total,
}: {
  rows: OrderStatusBreakdown[];
  total: number;
}) {
  const visibleRows = rows
    .map((item) => ({ ...item, count: Number(item.count || 0) }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count);
  const maxCount = Math.max(1, ...visibleRows.map((item) => item.count));

  if (!visibleRows.length) {
    return <EmptyText>Durum grafigi icin henuz siparis yok.</EmptyText>;
  }

  return (
    <div aria-label="Siparis durum grafigi" className="space-y-4">
      {visibleRows.map((item) => {
        const share = total > 0 ? item.count / total : 0;
        const width = `${Math.max(8, Math.round((item.count / maxCount) * 100))}%`;

        return (
          <div className="grid gap-2 sm:grid-cols-[140px_1fr_96px] sm:items-center" key={item.status}>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-700">{orderStatusLabels[item.status]}</p>
              <p className="text-xs text-zinc-500">{formatPercent(share)}</p>
            </div>
            <div className="h-3 rounded-lg bg-zinc-100">
              <div
                aria-hidden="true"
                className={`h-3 rounded-lg ${statusBarClass[item.status]}`}
                style={{ width }}
              />
            </div>
            <p className="text-sm font-bold text-ink sm:text-right">{formatCount(item.count)}</p>
          </div>
        );
      })}
    </div>
  );
}
