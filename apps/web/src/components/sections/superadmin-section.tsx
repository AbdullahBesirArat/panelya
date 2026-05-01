"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import {
  DataCell,
  DataGrid,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatCount,
  formatCurrency,
  formatDateTime,
  orderStatusLabels,
} from "@/components/operations-shared";
import { fetchSuperAdminOverview, type SuperAdminOverview } from "@/lib/api";
import { displayBrandName } from "@/lib/branding";

export function SuperAdminSection() {
  const [search, setSearch] = useState("");
  const overviewQuery = useQuery({
    queryKey: ["superadmin-overview"],
    queryFn: fetchSuperAdminOverview,
    staleTime: 20_000,
  });

  const shops = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("tr-TR");
    const list = overviewQuery.data?.shops || [];
    if (!query) return list;

    return list.filter((shop) => [
      shop.name,
      shop.slug,
      shop.owners,
      shop.owner_emails,
      shop.plan,
      shop.status,
    ].some((value) => String(value || "").toLocaleLowerCase("tr-TR").includes(query)));
  }, [overviewQuery.data?.shops, search]);

  if (overviewQuery.isLoading) return <SectionLoading />;
  if (overviewQuery.isError || !overviewQuery.data) {
    return <SectionError message="Superadmin verisi yuklenemedi." onRetry={() => void overviewQuery.refetch()} />;
  }

  const overview = overviewQuery.data;

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Kayitli dukkan", value: formatCount(overview.metrics.shop_count), tone: "mint" },
          { label: "Canli dukkan", value: formatCount(overview.metrics.live_shop_count), tone: "leaf" },
          { label: "Bu ay siparis", value: formatCount(overview.metrics.month_orders), tone: "sun" },
          { label: "Bu ay ciro", value: formatCurrency(overview.metrics.month_revenue), tone: "coral" },
        ]}
      />

      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <Panel
          title="Dukkanlar"
          description="Tum tenant bilgileri ve siparis ozeti"
          actions={(
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Dukkan, sahip, slug ara"
              value={search}
            />
          )}
        >
          <DataGrid
            columns={["Dukkan", "Sahip", "Plan", "Siparis", "Ciro", "Durum", "Son siparis"]}
            emptyMessage="Bu aramaya uygun dukkan yok."
            rows={shops}
            renderRow={(shop) => <ShopRow key={shop.id} shop={shop} />}
          />
        </Panel>

        <Panel title="Son siparisler" description="Platform genelinde en yeni hareketler">
          <div className="space-y-3">
            {overview.recentOrders.length === 0 ? (
              <p className="text-sm text-zinc-500">Henuz siparis yok.</p>
            ) : overview.recentOrders.map((order) => (
              <div className="rounded-lg border border-line px-4 py-3" key={order.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{order.order_code}</p>
                    <p className="text-xs text-zinc-500">
                      {displayBrandName(order.organization_name)} / {order.customer_name || "Misafir"}
                    </p>
                  </div>
                  <StatusPill tone={order.status === "cancelled" ? "coral" : order.status === "payment_pending" ? "sun" : "leaf"}>
                    {orderStatusLabels[order.status]}
                  </StatusPill>
                </div>
                <p className="mt-2 text-sm text-zinc-600">{formatCurrency(order.total)} - {formatDateTime(order.created_at)}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Platform ozeti" description="Dukkanlarin siparis ve operasyon hacmi">
        <div className="grid gap-3 md:grid-cols-4">
          <InfoBox label="Toplam siparis" value={formatCount(overview.metrics.order_count)} />
          <InfoBox label="Bugun siparis" value={formatCount(overview.metrics.today_orders)} />
          <InfoBox label="Toplam ciro" value={formatCurrency(overview.metrics.gross_revenue)} />
          <InfoBox label="Askidaki dukkan" value={formatCount(overview.metrics.suspended_shop_count)} />
        </div>
      </Panel>
    </>
  );
}

function ShopRow({ shop }: { shop: SuperAdminOverview["shops"][number] }) {
  return (
    <tr>
      <DataCell>
        <div className="space-y-1">
          <p className="font-semibold text-ink">{displayBrandName(shop.name)}</p>
          <p className="font-mono text-xs text-zinc-500">{shop.slug}</p>
          <p className="text-xs text-zinc-500">{formatDateTime(shop.created_at)}</p>
        </div>
      </DataCell>
      <DataCell>
        <div className="space-y-1">
          <p>{shop.owners || "-"}</p>
          <p className="text-xs text-zinc-500">{shop.owner_emails || "-"}</p>
        </div>
      </DataCell>
      <DataCell>
        <div className="space-y-1">
          <StatusPill tone="mint">{shop.plan}</StatusPill>
          <p className="text-xs text-zinc-500">{formatCount(shop.product_count)} urun / {formatCount(shop.customer_count)} musteri</p>
        </div>
      </DataCell>
      <DataCell>
        <div className="space-y-1 text-sm">
          <p className="font-semibold text-ink">{formatCount(shop.order_count)} toplam</p>
          <p className="text-xs text-zinc-500">{formatCount(shop.today_orders)} bugun / {formatCount(shop.month_orders)} bu ay</p>
          <p className="text-xs text-zinc-500">{formatCount(shop.pending_orders)} odeme bekliyor</p>
        </div>
      </DataCell>
      <DataCell>
        <div className="space-y-1">
          <p className="font-semibold text-ink">{formatCurrency(shop.gross_revenue)}</p>
          <p className="text-xs text-zinc-500">Bu ay {formatCurrency(shop.month_revenue)}</p>
        </div>
      </DataCell>
      <DataCell>
        <StatusPill tone={shop.status === "suspended" || shop.status === "cancelled" ? "coral" : "leaf"}>
          {shop.status}
        </StatusPill>
      </DataCell>
      <DataCell>{formatDateTime(shop.last_order_at)}</DataCell>
    </tr>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-zinc-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase text-zinc-500">{label}</p>
      <p className="mt-2 text-lg font-bold text-ink">{value}</p>
    </div>
  );
}
