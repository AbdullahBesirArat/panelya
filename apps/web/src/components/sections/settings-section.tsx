"use client";

import { API_BASE } from "@/lib/api";
import { MetricGrid } from "@/components/page-kit";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  InlineHint,
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
  const organizations = useSessionStore((state) => state.organizations);

  if (summaryQuery.isLoading) return <SectionLoading />;
  if (summaryQuery.isError || !summaryQuery.data) {
    return <SectionError message="Mağaza bilgisi yüklenemedi." onRetry={() => void summaryQuery.refetch()} />;
  }

  const summary = summaryQuery.data;
  const currentOrganization = organizations.find((organization) => organization.slug === organizationSlug);
  const publicAccessToken = currentOrganization?.publicAccessToken || "-";
  const storefrontSnippet = [
    `window.SUVERA_API_BASE = "${API_BASE}";`,
    `window.SUVERA_ORGANIZATION_SLUG = "${summary.organization.slug}";`,
    `window.SUVERA_PUBLIC_ACCESS_TOKEN = "${publicAccessToken === "-" ? "PUBLIC_ACCESS_TOKEN" : publicAccessToken}";`,
  ].join("\n");
  const tableRows = [
    { label: "Mağaza", value: summary.organization.name, status: summary.organization.status, update: formatDateTime(summary.organization.created_at) },
    { label: "Plan", value: summary.subscription?.plan || summary.organization.plan, status: summary.subscription?.status || summary.organization.status, update: summary.subscription?.updated_at ? formatDateTime(summary.subscription.updated_at) : "-" },
    { label: "Ödeme sağlayıcı", value: providerLabel(summary.subscription?.provider), status: summary.subscription?.cancel_at_period_end ? "Dönem sonunda kapanacak" : "Aktif", update: summary.subscription?.current_period_end ? formatDateTime(summary.subscription.current_period_end) : "-" },
    { label: "Rol", value: roleLabel(currentRole), status: user?.email || "-", update: "Canlı oturum" },
  ];

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Ekip", value: formatCount(summary.metrics.active_members), tone: "mint" },
          { label: "Plan", value: uppercaseFirst(summary.subscription?.plan || summary.organization.plan), tone: "leaf" },
          { label: "Durum", value: uppercaseFirst(summary.subscription?.status || summary.organization.status), tone: "sun" },
          { label: "Mağaza", value: summary.organization.slug, tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Mağaza özeti" description="Plan, abonelik ve erişim">
          <DataGrid
            columns={["Alan", "Değer", "Durum", "Güncelleme"]}
            emptyMessage="Mağaza bilgisi bulunamadı."
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
          title="Mağaza hareketleri"
          items={summary.recentActivity.length > 0
            ? summary.recentActivity.map(describeActivity)
            : ["Mağaza hareketleri burada listelenecek."]}
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <Panel
          title="Vitrin entegrasyonu"
          description="Türkiye mağaza vitrini için gerekli bağlantı bilgileri"
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-line bg-white px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">API Adresi</p>
                <p className="mt-2 break-all text-sm font-semibold text-ink">{API_BASE}</p>
              </div>
              <div className="rounded-lg border border-line bg-white px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Mağaza Kısa Adı</p>
                <p className="mt-2 break-all text-sm font-semibold text-ink">{summary.organization.slug}</p>
              </div>
              <div className="rounded-lg border border-line bg-white px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Genel Erişim Anahtarı</p>
                <p className="mt-2 break-all text-sm font-semibold text-ink">{publicAccessToken}</p>
              </div>
            </div>
            <div className="rounded-xl border border-line bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono">{storefrontSnippet}</pre>
            </div>
            <InlineHint>
              `organizationSlug` herkese açık katalog isteklerinde, `publicAccessToken` ise sipariş ve ödeme başlatma
              isteklerinde gönderilmelidir.
            </InlineHint>
          </div>
        </Panel>
        <ActivityPanel
          title="Entegrasyon notları"
          items={[
            "Ürün kartları ve detay sayfası için görsel, renk, beden ve detay alanlarını doldurun.",
            "Slayt ve kampanya içerikleri ana sayfa vitriniyle birebir eşleşecek şekilde yönetilebilir.",
            "Vitrin ödeme akışı /api/payment/initialize ve ödeme dönüş URL'leriyle çalışmalıdır.",
          ]}
        />
      </div>
    </>
  );
}

function providerLabel(provider: string | null | undefined) {
  if (!provider || provider === "manual") return "Manuel";
  if (provider === "iyzico") return "iyzico";
  return provider;
}

function roleLabel(role: string) {
  switch (role) {
    case "owner":
      return "Sahip";
    case "admin":
      return "Yönetici";
    case "member":
      return "Ekip Üyesi";
    case "viewer":
      return "Salt Okur";
    default:
      return role;
  }
}
