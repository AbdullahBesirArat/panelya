"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import { fetchCustomers } from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
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
  useSummaryQuery,
} from "@/components/operations-shared";

export function CustomersSection({ organizationSlug }: { organizationSlug: string }) {
  const summaryQuery = useSummaryQuery(organizationSlug);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);

  const customersQuery = useQuery({
    queryKey: ["customers", organizationSlug, debouncedSearch],
    queryFn: () => fetchCustomers({ q: debouncedSearch, limit: 50 }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  if (summaryQuery.isLoading || (customersQuery.isLoading && !customersQuery.data)) return <SectionLoading />;
  if (summaryQuery.isError || (customersQuery.isError && !customersQuery.data) || !summaryQuery.data || !customersQuery.data) {
    return (
      <SectionError
        message="Musteri verisi yuklenemedi."
        onRetry={() => {
          void summaryQuery.refetch();
          void customersQuery.refetch();
        }}
      />
    );
  }

  const summary = summaryQuery.data;
  const customers = customersQuery.data;
  const repeatRate = summary.metrics.customer_count > 0
    ? summary.metrics.repeat_customers / summary.metrics.customer_count
    : 0;
  const topCustomer = summary.topCustomers[0];

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Toplam", value: formatCount(summary.metrics.customer_count), tone: "mint" },
          { label: "Tekrar alisveris", value: formatPercent(repeatRate), tone: "leaf" },
          { label: "Bu ay yeni", value: formatCount(summary.metrics.new_customers_this_month), tone: "sun" },
          { label: "En yuksek musteri", value: topCustomer ? formatCurrency(topCustomer.total) : formatCurrency(0), tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Musteriler"
          description="Siparis ve toplam harcama"
          actions={(
            <div className="flex flex-wrap gap-2">
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Isim, e-posta veya telefon ara"
                value={search}
              />
              {customersQuery.isFetching ? (
                <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-500">
                  Guncelleniyor
                </span>
              ) : null}
            </div>
          )}
        >
          <DataGrid
            columns={["Ad", "E-posta", "Siparis", "Toplam"]}
            emptyMessage="Musteri bulunamadi."
            rows={customers}
            renderRow={(customer) => (
              <tr key={customer.id}>
                <DataCell>{customer.name}</DataCell>
                <DataCell>{customer.email || "-"}</DataCell>
                <DataCell>{formatCount(customer.orders)}</DataCell>
                <DataCell>{formatCurrency(customer.total)}</DataCell>
              </tr>
            )}
          />
        </Panel>
        <ActivityPanel
          title="Musteri hareketleri"
          items={summary.topCustomers.length > 0
            ? summary.topCustomers.map((customer) => `${customer.name} ${formatCount(customer.orders)} siparis ile ${formatCurrency(customer.total)}`)
            : ["Musteri hareketleri henuz olusmadi."]}
        />
      </div>
    </>
  );
}
