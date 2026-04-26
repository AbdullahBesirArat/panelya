"use client";

import { MetricGrid } from "@/components/page-kit";
import { OrderStatusChart } from "@/components/charts/OrderStatusChart";
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
    return <SectionError message="Rapor verisi yüklenemedi." onRetry={() => void summaryQuery.refetch()} />;
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
          { label: "Toplam ciro", value: formatCurrency(summary.metrics.gross_revenue), tone: "mint" },
          { label: "Aylık ciro", value: formatCurrency(summary.metrics.month_revenue), tone: "leaf" },
          { label: "Ortalama sipariş", value: formatCurrency(averageOrderValue), tone: "sun" },
          { label: "Tekrar oranı", value: formatPercent(repeatRate), tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Sipariş durum grafiği" description="Adet ve payları tek bakışta izle">
          <OrderStatusChart data={summary.orderStatusBreakdown} />
        </Panel>
        <ActivityPanel
          title="Ciro notları"
          items={summary.topCustomers.length > 0
            ? summary.topCustomers.map((customer) => `${customer.name} ${formatCurrency(customer.total)} toplam ciro üretti`)
            : summary.recentOrders.map((order) => `${order.order_code} ${formatCurrency(order.total)} tutarında kaydedildi`)}
        />
      </div>
      <Panel title="Performans dağılımı" description="Sipariş durum dağılımı">
        <DataGrid
          columns={["Durum", "Adet", "Pay", "Not"]}
          emptyMessage="Durum dağılımı oluşmadı."
          rows={summary.orderStatusBreakdown}
          renderRow={(item) => (
            <tr key={item.status}>
              <DataCell>{orderStatusLabels[item.status]}</DataCell>
              <DataCell>{formatCount(item.count)}</DataCell>
              <DataCell>{formatPercent(summary.metrics.order_count > 0 ? item.count / summary.metrics.order_count : 0)}</DataCell>
              <DataCell>
                {item.status === "payment_pending"
                  ? "Ödeme dönüş akışlarını izle"
                  : item.status === "cancelled"
                    ? "İptal sebeplerini kontrol et"
                    : "Akış dengeli"}
              </DataCell>
            </tr>
          )}
        />
      </Panel>
    </>
  );
}
