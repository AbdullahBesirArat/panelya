"use client";

import { MetricGrid } from "@/components/page-kit";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
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
        <ActivityPanel
          title="Gelir notlari"
          items={summary.topCustomers.length > 0
            ? summary.topCustomers.map((customer) => `${customer.name} ${formatCurrency(customer.total)} toplam ciro uretti`)
            : summary.recentOrders.map((order) => `${order.order_code} ${formatCurrency(order.total)} tutarinda kaydedildi`)}
        />
      </div>
    </>
  );
}
