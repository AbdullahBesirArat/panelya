"use client";

import { MetricGrid } from "@/components/page-kit";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  describeActivity,
  formatCount,
  formatCurrency,
  useSummaryQuery,
} from "@/components/operations-shared";

export function DashboardSection({ organizationSlug }: { organizationSlug: string }) {
  const summaryQuery = useSummaryQuery(organizationSlug);

  if (summaryQuery.isLoading) return <SectionLoading />;
  if (summaryQuery.isError || !summaryQuery.data) {
    return <SectionError message="Dashboard verisi yuklenemedi." onRetry={() => void summaryQuery.refetch()} />;
  }

  const summary = summaryQuery.data;

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Aylik gelir", value: formatCurrency(summary.metrics.month_revenue), tone: "mint" },
          { label: "Bugun siparis", value: formatCount(summary.metrics.today_orders), tone: "coral" },
          { label: "Musteri", value: formatCount(summary.metrics.customer_count), tone: "leaf" },
          { label: "Stok uyarisi", value: formatCount(summary.metrics.low_stock_products), tone: "sun" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Oncelikli isler" description="Dusuk stok ve son siparisler">
          <DataGrid
            columns={["Urun", "Kategori", "Stok", "Durum"]}
            emptyMessage="Kritik stok uyarisi yok."
            rows={summary.lowStockProducts}
            renderRow={(product) => (
              <tr key={product.id}>
                <DataCell>{product.name}</DataCell>
                <DataCell>{product.category_name || "Kategorisiz"}</DataCell>
                <DataCell>{formatCount(product.stock)}</DataCell>
                <DataCell>
                  <StatusPill tone={product.stock === 0 ? "coral" : "sun"}>
                    {product.stock === 0 ? "Kritik" : "Takipte"}
                  </StatusPill>
                </DataCell>
              </tr>
            )}
          />
        </Panel>
        <ActivityPanel
          title="Son hareketler"
          items={summary.recentActivity.length > 0
            ? summary.recentActivity.map(describeActivity)
            : summary.recentOrders.map((order) => `${order.order_code} ${order.customer_name || "Misafir"} icin olusturuldu`)}
        />
      </div>
    </>
  );
}
