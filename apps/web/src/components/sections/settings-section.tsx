"use client";

import { MetricGrid } from "@/components/page-kit";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  Panel,
  SectionError,
  SectionLoading,
  describeActivity,
  formatCount,
  formatDateTime,
  uppercaseFirst,
  useSummaryQuery,
} from "@/components/operations-shared";
import { useSessionStore } from "@/store/session";

export function SettingsSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const summaryQuery = useSummaryQuery(organizationSlug);
  const user = useSessionStore((state) => state.user);

  if (summaryQuery.isLoading) return <SectionLoading />;
  if (summaryQuery.isError || !summaryQuery.data) {
    return <SectionError message="Workspace bilgisi yuklenemedi." onRetry={() => void summaryQuery.refetch()} />;
  }

  const summary = summaryQuery.data;
  const tableRows = [
    { label: "Workspace", value: summary.organization.name, status: summary.organization.status, update: formatDateTime(summary.organization.created_at) },
    { label: "Plan", value: summary.subscription?.plan || summary.organization.plan, status: summary.subscription?.status || summary.organization.status, update: summary.subscription?.updated_at ? formatDateTime(summary.subscription.updated_at) : "-" },
    { label: "Provider", value: summary.subscription?.provider || "manual", status: summary.subscription?.cancel_at_period_end ? "Donem sonunda kapanacak" : "Aktif", update: summary.subscription?.current_period_end ? formatDateTime(summary.subscription.current_period_end) : "-" },
    { label: "Rol", value: currentRole, status: user?.email || "-", update: "Canli oturum" },
  ];

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Ekip", value: formatCount(summary.metrics.active_members), tone: "mint" },
          { label: "Plan", value: uppercaseFirst(summary.subscription?.plan || summary.organization.plan), tone: "leaf" },
          { label: "Durum", value: uppercaseFirst(summary.subscription?.status || summary.organization.status), tone: "sun" },
          { label: "Workspace", value: summary.organization.slug, tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Workspace ozeti" description="Plan, abonelik ve erisim">
          <DataGrid
            columns={["Alan", "Deger", "Durum", "Guncelleme"]}
            emptyMessage="Workspace bilgisi bulunamadi."
            rows={tableRows}
            renderRow={(row) => (
              <tr key={row.label}>
                <DataCell>{row.label}</DataCell>
                <DataCell>{row.value}</DataCell>
                <DataCell>{row.status}</DataCell>
                <DataCell>{row.update}</DataCell>
              </tr>
            )}
          />
        </Panel>
        <ActivityPanel
          title="Workspace hareketleri"
          items={summary.recentActivity.length > 0
            ? summary.recentActivity.map(describeActivity)
            : ["Workspace hareketleri burada listelenecek."]}
        />
      </div>
    </>
  );
}
